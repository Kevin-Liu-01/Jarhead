import CommonCrypto
import Foundation
import LocalAuthentication

/// Authentication for the wake word gate. Two independent factors, both local:
///
/// * **Device owner** — LocalAuthentication's `.deviceOwnerAuthentication`: Touch ID,
///   an unlocked Apple Watch, or the Mac's login password, through the system sheet.
/// * **Passphrase** — a phrase Kevin says (or types). Stored as PBKDF2-HMAC-SHA256
///   (200 000 rounds, 16-byte salt) in `~/.jarhead/wake-auth.json` with mode 0600;
///   the plaintext is never written. Speech is normalised (lowercase, letters and
///   digits only, single spaces) before hashing, on enrolment and on verification,
///   so "Open, Sesame!" and "open sesame" are the same phrase.
enum LocalAuth {
    // MARK: device owner

    static func ownerAuthAvailable() -> Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    /// "Touch ID", "Apple Watch", or "your password" — for the spoken prompt.
    static func ownerAuthName() -> String {
        let ctx = LAContext()
        var error: NSError?
        if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            switch ctx.biometryType {
            case .touchID: return "Touch ID"
            case .faceID: return "Face ID"
            case .opticID: return "Optic ID"
            default: break
            }
        }
        if #available(macOS 15.0, *) {
            if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithCompanion, error: &error) { return "Apple Watch" }
        }
        return "your password"
    }

    /// One system authentication sheet. `evaluate` resolves false on cancel, failure,
    /// or when no policy is available; `cancel()` dismisses the sheet (timeout, or
    /// the passphrase won first).
    final class OwnerAuth: @unchecked Sendable {
        private let ctx = LAContext()
        private let lock = NSLock()
        private var finished = false

        init() { ctx.localizedCancelTitle = "Not now" }

        func evaluate(reason: String) async -> Bool {
            var error: NSError?
            guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
            return await withCheckedContinuation { cont in
                ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] ok, _ in
                    self?.markFinished()
                    cont.resume(returning: ok)
                }
            }
        }

        private func markFinished() {
            lock.lock(); finished = true; lock.unlock()
        }

        func cancel() {
            lock.lock(); let done = finished; lock.unlock()
            if !done { ctx.invalidate() }
        }
    }

    // MARK: passphrase

    static let minimumPassphraseLength = 6
    /// Two words at least: the spoken verifier waits for that many words before it
    /// judges an answer, so a single stray word — or the gate's own "Password?" coming
    /// back through the microphone — can never be an attempt.
    static let minimumPassphraseWords = 2
    static let rounds: UInt32 = 200_000

    private struct Record: Codable {
        var salt: String    // base64
        var hash: String    // base64, 32 bytes
        var rounds: UInt32
        var words: Int      // how many words the phrase has (bounds the spoken match window)
    }

    static var fileURL: URL {
        let env = ProcessInfo.processInfo.environment
        let dir = env["JARHEAD_STATE_DIR"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead")
        return dir.appendingPathComponent("wake-auth.json")
    }

    static var hasPassphrase: Bool { load() != nil }

    /// Word count of the enrolled phrase, 0 when none. Lets the spoken verifier try
    /// the last N words rather than every suffix.
    static var passphraseWords: Int { load()?.words ?? 0 }

    /// Lowercase; letters, digits and spaces only; single spaces; trimmed.
    static func normalize(_ text: String) -> String {
        var out = ""
        var lastSpace = true
        for scalar in text.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                out.unicodeScalars.append(scalar)
                lastSpace = false
            } else if !lastSpace {
                out.append(" ")
                lastSpace = true
            }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    enum PassphraseError: Error, LocalizedError {
        case tooShort
        case derivationFailed
        var errorDescription: String? {
            switch self {
            case .tooShort: return "Use a phrase of at least \(minimumPassphraseWords) words and \(minimumPassphraseLength) letters."
            case .derivationFailed: return "Could not hash the passphrase (key derivation failed); nothing was saved."
            }
        }
    }

    static func setPassphrase(_ phrase: String) throws {
        let normalized = normalize(phrase)
        let words = normalized.split(separator: " ").count
        guard words >= minimumPassphraseWords, normalized.count >= minimumPassphraseLength else { throw PassphraseError.tooShort }
        var salt = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, salt.count, &salt) == errSecSuccess else {
            throw NSError(domain: "Jarhead.LocalAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: "no random bytes"])
        }
        let hash = derive(normalized, salt: salt, rounds: rounds)
        // Never enrol an empty hash: verify() would fail closed forever while the UI said "set".
        guard hash.count == 32 else { throw PassphraseError.derivationFailed }
        let record = Record(salt: Data(salt).base64EncodedString(), hash: Data(hash).base64EncodedString(), rounds: rounds, words: words)
        let data = try JSONEncoder().encode(record)
        try writePrivately(data, to: fileURL)
    }

    /// 0600 from the first byte: the record is created as a private temp file next to
    /// its destination (`open` with mode 0600, O_EXCL) and renamed over it, so there is
    /// no window in which the umask decides who can read the hash. A directory this
    /// creates is 0700; an existing one is left as it is.
    private static func writePrivately(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(tmp.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0 else { throw posixError("could not create \(tmp.path)") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? fm.removeItem(at: tmp)
            throw error
        }
        guard rename(tmp.path, url.path) == 0 else {
            let err = posixError("could not replace \(url.path)")
            try? fm.removeItem(at: tmp)
            throw err
        }
    }

    private static func posixError(_ what: String) -> NSError {
        let code = errno
        return NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSLocalizedDescriptionKey: "\(what): \(String(cString: strerror(code)))"])
    }

    static func clearPassphrase() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Constant-time comparison against the stored hash. ~100 ms of PBKDF2; call off
    /// the main thread when latency matters.
    static func verify(_ phrase: String) -> Bool {
        guard let record = load(), let salt = Data(base64Encoded: record.salt), let stored = Data(base64Encoded: record.hash) else { return false }
        let candidate = derive(normalize(phrase), salt: [UInt8](salt), rounds: record.rounds)
        guard candidate.count == stored.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(candidate, stored) { diff |= a ^ b }
        return diff == 0
    }

    // MARK: helpers

    private static func load() -> Record? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private static func derive(_ phrase: String, salt: [UInt8], rounds: UInt32) -> [UInt8] {
        var key = [UInt8](repeating: 0, count: 32)
        let password = Array(phrase.utf8)
        let status = password.withUnsafeBufferPointer { pw in
            salt.withUnsafeBufferPointer { s in
                key.withUnsafeMutableBufferPointer { k in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pw.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) }, pw.count,
                        s.baseAddress, s.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds,
                        k.baseAddress, k.count)
                }
            }
        }
        return status == kCCSuccess ? key : []
    }
}
