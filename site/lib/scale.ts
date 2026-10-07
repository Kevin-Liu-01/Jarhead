/**
 * The island's scale inputs, written as plain numbers on <html> (styles/site.css reads them). The stylesheet keeps its own
 * derivations as the fallback for a page without script: `tan(atan2(100vw - 24px, 420px))` turns a length into a ratio.
 * WebKit on iOS (every iOS browser; measured on iOS 26.5, 2026-10-06) gets that wrong for a relative length: it reads
 * atan2's degrees as radians, so `tan(atan2(100vw, 100px))` came out 0.73 at 402 px instead of 4.02. Its result swings
 * with the width: too small, negative or too large. On a phone about 430 px wide the island shrank to a 20 px sliver with
 * "Liste" spilling out of it and the hero rode up under the bar; at 375 it was drawn at 1.0, wider than the screen.
 * So the ratios come from here, out of the trig: a probe 100vw wide and 100svh tall is laid out for one synchronous read
 * and removed, so each number is the length the stylesheet means, measured by layout, which iOS gets right.
 *
 *   --fit-s    (100vw - 24px) / 420px   the island with a 12 px gutter each side
 *   --phone-s  (100vw - 112px) / 420px  at 581 to 720 px: room left for a 40 px item, its 4 px and an ear each side
 *   --tall-s   100svh / 1100px          the hero's share of a short screen (site.css clamps it)
 *
 * The first read runs in <head>, before <body> exists and before anything paints; then again on resize, orientationchange
 * and pageshow (components/site/Top.tsx follows its probes when these move them). 100svh holds still while a phone's
 * toolbars come and go, so the hero never breathes as the page scrolls. Without a reading (a browser with no svh) the
 * width falls back to innerWidth and the height to the smaller of innerHeight and clientHeight. Six decimals, so a ratio
 * lands where the trig would have put it (four tipped 184 px × 0.8182 across a 1/64 px step in Chromium); each is floored
 * at 0.3, so no reading collapses the island.
 */
export const SCALE_BOOT = `(function(){try{var d=document.documentElement;function f(n){return Math.max(0.3,n).toFixed(6)}function set(){var e=document.createElement("div"),r;e.style.cssText="position:absolute;left:0;top:0;width:100vw;height:100svh;visibility:hidden;pointer-events:none";d.appendChild(e);r=e.getBoundingClientRect();d.removeChild(e);var w=r.width>0?r.width:(innerWidth||d.clientWidth),h=r.height>0?r.height:Math.min(innerHeight||d.clientHeight,d.clientHeight||innerHeight);if(!(w>0))return;var s=d.style;s.setProperty("--fit-s",f((w-24)/420));s.setProperty("--phone-s",f((w-112)/420));if(h>0)s.setProperty("--tall-s",f(h/1100))}set();addEventListener("resize",set);addEventListener("orientationchange",set);addEventListener("pageshow",set)}catch(e){}})();`;
