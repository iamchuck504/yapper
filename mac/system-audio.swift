// Captures what the Mac is playing — the other side of a call — and writes it
// to stdout as 16 kHz mono 16-bit PCM: exactly the format the rest of the app
// already moves around, so main.js can mix it into the microphone stream
// sample for sample without resampling anything.
//
// Windows gets this from Electron's loopback. macOS has no loopback, so there
// are two doors, and which one is used decides what the app has to ask the
// user for:
//
//   Core Audio process taps (macOS 14.4+) — the audio door. Asks for "System
//     Audio Recording Only", a permission that does what its name says.
//   ScreenCaptureKit (macOS 13+) — the screen door. Asks for Screen Recording,
//     a permission wide enough to read the display, in order to get audio.
//
// The tap is tried first for exactly that reason. ScreenCaptureKit stays as
// the fallback for macOS 13 and for any machine where the tap will not open,
// because half a conversation is worse than an awkward permission.
//
// Exit codes matter to the caller: 2 means the permission is missing, which is
// recoverable (record the microphone alone and say so). Anything else is a
// real failure. With two doors there are two permissions, so a "permission:
// audio" or "permission: screen" line goes to stderr before exiting 2 — the
// app has to send the user to the pane that actually holds the switch, and
// they are not the same pane.
//
// Built by mac/build-app.sh into build/system-audio:
//   swiftc -O -target arm64-apple-macos13.0 mac/system-audio.swift -o build/system-audio

import AVFoundation
import CoreAudio
import ScreenCaptureKit
import CoreGraphics
import os

let SAMPLE_RATE = 16000.0

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(code)
}

func note(_ message: String) {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
}

/// stdout, written from one place. Both capture paths hand samples here rather
/// than writing from their own audio callback: a pipe the parent is slow to
/// drain would otherwise block a realtime thread and pit the audio.
// All mutable work is serialized by `queue`; callers only enqueue immutable
// Data values or wait for that queue to drain.
final class Sink: @unchecked Sendable {
  private let queue = DispatchQueue(label: "yapper.sysaudio.out")
  private let out = FileHandle.standardOutput
  func write(_ data: Data) {
    queue.async { [out] in out.write(data) }
  }
  /// Block until everything handed over so far has actually been written.
  func drain() {
    queue.sync { }
  }
}

nonisolated let sink = Sink()

// ---------------------------------------------------------------- the tap

/// System audio through a Core Audio process tap: everything the machine plays
/// except this app's own output, which would otherwise feed back the moment
/// anything is played through it.
@available(macOS 14.4, *)
final class TapCapture {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private let outputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: SAMPLE_RATE, channels: 1, interleaved: true)!

  /// Throws rather than exiting: the caller falls back to ScreenCaptureKit.
  /// Nothing is left behind on the way out — a tap created before the
  /// aggregate device failed used to leak for the life of the helper, and on
  /// the second attempt (the watch putting the tap back) it would leak again.
  func start() throws {
    signalLock.withLock { $0 = false }
    do { try attemptStart() } catch { stop(); throw error }
  }

  private func attemptStart() throws {
    let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
    desc.isPrivate = true          // not offered to other apps as a device
    desc.muteBehavior = .unmuted   // the user keeps hearing the call

    var err = AudioHardwareCreateProcessTap(desc, &tapID)
    guard err == noErr else { throw TapError.create("tap", err) }

    // A tap is not readable on its own; it has to sit inside an aggregate
    // device, which is what an IOProc can be attached to.
    let aggDesc: [String: Any] = [
      kAudioAggregateDeviceNameKey as String: "Yapper System Audio",
      kAudioAggregateDeviceUIDKey as String: "yapper.sysaudio.\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceIsStackedKey as String: false,
      kAudioAggregateDeviceTapAutoStartKey as String: true,
      kAudioAggregateDeviceSubDeviceListKey as String: [],
      kAudioAggregateDeviceTapListKey as String: [[
        kAudioSubTapUIDKey as String: desc.uuid.uuidString,
        kAudioSubTapDriftCompensationKey as String: true
      ]]
    ]
    err = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
    guard err == noErr else { throw TapError.create("aggregate device", err) }

    // The rate is whatever the machine is actually running at — 48 kHz on most
    // Macs, but it is asked for rather than assumed, because everything after
    // this is a resample down to 16 kHz and guessing the input would detune it.
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: kAudioObjectPropertyScopeInput,
      mElement: 0)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    err = AudioObjectGetPropertyData(aggID, &addr, 0, nil, &size, &asbd)
    guard err == noErr, asbd.mSampleRate > 0 else { throw TapError.create("stream format", err) }

    guard let inFmt = AVAudioFormat(streamDescription: &asbd) else {
      throw TapError.message("the tap reported a format nothing can read")
    }
    inputFormat = inFmt
    converter = AVAudioConverter(from: inFmt, to: outputFormat)
    guard converter != nil else {
      throw TapError.message("cannot convert \(inFmt.sampleRate) Hz to 16 kHz")
    }

    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { [weak self] _, inData, _, _, _ in
      self?.handle(inData)
    }
    guard err == noErr else { throw TapError.create("IO proc", err) }

    err = AudioDeviceStart(aggID, procID)
    guard err == noErr else { throw TapError.create("start", err) }

    note("capturing: tap")
  }

  // A tap the user has not permitted does not fail: it is created, it starts,
  // and it delivers exact digital zeros for as long as it runs — no error, and
  // no prompt when the permission record is stale (a re-signed app, for one).
  // 0.1.11 recorded a YouTube video that way: the microphone heard it through
  // the speakers, the system track was silence end to end. So the tap is
  // watched (see the timer at the bottom of the file). The IO thread records
  // whether a non-zero sample arrived since the health watch last looked; the
  // short lock keeps that hand-off race-free without covering conversion or
  // output work.
  private let signalLock = OSAllocatedUnfairLock(initialState: false)

  /// Evidence since the permanent health watch last looked. A source can
  /// prove itself and still stall after sleep, a device reconfiguration or an
  /// aggregate-device failure, so the watch consumes a fresh interval bit.
  func consumeRecentSignal() -> Bool {
    signalLock.withLock { recent in
      let result = recent
      recent = false
      return result
    }
  }

  // A test seam: a permitted tap cannot be made to go mute on demand, and the
  // fallback has to be exercised on the machine that has the permission.
  // `1` mutes this tap until it is stopped, so a test can walk the whole path:
  // a muted tap, the screen door, and — when that one will not deliver either
  // — the tap coming back and working. `always` keeps every tap muted, which
  // is what an unpermitted one really does, and takes the watch to the end of
  // its attempts.
  // `1` mutes this tap until it is stopped, `always` mutes every tap, and
  // `until-suspect` mutes them until the watch gives up — which is the only
  // way to reach the state where a suspicion is on screen and the tap then
  // comes alive, and see it withdrawn.
  static let muteSeam = ProcessInfo.processInfo.environment["YAPPER_TAP_SIMULATE_MUTE"] ?? ""
  private var simulateMuteThisInstance = TapCapture.muteSeam == "1"
  private var simulateMute: Bool {
    switch TapCapture.muteSeam {
    case "always": return true
    case "until-suspect": return !suspectSaid
    default: return simulateMuteThisInstance
    }
  }

  private func sawSamples(_ channel: UnsafeMutablePointer<Int16>, count: Int) {
    if simulateMute { for i in 0..<count { channel[i] = 0 } }
    for i in 0..<count where channel[i] != 0 {
      signalLock.withLock { $0 = true }
      return
    }
  }

  private func handle(_ inData: UnsafePointer<AudioBufferList>) {
    guard let inFmt = inputFormat, let converter else { return }
    let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
    guard let first = list.first, first.mDataByteSize > 0 else { return }

    let bytesPerFrame = max(1, Int(inFmt.streamDescription.pointee.mBytesPerFrame))
    let frames = AVAudioFrameCount(Int(first.mDataByteSize) / bytesPerFrame)
    guard frames > 0,
          let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: frames) else { return }
    inBuf.frameLength = frames

    // Copy in: the buffers handed to an IOProc are only valid for this call.
    let dst = UnsafeMutableAudioBufferListPointer(inBuf.mutableAudioBufferList)
    for (i, src) in list.enumerated() where i < dst.count {
      guard let s = src.mData, let d = dst[i].mData else { continue }
      let n = min(Int(src.mDataByteSize), Int(dst[i].mDataByteSize))
      memcpy(d, s, n)
      dst[i].mDataByteSize = UInt32(n)
    }

    let ratio = outputFormat.sampleRate / inFmt.sampleRate
    let outCapacity = AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + 16
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outCapacity) else { return }

    var handed = false
    var convErr: NSError?
    converter.convert(to: outBuf, error: &convErr) { _, status in
      if handed { status.pointee = .noDataNow; return nil }
      handed = true
      status.pointee = .haveData
      return inBuf
    }
    if convErr != nil || outBuf.frameLength == 0 { return }

    guard let channel = outBuf.int16ChannelData else { return }
    sawSamples(channel[0], count: Int(outBuf.frameLength))
    sink.write(Data(bytes: channel[0], count: Int(outBuf.frameLength) * 2))
  }

  /// Undo whatever start() managed to create, in the reverse order, and
  /// forget the ids: this instance can be started again — the mute watch
  /// puts the tap back when the screen door will not open — and acting on a
  /// destroyed object id is undefined, not merely useless.
  func stop() {
    if let procID {
      AudioDeviceStop(aggID, procID)
      AudioDeviceDestroyIOProcID(aggID, procID)
    }
    if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    simulateMuteThisInstance = false
    procID = nil
    aggID = kAudioObjectUnknown
    tapID = kAudioObjectUnknown
    converter = nil
    inputFormat = nil
  }
}

enum TapError: Error, CustomStringConvertible {
  case create(String, OSStatus)
  case message(String)

  /// The one worth telling apart: no permission to record system audio. Core
  /// Audio answers that with an illegal-operation status rather than with a
  /// dedicated error of its own.
  var isPermission: Bool {
    if case let .create(_, status) = self {
      return status == kAudioHardwareIllegalOperationError
    }
    return false
  }

  var description: String {
    switch self {
    case let .create(what, status):
      let c = withUnsafeBytes(of: status.bigEndian) { String(bytes: $0, encoding: .ascii) ?? "" }
      return "could not create the \(what): \(status) '\(c)'"
    case let .message(m): return m
    }
  }
}

// ------------------------------------------------------- screen capture kit

/// The older door, kept for macOS 13 and for machines the tap will not open
/// on. Nothing about the screen is read: the video side is configured down to
/// a 2×2 frame once a second and thrown away.
final class ScreenAudio: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  // A provisional stream is allowed to inspect samples, but not to write
  // them: the tap remains the recorder until the trial has both heard its
  // target and widened successfully. Otherwise two live sources interleave
  // PCM on stdout, or the app records the provisional stream's silence.
  private let outputLock = OSAllocatedUnfairLock(initialState: true)
  // Whether a non-zero sample has ever arrived, plus whether one arrived
  // since the long-lived health watch last looked. Neither startCapture()
  // returning nor a buffer showing up proves this door works: Safari's
  // protected playback reaches ScreenCaptureKit as a steady stream of digital
  // silence — buffers arrive on time and every sample in them is zero — while
  // a process tap hears it perfectly. Swapping a working tap for that is the
  // mistake worth avoiding, so the bar is the same one the tap has to clear.
  private let gotLock = OSAllocatedUnfairLock(initialState: (ever: false, recent: false))
  var heardSomething: Bool { gotLock.withLock { $0.ever } }

  /// Consume the evidence used by the permanent screen-only watch. `ever` is
  /// kept separately for the one-time trial verdict; a lifetime boolean is
  /// not enough for health monitoring because a stream can hear one app and
  /// later go digitally silent for protected playback.
  func consumeRecentSignal() -> Bool {
    gotLock.withLock { state in
      let recent = state.recent
      state.recent = false
      return recent
    }
  }

  // While a stream is on trial — started, not yet proven — its death is a
  // verdict, not a catastrophe: the tap is still the fallback. Only a stream
  // that was accepted takes the helper down with it when it stops.
  // The other half of YAPPER_TAP_SIMULATE_MUTE: with both set, a test walks
  // the path where neither door hears anything — what Safari's protected
  // playback does for real — down to the watch running out of attempts.
  private let simulateSilent = ProcessInfo.processInfo.environment["YAPPER_SCK_SIMULATE_SILENT"] == "1"

  private let trialLock = OSAllocatedUnfairLock(initialState: (onTrial: false, died: false))
  /// Enter the trial *before* the stream is started: a stream that dies in
  /// the moment after startCapture() returned would otherwise be read as an
  /// accepted stream dying, which takes the whole helper down.
  func beginTrial() {
    outputLock.withLock { $0 = false }
    trialLock.withLock { $0 = (onTrial: true, died: false) }
  }
  var diedOnTrial: Bool { trialLock.withLock { $0.died } }
  /// The verdict and the end of the trial in one step. Returns true only if
  /// the stream is still alive at the instant it stops being provisional —
  /// checking `died` and clearing `onTrial` separately let a death in between
  /// be recorded and then ignored.
  func acceptIfAlive() -> Bool {
    trialLock.withLock { state in
      let ok = !state.died
      state.onTrial = false
      return ok
    }
  }
  /// Leave the trial without accepting: the stream is being torn down, and a
  /// death reported while that happens is not the helper's problem.
  func abandonTrial() { trialLock.withLock { $0.onTrial = true } }

  /// The old route has now stopped; samples from the accepted general stream
  /// may become the single stdout producer.
  func enableOutput() { outputLock.withLock { $0 = true } }

  /// Whether ScreenCaptureKit could capture right now: the permission holds
  /// and there is a display to attach a filter to. Asked *before* the tap is
  /// stopped, because the wait for a sleeping display to wake is up to ten
  /// seconds and doing it with no source running is ten seconds of a meeting
  /// nobody is recording.
  static func ready() async -> Bool {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      return !content.displays.isEmpty
    } catch {
      return false
    }
  }

  /// Whether ScreenCaptureKit can be pointed at this exact process. A trial
  /// against some *other* audible application is not interchangeable: it can
  /// hear a notification and still be deaf to the protected playback that
  /// made the tap look suspect in the first place.
  static func canTrial(pid: pid_t) async -> Bool {
    if ProcessInfo.processInfo.environment["YAPPER_SCK_HIDE_TRIAL_APP"] == "1" { return false }
    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
          !content.displays.isEmpty else { return false }
    return content.applications.contains { $0.processID == pid }
  }

  /// Returns whether capture is live. Normally a failure ends the helper with
  /// the exit code the app reads; `lenient` is for the tap's fallback, where
  /// a failing screen door must leave the tap in place rather than take the
  /// whole helper down with it.
  /// The pid whose audio this stream has to prove it can hear, while on trial.
  var trialPID: pid_t?
  private var scopedToTrial = false
  private var display: SCDisplay?

  /// Widen a trial stream from the one process it was proving to the whole
  /// display, once it has proved it. Returns whether the stream is now a
  /// general capture: while the widening has not succeeded it still carries
  /// one application's audio, and handing that to a meeting as "the far side"
  /// would be a recording of one participant.
  func acceptTrial() async -> Bool {
    guard scopedToTrial else { return true }         // never scoped; nothing to widen
    guard let s = stream, let display else { return false }
    let widened = await withCheckedContinuation { (k: CheckedContinuation<Bool, Never>) in
      if ProcessInfo.processInfo.environment["YAPPER_SCK_FAIL_WIDEN"] == "1" {
        note("note: screen capture could not be widened past the app it was checked against (seam)")
        k.resume(returning: false)
        return
      }
      s.updateContentFilter(SCContentFilter(display: display, excludingWindows: [])) { err in
        if let err {
          note("note: screen capture could not be widened past the app it was checked against (\(err.localizedDescription))")
        }
        k.resume(returning: err == nil)
      }
    }
    if widened { scopedToTrial = false }
    return widened
  }

  @discardableResult
  func start(lenient: Bool = false) async -> Bool {
    func giveUp(_ message: String, code: Int32) -> Bool {
      if lenient { note("note: screen capture unavailable: \(message.replacingOccurrences(of: "\n", with: " — "))"); return false }
      fail(message, code: code)
    }
    // A sleeping display means ScreenCaptureKit lists no displays at all, and
    // a filter needs one even when only audio is wanted. That is a state the
    // machine leaves on its own — the screen wakes, the list repopulates — so
    // it is worth waiting out rather than reporting as a dead end.
    var display: SCDisplay?
    for attempt in 0..<10 {
      let content: SCShareableContent
      do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      } catch {
        // This is what a missing Screen Recording permission looks like: the
        // content query itself is refused, before any capture is attempted.
        return giveUp("permission: screen\nscreen recording permission missing: \(error.localizedDescription)", code: 2)
      }
      if let first = content.displays.first { display = first; break }
      if attempt == 0 { note("note: waiting for a display") }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
    guard let display else { return giveUp("no displays after waiting", code: 3) }

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = Int(SAMPLE_RATE)
    config.channelCount = 1
    // Yapper's own output would otherwise come back in, and a recording that
    // contains itself feeds back the moment anything is played.
    config.excludesCurrentProcessAudio = true
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

    // On trial, the stream is narrowed to the process that provoked the
    // doubt: a mixed stream cannot say *whose* audio it carried, so a
    // notification chiming during the check would otherwise vouch for a door
    // that is deaf to the thing that matters (Safari's protected playback
    // reaches ScreenCaptureKit as digital silence). Scoped to that app, a
    // non-zero sample can only have come from it. On acceptance the filter is
    // widened to the whole display, which is what a recording wants.
    var filter = SCContentFilter(display: display, excludingWindows: [])
    if let pid = trialPID {
      let hidden = ProcessInfo.processInfo.environment["YAPPER_SCK_HIDE_TRIAL_APP"] == "1"
      let app = hidden ? nil
        : (try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false))?
            .applications.first(where: { $0.processID == pid })
      if let app {
        filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        scopedToTrial = true
      } else {
        // Without that application there is no trial to run: a stream over the
        // whole display could be vouched for by any other sound in the room,
        // which is the thing the scoping exists to prevent.
        return giveUp("the process to check against is not visible to screen capture", code: 6)
      }
    }
    let s = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "yapper.sysaudio.sck"))
      try await s.startCapture()
    } catch {
      return giveUp("could not start capture: \(error.localizedDescription)", code: 4)
    }
    stream = s
    self.display = display
    // A trial is not the active route yet. The tap is still writing, and the
    // protocol must not tell Electron to switch routes or clear a warning
    // until the trial is accepted and widened.
    if trialPID == nil { note("capturing: screen") }
    return true
  }

  func stop() async {
    if let s = stream { try? await s.stopCapture() }
    stream = nil
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }

    var blockBuffer: CMBlockBuffer?
    var abl = AudioBufferList()
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: &abl,
      bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: nil,
      blockBufferMemoryAllocator: nil,
      flags: 0,
      blockBufferOut: &blockBuffer)
    guard status == noErr, let raw = abl.mBuffers.mData else { return }

    // ScreenCaptureKit hands over Float32; everything downstream is Int16.
    let count = Int(abl.mBuffers.mDataByteSize) / MemoryLayout<Float32>.size
    let floats = raw.bindMemory(to: Float32.self, capacity: count)
    var pcm = Data(count: count * 2)
    pcm.withUnsafeMutableBytes { dest in
      let ints = dest.bindMemory(to: Int16.self)
      for i in 0..<count {
        let clamped = max(-1.0, min(1.0, floats[i]))
        ints[i] = Int16(clamped * 32767.0)
      }
    }
    if simulateSilent { pcm.resetBytes(in: 0..<pcm.count) }
    var hasSignal = false
    pcm.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for v in samples where v != 0 { hasSignal = true; break }
    }
    if hasSignal {
      gotLock.withLock { state in
        state.ever = true
        state.recent = true
      }
    }
    if outputLock.withLock({ $0 }) { sink.write(pcm) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let trial = trialLock.withLock { state -> Bool in
      if state.onTrial { state.died = true }
      return state.onTrial
    }
    if trial {
      note("note: screen capture stopped while being checked: \(error.localizedDescription)")
      return
    }
    fail("stream stopped: \(error.localizedDescription)", code: 5)
  }
}

// ---------------------------------------------------------------- entry

// A broken pipe means the parent stopped recording and closed our stdout;
// that is a normal end, not a crash worth a signal.
signal(SIGPIPE, SIG_IGN)

// Samples now leave through a queue rather than straight from the audio
// callback, which means exiting the instant SIGTERM lands would drop whatever
// is still in flight — the last fraction of a second of a meeting. stop() in
// sysaudio.js is a plain kill, so that moment is every recording's ending.
signal(SIGTERM, SIG_IGN)
let onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
onTerm.setEventHandler {
  sink.drain()
  exit(0)
}
onTerm.resume()

// YAPPER_FORCE_SCK exists so the fallback can be exercised on a machine new
// enough to take the tap — otherwise it would only ever run on hardware nobody
// testing this owns.
let forceSCK = ProcessInfo.processInfo.environment["YAPPER_FORCE_SCK"] == "1"

/// A repeating main-queue source that intentionally retains itself while it
/// is active and breaks that cycle when cancelled. Capturing a bare dispatch
/// source in its own handler leaves every cancelled mute-watch generation
/// retaining its TapCapture for the rest of the helper's life.
final class MainQueueTimer: @unchecked Sendable {
  private var source: DispatchSourceTimer?

  init(after: TimeInterval, every: TimeInterval) {
    let source = DispatchSource.makeTimerSource(queue: .main)
    source.schedule(deadline: .now() + after, repeating: every)
    self.source = source
  }

  func setEventHandler(_ body: @escaping (MainQueueTimer) -> Void) {
    source?.setEventHandler { [self] in body(self) }
  }

  func resume() { source?.resume() }

  func cancel() {
    guard let source else { return }
    source.setEventHandler(handler: {})
    source.cancel()
    self.source = nil
  }
}

/// Every process other than Yapper whose audio output is running right now.
/// Yapper is the helper's parent and every process in its bundle-id family
/// (YAPPER_OWN_BUNDLE_PREFIX: the app's packaged, Electron's unpackaged).
/// Needs the process objects CoreAudio exposes from macOS 14.2.
///
/// One snapshot per call, and identity is the pid: bundle ids are not unique
/// (a browser has several audio processes under one id) and a paginated walk
/// over freshly-read lists could skip past its own cursor or lose it when a
/// process appeared, vanished, or moved between reads.
@available(macOS 14.2, *)
func playingProcesses() -> [(id: AudioObjectID, pid: pid_t, label: String)] {
  func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
  }
  let system = AudioObjectID(kAudioObjectSystemObject)
  var listAddr = address(kAudioHardwarePropertyProcessObjectList)
  // The list can change between asking for its size and reading it (see
  // mic-probe.swift, which met the same race); retry rather than answer "nobody".
  var ids: [AudioObjectID] = []
  for _ in 0..<4 {
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &size) == noErr else { continue }
    if size == 0 { return [] }
    var buf = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if AudioObjectGetPropertyData(system, &listAddr, 0, nil, &size, &buf) == noErr {
      ids = Array(buf.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
      break
    }
  }
  let me = getpid(), parent = getppid()
  let own = ProcessInfo.processInfo.environment["YAPPER_OWN_BUNDLE_PREFIX"] ?? "com.yapper."
  var out: [(id: AudioObjectID, pid: pid_t, label: String)] = []
  for id in ids {
    var running: UInt32 = 0
    var rSize = UInt32(MemoryLayout<UInt32>.size)
    var rAddr = address(kAudioProcessPropertyIsRunningOutput)
    guard AudioObjectGetPropertyData(id, &rAddr, 0, nil, &rSize, &running) == noErr, running != 0 else { continue }
    var pid: pid_t = 0
    var pSize = UInt32(MemoryLayout<pid_t>.size)
    var pAddr = address(kAudioProcessPropertyPID)
    guard AudioObjectGetPropertyData(id, &pAddr, 0, nil, &pSize, &pid) == noErr else { continue }
    if pid == me || pid == parent { continue }
    var bundle: Unmanaged<CFString>?
    var bSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var bAddr = address(kAudioProcessPropertyBundleID)
    let name = AudioObjectGetPropertyData(id, &bAddr, 0, nil, &bSize, &bundle) == noErr
      ? (bundle?.takeRetainedValue() as String? ?? "") : ""
    if name.hasPrefix(own) { continue }
    out.append((id: id, pid: pid, label: name.isEmpty ? "pid \(pid)" : name))
  }
  return out
}

@available(macOS 14.2, *)
func anyoneElsePlaying() -> (id: AudioObjectID, pid: pid_t, label: String)? { playingProcesses().first }

/// Is this exact process still playing? Both halves are checked: a pid is
/// reused once its process is gone, and the audio object is what CoreAudio
/// itself calls the process — together they are the same instance or nothing.
@available(macOS 14.2, *)
func stillPlaying(_ who: (id: AudioObjectID, pid: pid_t, label: String)) -> Bool {
  playingProcesses().contains { $0.id == who.id && $0.pid == who.pid }
}

// Held here, not in a closure: the capturer must outlive the code that
// started it, whichever path created it. Written only through holdCapturer,
// which puts every change on the main queue — the watch decides from Tasks,
// and two of them dropping this reference at once would deallocate a stream
// that is still capturing.
nonisolated(unsafe) var screenCapturer: ScreenAudio?

func holdCapturer(_ c: ScreenAudio?) {
  if Thread.isMainThread { screenCapturer = c } else { DispatchQueue.main.sync { screenCapturer = c } }
}

/// The one way through the screen door, from every place that gives up on the
/// tap. Advisory lines carry the `note:` prefix so the app logs them and does
/// nothing else — a bare line reads as a failure there.
func fallBackToScreen(_ why: String) {
  note("note: \(why); falling back to screen capture")
  let capturer = ScreenAudio()
  holdCapturer(capturer)
  Task {
    await capturer.start()
    watchScreenOnly(capturer)
  }
}

/// The screen door as the only door — no tap to compare it against, and no
/// second source to switch to. It can still be deaf: protected playback
/// reaches it as digital silence. So it is watched the same way, and after
/// enough evidence the doubt is said out loud; the capture is left running,
/// because a silent stream may simply be a quiet room and stopping it would
/// turn a maybe into a certainty. The watch stays for the stream's whole life:
/// a real sample withdraws the doubt, and a later silent spell can raise it
/// again instead of trusting one sample forever.
@available(macOS 14.2, *)
func watchScreenOnlyModern(_ capturer: ScreenAudio) {
  let mutedAfter = Int(ProcessInfo.processInfo.environment["YAPPER_TAP_MUTED_AFTER"] ?? "") ?? 60
  var silentTicks = 0
  var said = false
  let watch = MainQueueTimer(after: 1, every: 1)
  watch.setEventHandler { watch in
    if capturer.consumeRecentSignal() {
      silentTicks = 0
      if said {
        said = false
        note("note: the system audio track came alive after all")
        note("capturing: screen")
      }
      return
    }
    guard let other = anyoneElsePlaying() else { silentTicks = 0; return }
    silentTicks += 1
    guard silentTicks >= mutedAfter, !said else { return }
    said = true
    suspect("screen", "the system audio track has been silent while \(other.label) played; screen capture cannot hear protected playback, and this Mac has no process tap to fall back on")
  }
  watch.resume()
}

/// Before 14.2 Core Audio does not expose process objects, so there is no
/// honest way to prove that another application was producing sound. The
/// remaining useful signal is prolonged all-zero capture. It is deliberately
/// only a doubt: the stream stays up, and its first real sample withdraws it.
func watchScreenOnlyLegacy(_ capturer: ScreenAudio) {
  let mutedAfter = Int(ProcessInfo.processInfo.environment["YAPPER_TAP_MUTED_AFTER"] ?? "") ?? 60
  var silentTicks = 0
  var said = false
  let watch = MainQueueTimer(after: 1, every: 1)
  watch.setEventHandler { watch in
    if capturer.consumeRecentSignal() {
      silentTicks = 0
      if said {
        said = false
        note("note: the system audio track came alive after all")
        note("capturing: screen")
      }
      return
    }
    silentTicks += 1
    guard silentTicks >= mutedAfter, !said else { return }
    said = true
    suspect("screen", "screen capture has produced only silence for \(mutedAfter) seconds; this macOS version cannot say whether another process was playing, and protected playback may be unavailable")
  }
  watch.resume()
}

func watchScreenOnly(_ capturer: ScreenAudio) {
  if #available(macOS 14.2, *) { watchScreenOnlyModern(capturer) }
  else { watchScreenOnlyLegacy(capturer) }
}

// Read from the audio callback (the test seam) and written by the watch on
// the main queue: small enough to hold under a lock, and never held across
// anything that could block.
let suspectFlag = OSAllocatedUnfairLock(initialState: false)
nonisolated var suspectSaid: Bool { suspectFlag.withLock { $0 } }

/// Something is probably wrong with the system audio, but recording continues
/// and the app decides what to say. `which` names the door in doubt, so the
/// app can point at the right pane: `audio` for the process tap's permission,
/// `screen` for Screen Recording.
func suspect(_ which: String, _ why: String) {
  suspectFlag.withLock { $0 = true }
  note("suspect: \(which)")
  note("note: \(why)")
}

/// Watch a tap that may be muted, and keep watching.
///
/// A tap started without the System Audio Recording permission does not fail:
/// it delivers exact zeros forever. The only evidence available is indirect —
/// someone outside Yapper is playing sound and the tap hears nothing — so the
/// bar is high (`mutedAfter` consecutive seconds of it) and the answer is
/// checked rather than assumed: the screen door is opened and has to produce a
/// non-zero sample of its own before the tap is given up.
///
/// It is armed again after every inconclusive round, because none of the ways
/// a round can end are proof:
///  - the scoped screen door heard nothing, which may only mean its target went
///    quiet during those seconds;
///  - the tap it returns to may still be muted or may stall later.
/// So the watch returns, up to `attemptsLeft` times, and a tap that keeps
/// hearing nothing while the machine plays is looked at again. Without that,
/// one inconclusive round at minute two left an unpermitted tap trusted for
/// the rest of the meeting, and a five-minute cap left one trusted forever if
/// nothing played until then.
@available(macOS 14.4, *)
func armMuteWatch(_ t: TapCapture, attemptsLeft: Int) {
  // Every way a round can end goes through here: either there is another
  // attempt, or the doubt is said out loud. Nothing may return quietly with
  // the tap still silent — that is the shape of the original bug, an app
  // reporting "capturing: tap" over a recording with no far side in it.
  func rearmOrSuspect(_ left: Int, _ why: String) {
    if left > 0 { armMuteWatch(t, attemptsLeft: left); return }
    suspect("audio", why)
    // And keep an ear open: if the tap was merely listening to a quiet room,
    // the first real sound settles it, and the warning comes off the screen.
    let settle = MainQueueTimer(after: 2, every: 2)
    settle.setEventHandler { settle in
      guard t.consumeRecentSignal() else { return }
      settle.cancel()
      note("note: the system audio track came alive after all")
      note("capturing: tap")
      // Recovery is not a lifetime guarantee. Give the live tap a fresh
      // budget so a later sleep/reconfiguration failure is detected too.
      armMuteWatch(t, attemptsLeft: 3)
    }
    settle.resume()
  }

  if attemptsLeft <= 0 { rearmOrSuspect(0, "the system audio track has been silent while other apps played"); return }
  let tapDebug = ProcessInfo.processInfo.environment["YAPPER_TAP_DEBUG"] == "1"
  let mutedAfter = Int(ProcessInfo.processInfo.environment["YAPPER_TAP_MUTED_AFTER"] ?? "") ?? 60
  var mutedTicks = 0
  let watch = MainQueueTimer(after: 1, every: 1)
  watch.setEventHandler { watch in
    if t.consumeRecentSignal() {
      mutedTicks = 0
      // A returned tap that proves itself gets a fresh validation budget for
      // any later degradation; do not spend the rest of the meeting on the
      // attempts consumed by an earlier quiet spell.
      if attemptsLeft < 3 {
        watch.cancel()
        armMuteWatch(t, attemptsLeft: 3)
      }
      return
    }
    let playing = anyoneElsePlaying()
    if tapDebug { note("note: tap watch mutedTicks=\(mutedTicks) playing=\(playing?.label ?? "nobody") attemptsLeft=\(attemptsLeft)") }
    mutedTicks = playing == nil ? 0 : mutedTicks + 1
    guard mutedTicks >= mutedAfter, let other = playing else { return }
    watch.cancel()
    guard CGPreflightScreenCaptureAccess() else {
      // Nowhere else to go: without Screen Recording there is no second door
      // to check this against, so the doubt is all there is to report.
      rearmOrSuspect(0, "the system audio track has been silent while \(other.label) played, and without Screen Recording there is no second way to check it")
      return
    }
    if t.consumeRecentSignal() { armMuteWatch(t, attemptsLeft: 3); return } // a sample landed just now
    Task {
      // The main process releases its display assertion when the tap reports
      // itself live. Hold one locally across the hand-off: canTrial() may see
      // a display and, without this, it can sleep during the teardown delay;
      // start() would then wait up to ten seconds with the tap already gone.
      let transitionActivity = ProcessInfo.processInfo.beginActivity(
        options: [.idleDisplaySleepDisabled], reason: "Checking the system-audio fallback")
      defer { ProcessInfo.processInfo.endActivity(transitionActivity) }

      // Asked while the tap is still running. Only the exact process that
      // provoked this round may validate the other door; substituting another
      // audible app recreates the unrelated-notification false verdict.
      guard await ScreenAudio.canTrial(pid: other.pid), stillPlaying(other) else {
        rearmOrSuspect(attemptsLeft - 1,
          "the system audio track has been silent while \(other.label) played, and screen capture could not be pointed at that process to check against")
        return
      }
      if t.consumeRecentSignal() { armMuteWatch(t, attemptsLeft: 3); return }
      note("note: tap silent for \(mutedAfter) s while \(other.label) played — the permission is probably not granted; trying screen capture against that process")
      let capturer = ScreenAudio()
      capturer.trialPID = other.pid
      capturer.beginTrial()
      holdCapturer(capturer)
      // The process can disappear while ScreenCaptureKit is opening. Do not
      // let a newly-reused pid stand in for the AudioObjectID that was seen.
      // The tap deliberately stays live throughout this provisional stream:
      // SCK inspects its target but suppresses its stdout until acceptance.
      var live = stillPlaying(other) ? await capturer.start(lenient: true) : false
      if live {
        // The stream is scoped to the process that provoked this, so any
        // non-zero sample is that process being heard. Wait while it is still
        // playing: silence after it stopped proves nothing about either door.
        for _ in 0..<16 where !capturer.heardSomething && !capturer.diedOnTrial && stillPlaying(other) {
          try? await Task.sleep(nanoseconds: 500_000_000)
        }
        // A sample from a process that replaced a reused pid is not evidence
        // about the original AudioObjectID.
        let heard = capturer.heardSomething && stillPlaying(other)
        // One step: alive at the instant it stops being provisional, or not.
        let alive = heard ? capturer.acceptIfAlive() : false
        // And a stream that cannot be widened past the one application it was
        // checked against is not a recording of the far side, whatever it
        // heard: a death during the widening stays fatal (it is accepted by
        // then), but a refusal to widen sends it back to the tap.
        let general = alive ? await capturer.acceptTrial() : false
        if general {
          // Hand off only now. Until this instant the tap kept writing and
          // SCK wrote nothing, so a quiet/failed trial cannot create a hole or
          // double the PCM clock. Stop the old route before enabling the new
          // one, then announce the route Electron can actually rely on.
          t.stop()
          capturer.enableOutput()
          note("capturing: screen")
        } else {
          capturer.abandonTrial()                 // its death while stopping is not fatal
          note("note: screen capture "
            + (capturer.diedOnTrial ? "stopped on its own"
               : alive ? "could not be widened past \(other.label)"
               : "heard nothing from \(other.label) either")
            + "; going back to the tap")
          await capturer.stop()
          live = false
        }
      }
      if live {
        // The accepted stream is now the only door too. Keep checking it: one
        // successful trial does not prove that a later app or protected source
        // will remain audible through ScreenCaptureKit.
        watchScreenOnly(capturer)
        return
      }
      holdCapturer(nil)
      do {
        // A failed check leaves the old tap running, but recreating it is what
        // recovers a real aggregate-device stall. The only source-less window
        // is this synchronous teardown/start, not the whole SCK trial.
        t.stop()
        try t.start()
        note("note: back on the tap")
        rearmOrSuspect(attemptsLeft - 1,
          "the system audio track has been silent while \(other.label) played, and screen capture could not confirm it either")
      } catch {
        // Both doors are shut. Said as a failure, not an aside: the app is
        // still being told "capturing: tap" from before, and it has to learn
        // that the far side is gone — its own retry starts a fresh helper.
        fail("no audio source left: screen capture would not deliver and the tap would not restart (\(error))", code: 5)
      }
    }
  }
  watch.resume()
}

var tap: AnyObject?
if #available(macOS 14.4, *), !forceSCK {
  let t = TapCapture()
  do {
    try t.start()
    tap = t
  } catch let e as TapError {
    if e.isPermission {
      fail("permission: audio\nsystem audio permission missing: \(e)", code: 2)
    }
    // Anything else is this machine refusing the tap, not the user refusing
    // permission. Take the door that has worked since macOS 13 — after
    // letting go of whatever the tap got as far as creating.
    t.stop()
    fallBackToScreen("tap unavailable (\(e))")
  } catch {
    t.stop()
    fallBackToScreen("tap unavailable (\(error))")
  }
}

if tap == nil {
  if screenCapturer == nil {
    fallBackToScreen(forceSCK ? "YAPPER_FORCE_SCK is set" : "no process tap before macOS 14.4")
  }
} else if #available(macOS 14.4, *), let t = tap as? TapCapture {
  armMuteWatch(t, attemptsLeft: 3)
}

RunLoop.main.run()
