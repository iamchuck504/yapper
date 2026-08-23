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
final class Sink {
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

let sink = Sink()

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
  func start() throws {
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
  // the speakers, the system track was silence end to end. So the tap watches
  // itself. Zeros are only suspicious while the Mac is actually playing
  // something; three seconds of them with the default output device running
  // means the tap is muted, and the screen door is tried instead.
  private(set) var heardSignal = false
  private var zeroSeconds = 0.0
  private let muteWatch = DispatchQueue(label: "yapper.tap.watch")

  // A test seam: a tap that is permitted cannot be made to go mute on demand,
  // and the fallback has to be exercised on the machine that has the permission.
  private let simulateMute = ProcessInfo.processInfo.environment["YAPPER_TAP_SIMULATE_MUTE"] == "1"

  private func sawSamples(_ channel: UnsafeMutablePointer<Int16>, count: Int) {
    if heardSignal { return }
    if simulateMute { for i in 0..<count { channel[i] = 0 } }
    var allZero = true
    for i in 0..<count where channel[i] != 0 { allZero = false; break }
    muteWatch.async {
      if !allZero { self.heardSignal = true; self.zeroSeconds = 0 }
      else { self.zeroSeconds += Double(count) / SAMPLE_RATE }
    }
  }

  /// True when the tap has produced nothing but zeros for `seconds` while the
  /// default output device was playing — the signature of a muted tap.
  func looksMuted(after seconds: Double) -> Bool {
    muteWatch.sync { !heardSignal && zeroSeconds >= seconds } && outputDeviceRunning()
  }

  func debugState() -> String {
    let z = muteWatch.sync { zeroSeconds }
    return "heard=\(heardSignal) zeroSeconds=\(String(format: "%.1f", z)) outputRunning=\(outputDeviceRunning())"
  }

  private func outputDeviceRunning() -> Bool {
    var dev = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev) == noErr,
          dev != kAudioObjectUnknown else { return false }
    var running: UInt32 = 0
    size = UInt32(MemoryLayout<UInt32>.size)
    addr.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
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

  func stop() {
    if let procID {
      AudioDeviceStop(aggID, procID)
      AudioDeviceDestroyIOProcID(aggID, procID)
    }
    if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
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

  func start() async {
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
        fail("permission: screen\nscreen recording permission missing: \(error.localizedDescription)", code: 2)
      }
      if let first = content.displays.first { display = first; break }
      if attempt == 0 { note("waiting for a display") }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
    guard let display else { fail("no displays after waiting", code: 3) }

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

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let s = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "yapper.sysaudio.sck"))
      try await s.startCapture()
    } catch {
      fail("could not start capture: \(error.localizedDescription)", code: 4)
    }
    stream = s
    note("capturing: screen")
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
    sink.write(pcm)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
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
    // permission. Fall through to the door that has worked since macOS 13.
    note("tap unavailable (\(e)); falling back to screen capture")
  } catch {
    note("tap unavailable (\(error)); falling back to screen capture")
  }
}

if tap == nil {
  let capturer = ScreenAudio()
  Task { await capturer.start() }
} else if #available(macOS 14.4, *), let t = tap as? TapCapture {
  // The tap started, which proves nothing (see TapCapture.looksMuted). Check
  // once a second until it has been heard from; give up on it after three
  // seconds of zeros with something playing. The screen door then asks for
  // its own permission, and names it, instead of recording silence.
  let watch = DispatchSource.makeTimerSource(queue: .main)
  watch.schedule(deadline: .now() + 1, repeating: 1)
  let tapDebug = ProcessInfo.processInfo.environment["YAPPER_TAP_DEBUG"] == "1"
  watch.setEventHandler {
    if tapDebug { note("tap watch: \(t.debugState())") }
    if t.heardSignal { watch.cancel(); return }
    if t.looksMuted(after: 3) {
      watch.cancel()
      note("tap silent while audio plays (permission not granted?); falling back to screen capture")
      t.stop()
      tap = nil
      let capturer = ScreenAudio()
      Task { await capturer.start() }
    }
  }
  watch.resume()
}

RunLoop.main.run()
