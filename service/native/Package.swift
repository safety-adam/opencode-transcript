// swift-tools-version:6.0
import PackageDescription

// Native capture and speech to text for opencode-transcript.
//
// The binary reads system audio (and the mic) with ScreenCaptureKit, streams it
// through WhisperKit, and prints one JSON object per line on stdout. The Node
// service in ../server.mjs owns the process and turns that stream into the
// transcript the plugin shows.
//
// Build with the full Xcode toolchain. The Command Line Tools toolchain lacks
// the SwiftUI macros plugin and fails on WhisperKit's dependencies.
let package = Package(
    name: "transcript-capture",
    // macOS 15 or later. It has the clean "System Audio Recording Only"
    // permission flow that the process tap relies on.
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", from: "0.10.0"),
        // Pin swift-collections to 1.5.0. Newer releases use stdlib features
        // (Iterable, Span) that do not compile with the current Xcode toolchain,
        // and WhisperKit pulls swift-collections in transitively. 1.5.0 is the
        // version known to build here.
        .package(url: "https://github.com/apple/swift-collections.git", exact: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "transcript-capture",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
            ],
            path: "Sources/transcript-capture",
            exclude: ["Info.plist"],
            swiftSettings: [
                // Keep Swift 5 language semantics. The capture code uses signal
                // handlers and non Sendable captures that do not fit the v6 model.
                .swiftLanguageMode(.v5),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/transcript-capture/Info.plist",
                ])
            ]
        )
    ]
)
