import Foundation

// The app ↔ daemon wire, mirroring packages/daemon/src/wire.ts:
//
//   [type: u8][length: u32 big-endian][payload: length bytes]
//
// type 1  JSON control message (UTF-8)
// type 2  microphone PCM16 mono 24 kHz, app → daemon
// type 3  speaker PCM16 mono 24 kHz, daemon → app

enum FrameType: UInt8 {
    case json = 1
    case mic = 2
    case speaker = 3
}

struct Frame {
    let type: UInt8
    let payload: Data
}

enum WireError: LocalizedError {
    case frameTooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .frameTooLarge(let n): return "frame of \(n) bytes exceeds the \(Wire.maxFrameBytes) byte cap"
        }
    }
}

enum Wire {
    static let maxFrameBytes = 16 * 1024 * 1024
    static let headerBytes = 5

    static func encode(type: FrameType, payload: Data) throws -> Data {
        guard payload.count <= maxFrameBytes else { throw WireError.frameTooLarge(payload.count) }
        var out = Data(capacity: headerBytes + payload.count)
        out.append(type.rawValue)
        let n = UInt32(payload.count)
        out.append(UInt8((n >> 24) & 0xff))
        out.append(UInt8((n >> 16) & 0xff))
        out.append(UInt8((n >> 8) & 0xff))
        out.append(UInt8(n & 0xff))
        out.append(payload)
        return out
    }

    static func encodeJSON(_ object: [String: Any]) throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: object, options: [])
        return try encode(type: .json, payload: body)
    }
}

/// Incremental decoder: feed it whatever the socket hands you, get back whole frames.
/// Throws on an oversized frame; the caller should drop the connection.
final class FrameDecoder {
    private var buffer = Data()

    func reset() { buffer.removeAll(keepingCapacity: false) }

    func push(_ chunk: Data) throws -> [Frame] {
        buffer.append(chunk)
        var frames: [Frame] = []
        var offset = 0
        while buffer.count - offset >= Wire.headerBytes {
            let type = buffer[buffer.startIndex + offset]
            let b1 = UInt32(buffer[buffer.startIndex + offset + 1])
            let b2 = UInt32(buffer[buffer.startIndex + offset + 2])
            let b3 = UInt32(buffer[buffer.startIndex + offset + 3])
            let b4 = UInt32(buffer[buffer.startIndex + offset + 4])
            let length = Int((b1 << 24) | (b2 << 16) | (b3 << 8) | b4)
            if length > Wire.maxFrameBytes { throw WireError.frameTooLarge(length) }
            let start = offset + Wire.headerBytes
            if buffer.count - start < length { break }
            let lo = buffer.startIndex + start
            let payload = Data(buffer[lo ..< lo + length])
            frames.append(Frame(type: type, payload: payload))
            offset = start + length
        }
        if offset > 0 {
            if offset >= buffer.count { buffer.removeAll(keepingCapacity: true) }
            else { buffer = Data(buffer[(buffer.startIndex + offset)...]) }
        }
        return frames
    }
}
