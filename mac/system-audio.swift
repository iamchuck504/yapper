// Captures what the Mac is playing — the other side of a call — and writes it
// to stdout as 16 kHz mono 16-bit PCM: exactly the format the rest of the app
// already moves around, so main.js can mix it into the microphone stream
// sample for sample without resampling anything.
//
// Windows gets this from Electron's loopback. macOS has no loopback, so this
// is the equivalent: ScreenCaptureKit, which since macOS 13 can capture system
// audio. The name is misleading — no screen content is ever read, the video
// side is configured down to a 2×2 frame once a second and thrown away — but
// the permission it asks for is still Screen Recording, and there is no
// audio-only door that avoids it.
//
// Exit codes matter to the caller: 2 means the permission is missing, which is
// recoverable (record the microphone alone and say so). Anything else is a
// real failure.
//
// Built by mac/build-app.sh into build/system-audio:
//   swiftc -O mac/system-audio.swift -o build/system-audio

import AVFoundation
import ScreenCaptureKit

let SAMPLE_RATE = 16000

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(code)
}

final class SystemAudio: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let out = FileHandle.standardOutput

  func start() async {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
      // This is what a missing Screen Recording permission looks like: the
      // content query itself is refused, before any capture is attempted.
      fail("screen recording permission missing: \(error.localizedDescription)", code: 2)
    }
    guard let display = content.displays.first else { fail("no displays", code: 3) }

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = SAMPLE_RATE
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
      try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "yapper.sysaudio"))
      try await s.startCapture()
    } catch {
      fail("could not start capture: \(error.localizedDescription)", code: 4)
    }
    stream = s
    FileHandle.standardError.write(Data("capturing\n".utf8))
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
    out.write(pcm)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("stream stopped: \(error.localizedDescription)", code: 5)
  }
}

// A broken pipe means the parent stopped recording and closed our stdout;
// that is a normal end, not a crash worth a signal.
signal(SIGPIPE, SIG_IGN)

let capturer = SystemAudio()
Task { await capturer.start() }
RunLoop.main.run()
