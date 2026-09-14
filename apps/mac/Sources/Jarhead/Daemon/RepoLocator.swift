import Foundation

/// Where the TypeScript half of Jarhead lives and how to run it.
struct RepoLocation {
    /// Repo root (the package.json named "jarhead").
    let repo: URL
    /// Node binary used to run the daemon.
    let node: URL
    /// `<repo>/node_modules/tsx/dist/cli.mjs`
    let tsx: URL
    /// `<repo>/packages/daemon/src/main.ts`
    let daemon: URL
    /// The hands helper shipped inside the bundle, when running from one. The daemon
    /// gets it as JARHEAD_HANDS_BIN so the helper runs under the app's TCC identity.
    let handsBin: URL?
    /// True when launched from Jarhead.app (as opposed to `swift build`).
    let fromBundle: Bool
}

enum RepoLocatorError: LocalizedError {
    case repoNotFound(String)
    case nodeNotFound(String)
    case missing(String)

    var errorDescription: String? {
        switch self {
        case .repoNotFound(let why): return "repo not found: \(why). Set JARHEAD_REPO=/path/to/checkout."
        case .nodeNotFound(let why): return "node not found: \(why). Set JARHEAD_NODE=/path/to/node."
        case .missing(let path): return "missing \(path). Run pnpm install in the repo."
        }
    }
}

enum RepoLocator {
    private struct BundleManifest: Decodable {
        var repo: String
        var node: String?
        var tsx: String?
        var daemon: String?
    }

    static func locate() throws -> RepoLocation {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let bundleURL = Bundle.main.bundleURL
        let fromBundle = bundleURL.pathExtension == "app"

        var manifest: BundleManifest?
        if fromBundle, let url = Bundle.main.url(forResource: "jarhead", withExtension: "json"),
           let data = try? Data(contentsOf: url) {
            manifest = try? JSONDecoder().decode(BundleManifest.self, from: data)
        }

        // 1. Repo root.
        let repo: URL
        var overridden = false
        if let override = env["JARHEAD_REPO"], !override.isEmpty {
            repo = URL(fileURLWithPath: (override as NSString).expandingTildeInPath).standardizedFileURL
            overridden = true
        } else if let m = manifest {
            repo = URL(fileURLWithPath: m.repo).standardizedFileURL
        } else if let found = walkUpForRepo(from: Bundle.main.executableURL) {
            repo = found
        } else {
            throw RepoLocatorError.repoNotFound("no package.json named \"jarhead\" above \(Bundle.main.executableURL?.path ?? "the executable")")
        }
        guard fm.fileExists(atPath: repo.appendingPathComponent("package.json").path) else {
            throw RepoLocatorError.repoNotFound("\(repo.path) has no package.json")
        }

        // 2. Node.
        let node = try locateNode(env: env, manifest: manifest)

        // 3. tsx + daemon entry. A JARHEAD_REPO override means "run that checkout", so
        //    the paths baked into the bundle's manifest must not win over it.
        let manifestPaths = overridden ? nil : manifest
        let tsx = manifestPaths?.tsx.map { URL(fileURLWithPath: $0) } ?? repo.appendingPathComponent("node_modules/tsx/dist/cli.mjs")
        let daemon = manifestPaths?.daemon.map { URL(fileURLWithPath: $0) } ?? repo.appendingPathComponent("packages/daemon/src/main.ts")
        guard fm.fileExists(atPath: tsx.path) else { throw RepoLocatorError.missing(tsx.path) }
        guard fm.fileExists(atPath: daemon.path) else { throw RepoLocatorError.missing(daemon.path) }

        // 4. Bundled hands helper.
        var hands: URL?
        if fromBundle {
            let candidate = bundleURL.appendingPathComponent("Contents/MacOS/jarhead-hands")
            if fm.isExecutableFile(atPath: candidate.path) { hands = candidate }
        }

        return RepoLocation(repo: repo, node: node, tsx: tsx, daemon: daemon, handsBin: hands, fromBundle: fromBundle)
    }

    /// The checkout this binary was built in (the package.json named "jarhead" above the
    /// executable), without touching node; nil from an installed bundle or a stray binary.
    static func repoRoot() -> URL? { walkUpForRepo(from: Bundle.main.executableURL) }

    // MARK: - helpers

    private static func walkUpForRepo(from start: URL?) -> URL? {
        guard var dir = start?.deletingLastPathComponent().standardizedFileURL else { return nil }
        for _ in 0 ..< 12 {
            let pkg = dir.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: pkg),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["name"] as? String == "jarhead" {
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    private static func locateNode(env: [String: String], manifest: BundleManifest?) throws -> URL {
        let fm = FileManager.default
        var tried: [String] = []
        func ok(_ path: String?) -> URL? {
            guard let path, !path.isEmpty else { return nil }
            let expanded = (path as NSString).expandingTildeInPath
            tried.append(expanded)
            return fm.isExecutableFile(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
        }
        if let u = ok(env["JARHEAD_NODE"]) { return u }
        if let u = ok(manifest?.node) { return u }
        if let u = ok(newestNvmNode()) { return u }
        if let u = ok(whichNode()) { return u }
        if let u = ok("/opt/homebrew/bin/node") { return u }
        if let u = ok("/usr/local/bin/node") { return u }
        throw RepoLocatorError.nodeNotFound("tried \(tried.joined(separator: ", "))")
    }

    /// Highest-versioned node under ~/.nvm, if any.
    private static func newestNvmNode() -> String? {
        let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: base.path) else { return nil }
        let sorted = names.filter { $0.hasPrefix("v") }.sorted { a, b in
            a.compare(b, options: .numeric) == .orderedDescending
        }
        return sorted.first.map { base.appendingPathComponent("\($0)/bin/node").path }
    }

    /// `which node` through a login shell so nvm/homebrew PATH setup applies.
    private static func whichNode() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if p.isRunning { p.terminate(); return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }
}
