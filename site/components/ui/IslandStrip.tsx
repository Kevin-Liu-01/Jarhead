import Apple from "@thesvg/react/apple";
import { Icon } from "./Icons";

/**
 * A drawn menu-bar strip holding one island render at 1:1 (the PNGs are 920 × 500 at 2×, so 460 CSS
 * px). The strip's bar is the harness's own bar colour and the ground the blob's, so the render's
 * ground continues across the strip without a seam; the bar is drawn over the render's own (the
 * notch column, its fillets, the Apple mark, the app's name and the clock, the way the desk draws
 * them). Under 460 px of column the whole strip scales down as one (--s), never a fractional crop.
 * Unframed, as every inner panel of a figure (mr.css .mr-panel): its own ground against the raised card is the edge.
 */
export function IslandStrip({ src, alt, width, height, className }: { readonly src: string; readonly alt: string; readonly width: number; readonly height: number; readonly className?: string }) {
  return (
    <div className={`jh-strip-box${className ? ` ${className}` : ""}`}>
      <div className="jh-strip">
        <div className="jh-strip-bar" aria-hidden="true">
          <Apple variant="mono" className="jh-strip-apple" aria-hidden="true" focusable="false" />
          <span className="jh-strip-app">Jarhead</span>
          <span className="jh-strip-notch" />
          <span className="jh-strip-fillet jh-strip-fillet-l" />
          <span className="jh-strip-fillet jh-strip-fillet-r" />
          <span className="jh-strip-r">
            <span className="jh-strip-status" />
            <Icon.wifi size={16} className="jh-strip-glyph" />
            <Icon.battery size={18} className="jh-strip-glyph" />
            <span className="jh-strip-clock">Wed 24 Sep&ensp;12:37</span>
          </span>
        </div>
        <img className="jh-strip-img" src={src} alt={alt} width={width} height={height} decoding="async" loading="lazy" />
      </div>
    </div>
  );
}
