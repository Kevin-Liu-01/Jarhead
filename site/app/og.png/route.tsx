import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * /og.png, 1200 × 630, dark only, rendered once at build (`force-static`).
 *
 * The picture is two layers. Under: `public/og-field.png`, the dithered ink field with the
 * orb wearing `^ ^`, rendered by `scripts/make-og.mts` from the repo's own `scripts/dither.ts`
 * and committed (satori draws no dither). Over: the words, laid out here in Inter Medium,
 * the one static face satori can take (`app/og/Inter-Medium.ttf`, Inter 4.1, SIL OFL 1.1,
 * the licence at `app/fonts/LICENSE-Inter.txt`). The field is read at build and inlined
 * as a data URI, so the route needs no request of its own.
 *
 * Colours are literal here: an image has no `--jh-*` to read. They mirror the tokens:
 * `--jh-ink` under the field, `--jh-fg` / `--jh-fg-2` / `--jh-fg-3` in dark for the words.
 */

export const dynamic = "force-static";

const W = 1200;
const H = 630;

const INK = "#070707";
const FG = "#ffffff";
const FG_2 = "rgba(255,255,255,0.72)";
const FG_3 = "rgba(255,255,255,0.48)";

const WORDMARK = "Jarhead";
const LEAD = "A voice-first Mac assistant that uses the computer for you.";
const FOOT = "v2.0.0 · MIT · macOS 14+ · Apple silicon";

/** A Buffer's bytes as a standalone ArrayBuffer (satori's font type). */
function bytes(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// Literal paths, so the build traces these two files and nothing else.
const FIELD = `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "og-field.png")).toString("base64")}`;
const INTER_MEDIUM = bytes(readFileSync(join(process.cwd(), "app", "og", "Inter-Medium.ttf")));

export function GET(): ImageResponse {
  return new ImageResponse(
    <div style={{ width: W, height: H, display: "flex", position: "relative", background: INK, fontFamily: "Inter" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={FIELD} width={W} height={H} alt="" style={{ position: "absolute", top: 0, left: 0, width: W, height: H }} />
      <div style={{ position: "absolute", left: 600, top: 236, width: 520, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 96, lineHeight: 1, letterSpacing: "-0.03em", color: FG }}>{WORDMARK}</div>
        <div style={{ marginTop: 22, fontSize: 30, lineHeight: 1.3, letterSpacing: "-0.01em", color: FG_2 }}>{LEAD}</div>
        <div style={{ marginTop: 26, fontSize: 20, lineHeight: 1, letterSpacing: "0.01em", color: FG_3 }}>{FOOT}</div>
      </div>
    </div>,
    {
      width: W,
      height: H,
      fonts: [{ name: "Inter", data: INTER_MEDIUM, weight: 500, style: "normal" }],
    },
  );
}
