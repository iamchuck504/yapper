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

import CoreAudio
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector,
                             mScope: kAudioObjectPropertyScopeGlobal,
                             mElement: kAudioObjectPropertyElementMain)
}

let system = AudioObjectID(kAudioObjectSystemObject)
var listAddr = address(kAudioHardwarePropertyProcessObjectList)
var size: UInt32 = 0

guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &size) == noErr else {
  FileHandle.standardError.write(Data("cannot size the audio process list\n".utf8))
  exit(1)
}

var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
guard !ids.isEmpty,
      AudioObjectGetPropertyData(system, &listAddr, 0, nil, &size, &ids) == noErr else {
  FileHandle.standardError.write(Data("cannot read the audio process list\n".utf8))
  exit(1)
}

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

  print(name)
}
