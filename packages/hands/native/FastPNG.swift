import Foundation
import CoreGraphics
import zlib

// MARK: - Fast PNG encoder for opaque 32-bit screen captures.
//
// ImageIO/NSBitmapImageRep encodes a 3.75-megapixel RGBA capture in ~140 ms, which is most of
// the screenshot budget. This encoder writes 8-bit RGB (alpha dropped: screen captures are
// opaque), filters rows with PNG "Up", and deflates in parallel strips pigz-style: every strip
// is an independent raw-deflate run ended with a full flush (byte-aligned, no final block), so
// the concatenation is one valid deflate stream; the last strip carries the final block.

enum FastPNG {
    struct ChannelLayout {
        let r: Int
        let g: Int
        let b: Int
    }

    /// Byte offsets of R, G, B within each 32-bit pixel, or nil for unsupported formats.
    static func channelLayout(of image: CGImage) -> ChannelLayout? {
        guard image.bitsPerPixel == 32, image.bitsPerComponent == 8 else { return nil }
        let order = image.bitmapInfo.rawValue & CGBitmapInfo.byteOrderMask.rawValue
        let little = order == CGBitmapInfo.byteOrder32Little.rawValue
        guard little || order == CGBitmapInfo.byteOrder32Big.rawValue || order == 0 else { return nil }
        let alphaFirst: Bool
        switch image.alphaInfo {
        case .premultipliedFirst, .first, .noneSkipFirst: alphaFirst = true
        case .premultipliedLast, .last, .noneSkipLast: alphaFirst = false
        default: return nil
        }
        // Word order (most significant byte first) is ARGB or RGBA; little-endian memory reverses it.
        if alphaFirst {
            return little ? ChannelLayout(r: 2, g: 1, b: 0) : ChannelLayout(r: 1, g: 2, b: 3)
        }
        return little ? ChannelLayout(r: 3, g: 2, b: 1) : ChannelLayout(r: 0, g: 1, b: 2)
    }

    private struct Strip {
        var deflated = [UInt8]()
        var adler: uLong = 1
        var rawLength = 0
        var ok = false
    }

    /// Returns nil when the image format is unsupported or zlib fails; callers fall back to ImageIO.
    static func encode(_ image: CGImage, level: Int32 = Z_BEST_SPEED) -> Data? {
        guard let layout = channelLayout(of: image),
              let provider = image.dataProvider,
              let cfData = provider.data,
              let base = CFDataGetBytePtr(cfData) else { return nil }
        let width = image.width
        let height = image.height
        let stride = image.bytesPerRow
        guard width > 0, height > 0, stride >= width * 4, CFDataGetLength(cfData) >= stride * height else { return nil }

        let rowBytes = 1 + width * 3
        let cores = clamp(ProcessInfo.processInfo.activeProcessorCount, 1, 16)
        let stripCount = clamp(height / 32, 1, cores)
        let rowsPerStrip = (height + stripCount - 1) / stripCount

        var strips = [Strip](repeating: Strip(), count: stripCount)
        strips.withUnsafeMutableBufferPointer { stripsBuffer in
            DispatchQueue.concurrentPerform(iterations: stripCount) { index in
                let firstRow = index * rowsPerStrip
                let lastRow = min(height, firstRow + rowsPerStrip)
                guard firstRow < lastRow else { return }

                var raw = [UInt8](repeating: 0, count: (lastRow - firstRow) * rowBytes)
                raw.withUnsafeMutableBufferPointer { rawBuffer in
                    guard var out = rawBuffer.baseAddress else { return }
                    for y in firstRow..<lastRow {
                        let row = base + y * stride
                        out.pointee = 2 // PNG filter type "Up"
                        out += 1
                        if y == 0 {
                            var p = row
                            for _ in 0..<width {
                                out[0] = p[layout.r]
                                out[1] = p[layout.g]
                                out[2] = p[layout.b]
                                out += 3
                                p += 4
                            }
                        } else {
                            var p = row
                            var q = row - stride
                            for _ in 0..<width {
                                out[0] = p[layout.r] &- q[layout.r]
                                out[1] = p[layout.g] &- q[layout.g]
                                out[2] = p[layout.b] &- q[layout.b]
                                out += 3
                                p += 4
                                q += 4
                            }
                        }
                    }
                }

                var strip = Strip()
                strip.rawLength = raw.count
                var stream = z_stream()
                guard deflateInit2_(&stream, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY,
                                    ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return }
                defer { deflateEnd(&stream) }
                let bound = Int(deflateBound(&stream, uLong(raw.count))) + 64
                var output = [UInt8](repeating: 0, count: bound)
                let flush = index == stripCount - 1 ? Z_FINISH : Z_FULL_FLUSH
                var produced = 0
                var status: Int32 = Z_OK
                raw.withUnsafeMutableBufferPointer { rawBuffer in
                    output.withUnsafeMutableBufferPointer { outBuffer in
                        stream.next_in = rawBuffer.baseAddress
                        stream.avail_in = uInt(rawBuffer.count)
                        stream.next_out = outBuffer.baseAddress
                        stream.avail_out = uInt(outBuffer.count)
                        status = deflate(&stream, flush)
                        produced = outBuffer.count - Int(stream.avail_out)
                    }
                    strip.adler = adler32(1, rawBuffer.baseAddress, uInt(rawBuffer.count))
                }
                let expected = flush == Z_FINISH ? Z_STREAM_END : Z_OK
                guard status == expected, stream.avail_in == 0 else { return }
                output.removeSubrange(produced...)
                strip.deflated = output
                strip.ok = true
                stripsBuffer[index] = strip
            }
        }
        guard strips.allSatisfy({ $0.ok }) else { return nil }

        var idat = Data(capacity: strips.reduce(6) { $0 + $1.deflated.count })
        idat.append(contentsOf: [0x78, 0x01]) // zlib header: deflate, 32K window, fastest
        var adler = strips[0].adler
        for (index, strip) in strips.enumerated() {
            idat.append(contentsOf: strip.deflated)
            if index > 0 { adler = adler32_combine(adler, strip.adler, strip.rawLength) }
        }
        appendUInt32BE(&idat, UInt32(truncatingIfNeeded: adler))

        var ihdr = Data(capacity: 13)
        appendUInt32BE(&ihdr, UInt32(width))
        appendUInt32BE(&ihdr, UInt32(height))
        ihdr.append(contentsOf: [8, 2, 0, 0, 0]) // 8-bit, truecolor RGB, deflate, adaptive filters, no interlace

        var png = Data(capacity: idat.count + 128)
        png.append(contentsOf: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        appendChunk(&png, type: "IHDR", body: ihdr)
        appendChunk(&png, type: "sRGB", body: Data([0])) // perceptual rendering intent
        appendChunk(&png, type: "IDAT", body: idat)
        appendChunk(&png, type: "IEND", body: Data())
        return png
    }

    private static func appendUInt32BE(_ data: inout Data, _ value: UInt32) {
        data.append(contentsOf: [UInt8(value >> 24), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
    }

    private static func appendChunk(_ png: inout Data, type: String, body: Data) {
        let typeBytes = Array(type.utf8)
        appendUInt32BE(&png, UInt32(body.count))
        png.append(contentsOf: typeBytes)
        png.append(body)
        var crc = typeBytes.withUnsafeBufferPointer { crc32(0, $0.baseAddress, uInt($0.count)) }
        body.withUnsafeBytes { buffer in
            if let ptr = buffer.baseAddress, buffer.count > 0 {
                crc = crc32(crc, ptr.assumingMemoryBound(to: UInt8.self), uInt(buffer.count))
            }
        }
        appendUInt32BE(&png, UInt32(truncatingIfNeeded: crc))
    }
}
