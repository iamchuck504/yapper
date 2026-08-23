// Prints the bundle id of every process currently capturing audio, one per line.
//
// This is the macOS half of meeting auto-detection. Windows answers the same
// question through the CapabilityAccessManager consent store in the registry;
// macOS 14 answers it through CoreAudio, which since then exposes the list of
// audio processes and, per process, whether its input is live. No permission
// prompt, no polling of private APIs — the same fact, from the supported door.
//
// Empty output means nobody is capturing. A non-zero exit means the question
// could not be asked, which the caller must not confuse with "nobody" — a
// failed probe should never end a recording.
//
// Built by mac/build-app.sh into build/mic-probe:
//   swiftc -O mac/mic-probe.swift -o build/mic-probe
//
// With `--watch` it stays resident instead: one line per change in the answer
// (bundle ids separated by tabs, an empty line when nobody is capturing, a
// lone `?` when the question could not be asked), the first one immediately.
// CoreAudio tells it when the process list or any process's input state
// changes, so nothing is polled — the app used to spawn this binary every five
// seconds for as long as it was open, 720 process launches an hour to learn,
// almost always, that nothing had changed. It exits when stdin closes, which
// is how it learns the app is gone.

import CoreAudio
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector,
                             mScope: kAudioObjectPropertyScopeGlobal,
                             mElement: kAudioObjectPropertyElementMain)
}

let system = AudioObjectID(kAudioObjectSystemObject)
var listAddr = address(kAudioHardwarePropertyProcessObjectList)

// The process list can change between asking for its size and reading it. A
// call starting or ending in that gap makes CoreAudio reject the old buffer;
// polling every five seconds made that harmless race look like a broken probe.
// Re-read the size and retry, and treat a genuinely empty list as a valid
// answer rather than an error.
func audioProcessIDs() -> [AudioObjectID]? {
  for _ in 0..<4 {
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &size) == noErr else {
      continue
    }
    if size == 0 { return [] }

    var actualSize = size
    var values = [AudioObjectID](
      repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(system, &listAddr, 0, nil, &actualSize, &values)
    if status == noErr {
      let count = Int(actualSize) / MemoryLayout<AudioObjectID>.size
      return Array(values.prefix(count))
    }
  }
  return nil
}

/// Bundle ids of the processes whose input is live right now, or nil when the
/// list could not be read.
func capturingBundleIDs() -> [String]? {
  guard let ids = audioProcessIDs() else { return nil }
  var names: [String] = []
  for id in ids {
    var running: UInt32 = 0
    var runningSize = UInt32(MemoryLayout<UInt32>.size)
    var runningAddr = address(kAudioProcessPropertyIsRunningInput)
    guard AudioObjectGetPropertyData(id, &runningAddr, 0, nil, &runningSize, &running) == noErr,
          running != 0 else { continue }

    // Unmanaged keeps this an opaque pointer, which is what the C API wants and
    // what keeps the compiler from warning about writing into an object slot.
    var bundle: Unmanaged<CFString>?
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var bundleAddr = address(kAudioProcessPropertyBundleID)
    guard AudioObjectGetPropertyData(id, &bundleAddr, 0, nil, &bundleSize, &bundle) == noErr,
          let name = bundle?.takeRetainedValue() as String?,
          !name.isEmpty else { continue }
    names.append(name)
  }
  return names
}

if CommandLine.arguments.contains("--watch") {
  let queue = DispatchQueue(label: "mic-probe.watch")
  var last: String? = nil
  var watched = Set<AudioObjectID>()
  var listener: AudioObjectPropertyListenerBlock = { _, _ in }

  func emit(force: Bool = false) {
    let line = capturingBundleIDs().map { $0.joined(separator: "\t") } ?? "?"
    if !force && line == last { return }
    last = line
    print(line)
    fflush(stdout)
  }

  // Every audio process gets its own listener for "is my input running"; the
  // system object's process list says when new ones appear. A listener left
  // on a process that has since exited is inert, so nothing is ever removed.
  func watchProcesses() {
    for id in audioProcessIDs() ?? [] where !watched.contains(id) {
      var runningAddr = address(kAudioProcessPropertyIsRunningInput)
      if AudioObjectAddPropertyListenerBlock(id, &runningAddr, queue, listener) == noErr {
        watched.insert(id)
      }
    }
  }

  listener = { _, _ in
    watchProcesses()
    emit()
  }
  AudioObjectAddPropertyListenerBlock(system, &listAddr, queue, listener)

  // The parent closing its end of stdin is the signal to go; an app that
  // crashed cannot send anything else, and this must not outlive it.
  DispatchQueue.global(qos: .utility).async {
    while readLine() != nil { }
    exit(0)
  }

  // A slow resync, in case a notification was missed while a listener was
  // being installed. Thirty seconds is far from the five the app polled at.
  let resync = DispatchSource.makeTimerSource(queue: queue)
  resync.schedule(deadline: .now() + 30, repeating: 30)
  // Also a heartbeat: the parent can distinguish a healthy unchanged watcher
  // from one that is alive but stopped receiving CoreAudio notifications.
  resync.setEventHandler { watchProcesses(); emit(force: true) }
  resync.resume()

  queue.async { watchProcesses(); emit() }
  RunLoop.main.run()
  exit(0)
}

guard let names = capturingBundleIDs() else {
  FileHandle.standardError.write(Data("cannot read the audio process list\n".utf8))
  exit(1)
}
for name in names { print(name) }
