import Foundation

/// Where a float goes — pure geometry, in the root's coordinate space (origin top-left), so the
/// harness pins every case as a `check-kit` line. A `.below` float hangs under its anchor with
/// leading edges aligned and flips above when the space under it is short; a `.trailing` float
/// sits beside its anchor, top edges aligned, on the side with room (a right-rail row's card
/// lands over the stream). Both clamp inside `bounds` less the margin. `size == .zero` (not yet
/// measured) places at the preferred side so the first frame is near the final one.
enum ConsoleFloatPlacement {
    /// Anchor → float.
    static let gap: CGFloat = 4
    /// Float → window edge.
    static let margin: CGFloat = 8
    /// Every box is radius 6; the tip's arrow keeps `radius + 4` from a corner.
    static let radius: CGFloat = 6
    static let arrowWidth: CGFloat = 8
    static let arrowHeight: CGFloat = 4

    /// Which side the float ended on, so the arrow knows the facing edge.
    enum Side: Equatable { case below, above, trailing, leading }

    static func rect(anchor: CGRect, size: CGSize, bounds: CGRect, edge: ConsoleFloat.Edge) -> CGRect {
        switch edge {
        case .below: return place(anchor: anchor, size: size, bounds: bounds, side: side(anchor: anchor, size: size, bounds: bounds, edge: edge))
        case .trailing: return place(anchor: anchor, size: size, bounds: bounds, side: side(anchor: anchor, size: size, bounds: bounds, edge: edge))
        }
    }

    /// The side a float lands on: the preferred one unless it is short and the other has room.
    static func side(anchor: CGRect, size: CGSize, bounds: CGRect, edge: ConsoleFloat.Edge) -> Side {
        switch edge {
        case .below:
            let fitsBelow = anchor.maxY + gap + size.height + margin <= bounds.maxY
            let fitsAbove = anchor.minY - gap - size.height - margin >= bounds.minY
            return fitsBelow || !fitsAbove ? .below : .above
        case .trailing:
            let fitsTrailing = anchor.maxX + gap + size.width + margin <= bounds.maxX
            let fitsLeading = anchor.minX - gap - size.width - margin >= bounds.minX
            return fitsTrailing || !fitsLeading ? .trailing : .leading
        }
    }

    private static func place(anchor: CGRect, size: CGSize, bounds: CGRect, side: Side) -> CGRect {
        var x: CGFloat, y: CGFloat
        switch side {
        case .below: x = anchor.minX; y = anchor.maxY + gap
        case .above: x = anchor.minX; y = anchor.minY - gap - size.height
        case .trailing: x = anchor.maxX + gap; y = anchor.minY
        case .leading: x = anchor.minX - gap - size.width; y = anchor.minY
        }
        x = clamp(x, size.width, bounds.minX, bounds.maxX)
        y = clamp(y, size.height, bounds.minY, bounds.maxY)
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// Keep `[start, start + length]` inside `[lo + margin, hi − margin]`; the near edge wins when both fail.
    static func clamp(_ start: CGFloat, _ length: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
        max(lo + margin, min(start, hi - margin - length))
    }

    /// The arrow's centre along the facing edge, in the float's own space: it points at the
    /// anchor's centre and never comes nearer than `radius + 4` to a corner.
    static func arrowOffset(anchor: CGRect, rect: CGRect, side: Side) -> CGFloat {
        let inset = radius + 4
        switch side {
        case .below, .above:
            return min(max(anchor.midX - rect.minX, inset), max(inset, rect.width - inset))
        case .trailing, .leading:
            return min(max(anchor.midY - rect.minY, inset), max(inset, rect.height - inset))
        }
    }

    /// The bounds a float may use under a `fullSizeContentView` title bar: the root starts at y = 0 but the
    /// traffic lights own the first `band` points, so the layer and a field's `listMax` both start there —
    /// a popup flipped `.above` shrinks (its list scrolls) instead of climbing into the chrome.
    static func insetTop(_ bounds: CGRect, by band: CGFloat) -> CGRect {
        let band = min(max(0, band), bounds.height)
        return CGRect(x: bounds.minX, y: bounds.minY + band, width: bounds.width, height: bounds.height - band)
    }

    /// How tall a `.below` list may grow before it scrolls: the room on its side of the anchor.
    static func maxListHeight(anchor: CGRect, bounds: CGRect, side: Side) -> CGFloat {
        switch side {
        case .below, .trailing: return max(0, bounds.maxY - anchor.maxY - gap - margin)
        case .above, .leading: return max(0, anchor.minY - bounds.minY - gap - margin)
        }
    }
}
