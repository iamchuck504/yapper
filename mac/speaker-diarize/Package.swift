// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "YapperSpeakerDiarizer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "speaker-diarize", targets: ["YapperSpeakerDiarizer"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.15.5"
        )
    ],
    targets: [
        .executableTarget(
            name: "YapperSpeakerDiarizer",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
