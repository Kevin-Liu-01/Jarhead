// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Jarhead",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Jarhead",
            path: "Sources/Jarhead",
            swiftSettings: [.unsafeFlags(["-Onone"], .when(configuration: .debug))]
        ),
    ]
)
