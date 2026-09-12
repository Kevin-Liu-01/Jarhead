// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Jarhead",
    platforms: [.macOS(.v14)],
    targets: [
        // Objective-C shim: `JHTry` catches the NSExceptions AVFoundation raises (a tap on a
        // stale format, a player started on a stopped engine) so Swift can log and retry
        // instead of the process aborting. Public header in include/, module map alongside.
        .target(
            name: "JarheadObjC",
            path: "Sources/JarheadObjC"
        ),
        .executableTarget(
            name: "Jarhead",
            dependencies: ["JarheadObjC"],
            path: "Sources/Jarhead",
            swiftSettings: [.unsafeFlags(["-Onone"], .when(configuration: .debug))]
        ),
    ]
)
