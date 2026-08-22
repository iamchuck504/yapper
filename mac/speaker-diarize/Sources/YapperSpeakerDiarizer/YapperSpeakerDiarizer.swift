import Darwin
import FluidAudio
import Foundation

private struct Segment: Encodable {
    let speaker: String
    let start: Double
    let end: Double
}

private struct Payload: Encodable {
    let version: Int
    let segments: [Segment]
}

private func writePayload(_ segments: [Segment]) throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(Payload(version: 1, segments: segments))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func fail(_ message: String, code: Int32 = 2) -> Never {
    let clean = message.replacingOccurrences(of: "\n", with: " ").prefix(500)
    FileHandle.standardError.write(Data("speaker diarization failed: \(clean)\n".utf8))
    exit(code)
}

@main
private struct YapperSpeakerDiarizer {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())

        // Build/package smoke tests exercise the executable without downloading
        // the model bundle or requiring a speech fixture.
        if arguments == ["--self-test"] {
            do { try writePayload([]) } catch { fail(error.localizedDescription) }
            return
        }

        guard #available(macOS 14.0, *) else {
            fail("speaker detection requires macOS 14 or later")
        }
        guard arguments.count == 1 else {
            fail("usage: speaker-diarize <audio-file>", code: 64)
        }

        let file = URL(fileURLWithPath: arguments[0]).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else {
            fail("the audio file does not exist", code: 66)
        }

        do {
            FileHandle.standardError.write(Data("YAPPER_DIARIZE_START\n".utf8))
            let manager = OfflineDiarizerManager(config: .default)
            try await manager.prepareModels()
            let result = try await manager.process(file) { done, total in
                FileHandle.standardError.write(
                    Data("YAPPER_DIARIZE_PROGRESS \(done)/\(total)\n".utf8)
                )
            }
            let segments = result.segments.map {
                Segment(
                    speaker: $0.speakerId,
                    start: Double($0.startTimeSeconds),
                    end: Double($0.endTimeSeconds)
                )
            }
            try writePayload(segments)
        } catch OfflineDiarizationError.noSpeechDetected {
            do { try writePayload([]) } catch { fail(error.localizedDescription) }
        } catch {
            fail(error.localizedDescription)
        }
    }
}
