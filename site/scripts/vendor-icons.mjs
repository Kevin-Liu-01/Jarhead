#!/usr/bin/env node
/**
 * Vendors the page's icons: Phosphor Icons 2.1.1, the Fill weight (MIT, components/icons/LICENSE-Phosphor.txt), as path
 * data. Each icon is fetched byte for byte from jsDelivr (@phosphor-icons/core/assets/fill/<file>-fill.svg), its single
 * <path d> kept unmodified, and written to components/icons/paths.ts with what it means where it stands. No package is
 * installed. To add an icon: add a row to USED (the site's camelCase name, Phosphor's file name, its meaning on the page),
 * run `node scripts/vendor-icons.mjs` from site/, and use it; a row nothing imports is dead weight, so remove it.
 *
 * The island's tool keys draw the app's SF Symbols, and Phosphor has three of them in no form that reads as the app's at
 * 9 to 12 px (its pencil-circle is an upright pencil in a ring, a circled "A"; its question mark is a disc; its tiles are
 * four). Those three are COMPOSED below on Phosphor's 256 box from Phosphor's own parts (fetched the same way) and plain
 * geometry on its grid (its 16-unit corners), each with the SF Symbol it draws.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.1.1";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "components", "icons", "paths.ts");

/** [site name, Phosphor file, what it means where it stands] */
const USED = [
  // the diagrams
  ["lightning", "lightning", "the reflex: an unambiguous command runs at once (Say, Numbers)"],
  ["gearSix", "gear-six", "Say: Settings, where you pick the brain"],
  ["key", "key", "a key: a brain on your own API key (Say); the OpenAI key (Install)"],
  ["laptop", "laptop", "a model on this Mac: the local brain (Say, Costs)"],
  ["checkCircle", "check-circle", "done: the brain in use, a thread done, a copy made"],
  ["cursorClick", "cursor-click", "the hands click the control they found (Say, Hands)"],
  ["playCircle", "play-circle", "Rails: run, the call goes ahead"],
  ["handPalm", "hand-palm", "asks: Rails' confirm, a thread that asks, the island's question"],
  ["prohibit", "prohibit", "Rails: refuse, the call never runs"],
  ["paperPlaneTilt", "paper-plane-tilt", "send: Rails' example call and its first verb"],
  ["creditCard", "credit-card", "Rails: pay"],
  ["trash", "trash", "Rails: delete"],
  ["megaphoneSimple", "megaphone-simple", "Rails: post"],
  ["shoppingCartSimple", "shopping-cart-simple", "Rails: purchase"],
  ["speakerHigh", "speaker-high", "Numbers: the voice reply"],
  ["brain", "brain", "the brain: Numbers' model rows; Install's signed-in brain"],
  ["fingerprint", "fingerprint", "Wake: Touch ID"],
  ["watch", "watch", "Wake: Apple Watch"],
  ["password", "password", "Wake: the Mac password"],
  ["keyboard", "keyboard", "Wake: a passphrase, typed"],
  ["tag", "tag", "Hands: a control found by its label"],
  ["camera", "camera", "Hands: the screenshot that verifies"],
  ["timer", "timer", "Sleep: timers"],
  ["eye", "eye", "Sleep: watchers"],
  ["repeat", "repeat", "Sleep: routines"],
  // the playable demos
  ["arrowCounterClockwise", "arrow-counter-clockwise", "a demo: Replay"],
  ["lockOpen", "lock-open", "Wake: the gate opened, granted"],
  // the section lines
  ["lock", "lock", "Wake: the gate locks"],
  ["userSound", "user-sound", "Wake: a speaker's voice"],
  ["toolbox", "toolbox", "Say: the same tools for every brain"],
  ["scribbleLoop", "scribble-loop", "Hands: circle anything"],
  ["crosshair", "crosshair", "Hands: where the hands act"],
  ["monitor", "monitor", "Rails: on-screen text"],
  ["alarm", "alarm", "Sleep: a fire time"],
  ["power", "power", "Sleep: quit"],
  ["coins", "coins", "Costs: a plan that pays"],
  // the island, the bar, Install, the Console window
  ["play", "play", "the island: Go"],
  ["pause", "pause", "the island: Pause"],
  ["stop", "stop", "the island: Stop"],
  ["microphone", "microphone", "the island: Mute"],
  ["browser", "browser", "the island: Window (the app's rectangle.inset.filled)"],
  ["moon", "moon", "asleep: the island's Sleep tile and asleep line"],
  ["star", "star", "the GitHub star count"],
  ["circleHalf", "circle-half", "the bar: the theme"],
  ["copy", "copy", "Install: Copy"],
  ["certificate", "certificate", "Install: the Code Signing certificate"],
];

/** One Phosphor Fill icon's path data, byte for byte. */
async function phosphor(file) {
  const url = `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@${VERSION}/assets/fill/${file}-fill.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: ${res.status} from ${url}`);
  const svg = await res.text();
  const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length !== 1) throw new Error(`${file}: expected one path, found ${ds.length}`);
  return ds[0];
}

/** A number for path data: two decimals at most, no trailing zeros. */
const num = (v) => String(Number(v.toFixed(2)));

/**
 * Path data scaled by `s` about the origin and moved by (tx, ty), written absolute (M L H V C S Q T A Z), so any of its
 * subpaths stands alone. Arcs keep their flags; their radii scale with the rest.
 */
function place(d, s, tx, ty) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const X = (x) => num(s * x + tx);
  const Y = (y) => num(s * y + ty);
  const out = [];
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const n = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd !== cmd.toUpperCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    if (C === "Z") {
      out.push("Z");
      cx = sx;
      cy = sy;
    } else if (C === "M" || C === "L" || C === "T") {
      const x = n() + ox;
      const y = n() + oy;
      out.push(`${C}${X(x)},${Y(y)}`);
      [cx, cy] = [x, y];
      if (C === "M") {
        [sx, sy] = [x, y];
        cmd = rel ? "l" : "L";
      }
    } else if (C === "H") {
      cx = n() + ox;
      out.push(`H${X(cx)}`);
    } else if (C === "V") {
      cy = n() + oy;
      out.push(`V${Y(cy)}`);
    } else if (C === "C" || C === "S" || C === "Q") {
      const k = C === "C" ? 3 : 2;
      const pts = [];
      for (let j = 0; j < k; j++) pts.push([n() + ox, n() + oy]);
      out.push(C + pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(","));
      [cx, cy] = pts[k - 1];
    } else if (C === "A") {
      const [rx, ry, rot, large, sweep] = [n(), n(), n(), n(), n()];
      const x = n() + ox;
      const y = n() + oy;
      out.push(`A${num(rx * s)},${num(ry * s)},${rot},${large},${sweep},${X(x)},${Y(y)}`);
      [cx, cy] = [x, y];
    } else throw new Error(`place: unexpected ${cmd}`);
  }
  return out.join("");
}

/** A rounded rect, clockwise, as Phosphor draws its tiles (16-unit corners). */
function tile(x0, y0, x1, y1, r = 16) {
  return `M${num(x0 + r)},${num(y0)}H${num(x1 - r)}A${r},${r},0,0,1,${num(x1)},${num(y0 + r)}V${num(y1 - r)}A${r},${r},0,0,1,${num(x1 - r)},${num(y1)}H${num(x0 + r)}A${r},${r},0,0,1,${num(x0)},${num(y1 - r)}V${num(y0 + r)}A${r},${r},0,0,1,${num(x0 + r)},${num(y0)}Z`;
}

/**
 * pencil.and.outline: a ring open at its upper right (centre (120, 136), 22 thick about a radius of 84, round ends, the gap
 * 31 degrees either side of the 45-degree diagonal, so about 300 degrees of arc) and a pencil on that diagonal crossing the
 * gap: its point just past the ring's centre, its body 36 wide, its end rounded beyond the ring, 14 units clear of the
 * ring's ends on both sides. Both a step heavier than Phosphor's 16-unit line, as SF's symbol is at 11 pt; the pencil is
 * solid: at 9 to 12 px a knocked-out band only greys it.
 */
function pencilOutline() {
  const [cx, cy, mid, half] = [120, 136, 84, 11];
  const gap = (31 * Math.PI) / 180;
  const axis = -Math.PI / 4;
  const at = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const p = ([x, y]) => `${num(x)},${num(y)}`;
  const a1 = axis + gap;
  const a2 = axis - gap;
  const ring = `M${p(at(a1, mid + half))}A${mid + half},${mid + half},0,1,1,${p(at(a2, mid + half))}A${half},${half},0,0,1,${p(at(a2, mid - half))}A${mid - half},${mid - half},0,1,0,${p(at(a1, mid - half))}A${half},${half},0,0,1,${p(at(a1, mid + half))}Z`;
  const u = [Math.cos(axis), Math.sin(axis)];
  const nrm = [-u[1], u[0]];
  const along = (t, w) => [cx + u[0] * t + nrm[0] * w, cy + u[1] * t + nrm[1] * w];
  const w = 18;
  const pencil = `M${p(along(-6, 0))}L${p(along(34, -w))}L${p(along(134, -w))}A${w},${w},0,0,1,${p(along(134, w))}L${p(along(34, w))}Z`;
  return ring + pencil;
}

const rows = [];
for (const [name, file, why] of USED) rows.push(`  /** ${file}-fill: ${why} */\n  ${name}: "${await phosphor(file)}",`);

/** [site name, path data, what it is, what it means where it stands], each filled with the even-odd rule if listed in EVENODD. */
const question = await phosphor("question");
const COMPOSED = [
  ["pencilOutline", pencilOutline(), "composed: a ring open at its upper right and a pencil crossing the gap (SF pencil.and.outline)", "the island: Circle"],
  [
    "questionBubble",
    // chat-fill's bubble, byte for byte, and question-fill's mark (its dot and its hook, the disc left out) at 0.85 about
    // the bubble's middle, knocked out of it by the even-odd rule
    (await phosphor("chat")) +
      place(question, 0.85, 128 - 0.85 * 128, 128 - 0.85 * 132)
        .split(/(?=M)/)
        .slice(1)
        .join(""),
    "composed: Phosphor chat-fill with question-fill's mark knocked out (SF questionmark.bubble.fill)",
    "the island: Ask",
  ],
  [
    "tilesThree",
    // wide, as SF's group is at 11 pt: the left pair a touch wider than the tall one, the upper of them a touch taller
    tile(8, 44, 124, 124) + tile(8, 140, 124, 212) + tile(140, 44, 248, 212),
    "composed: two tiles stacked at the left, one tall at the right, Phosphor's tiles with its 16-unit corners (SF rectangle.3.group.fill)",
    "the island: the Console tile",
  ],
];
const EVENODD = ["questionBubble"];
for (const [name, d, what, why] of COMPOSED) rows.push(`  /** ${what}: ${why} */\n  ${name}: "${d}",`);

const src = `/**
 * The icon family: Phosphor Icons ${VERSION}, the Fill weight (MIT, LICENSE-Phosphor.txt beside this file), vendored as SVG
 * path data on Phosphor's 256-unit box. Only the icons the page uses are here, each with what it means where it stands.
 * Generated by scripts/vendor-icons.mjs from jsDelivr (@phosphor-icons/core/assets/fill/<file>-fill.svg), byte for byte, and
 * the three island glyphs it composes from Phosphor's parts (the last rows): edit the lists there, never the paths here.
 */
export const ICONS = {
${rows.join("\n")}
} as const;

export type IconName = keyof typeof ICONS;

/** The icons filled with the even-odd rule: a composed mark knocked out of a shape wound the same way. */
export const EVENODD: ReadonlySet<IconName> = new Set<IconName>([${EVENODD.map((n) => `"${n}"`).join(", ")}]);

/** Phosphor's box: every path is drawn on 256 × 256. */
export const ICON_BOX = 256;
`;
writeFileSync(OUT, src);
console.log(`wrote ${OUT}: ${USED.length + COMPOSED.length} icons, ${src.length} bytes`);
