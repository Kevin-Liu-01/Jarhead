/**
 * The blob's resting stills, rendered once at build from the orb engine (lib/orb.ts): the PNG a character's host shows
 * before its first live frame and without JS. Three faces: awake (`O O`, the listening halo), happy (`^ ^`, the speaking
 * halo) and quiet (the titanium ramp, its lids closed `- -` as the live blob's are asleep, the asleep halo). 480 px
 * square in 3 px cells, so a 240 px host shows them at 2x in 1.5 px cells; the disc is a third of the side less its
 * halo, as the live blob draws it. The halo's colour is read from the token sheet itself (app/globals.css), so the stills
 * and the live blob share one source. Server-only. The face's drawing is versioned in the URLs (components/desk/Character.tsx).
 */
import { deflateSync } from "node:zlib";
import { QUIET_STOPS, parseColor, type RGB } from "@/lib/dither";
import { encodePng, renderOrb, type Face } from "@/lib/orb";
import { token as sheet } from "@/lib/tokens";

type Still = "awake" | "happy" | "quiet";

/** A phase tone as the token sheet declares it (the phase tones are the same in both themes). */
const token = (name: `--jh-${string}`): RGB => parseColor(sheet(name));

/** The halo per still: the phase tone (--jh-listening, --jh-speaking, --jh-asleep) and its glow. */
const LOOK: Record<Still, { readonly face: Face; readonly token: `--jh-${string}`; readonly glow: number; readonly quiet: boolean }> = {
  awake: { face: "OO", token: "--jh-listening", glow: 0.6, quiet: false },
  happy: { face: "^^", token: "--jh-speaking", glow: 0.65, quiet: false },
  quiet: { face: "--", token: "--jh-asleep", glow: 0.3, quiet: true },
};

const SIZE = 480;

export function stillResponse(kind: Still): Response {
  const l = LOOK[kind];
  const img = renderOrb({ size: SIZE, cell: 3, face: l.face, stops: l.quiet ? QUIET_STOPS : undefined, halo: { color: token(l.token), glow: l.glow, backing: null } });
  const png = encodePng(img, (raw) => new Uint8Array(deflateSync(raw, { level: 9 })));
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  // Not immutable: the URL carries no hash, so a re-rendered still must reach a returning visitor within the day.
  return new Response(body, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } });
}
