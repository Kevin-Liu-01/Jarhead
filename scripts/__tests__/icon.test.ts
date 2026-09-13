import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACE, INK, ORB, PAPER, faceMask, faceMaskSmall, gleamLift, orbGeometry, orbInside } from "../dither.ts";
import { FACE_MAX_R, ICON_CELLS_PER_R, ICON_SOURCES, SIZES, asciiMask, checkIcon, faceFor, renderIcon, staleAgainst, type IconRender } from "../icon-render.ts";

/**
 * The Dock icon's face, pinned: the exact cells of Kevin's `^ ^` on the 64-cell grid,
 * the rule that every larger size is that pattern in bigger cells, the two hand bitmaps,
 * and the invariants a reviewer would otherwise check by eye — flat fills flat, a mirror
 * across the orb's centre, still a circle, still a dither, light from the upper left,
 * the same bytes every run. Imports only the pure renderer and the material: never
 * make-icon.ts or make-banner.ts, which write files at import.
 */

const renders = new Map<number, IconRender>();
const render = (size: number): IconRender => {
  let r = renders.get(size);
  if (!r) renders.set(size, (r = renderIcon(size)));
  return r;
};

/** The orb's radius in px at a size: ORB.r of the squircle's half-extent. */
const orbR = (size: number): number => ORB.r * 0.82 * (size / 2);

/** Pixel nearest a point given in orb units (R = 1). */
const at = (size: number, nx: number, ny: number): [number, number] => [Math.floor(size / 2 + nx * orbR(size)), Math.floor(size / 2 + ny * orbR(size))];
const rgb = (r: IconRender, x: number, y: number): [number, number, number] => {
  const i = (y * r.size + x) * 4;
  return [r.px[i] ?? -1, r.px[i + 1] ?? -1, r.px[i + 2] ?? -1];
};
const alpha = (r: IconRender, x: number, y: number): number => r.px[(y * r.size + x) * 4 + 3] ?? -1;
const isFace = (r: IconRender, x: number, y: number): boolean => (r.mask[y * r.size + x] ?? 0) !== 0;
const insideOrb = (size: number, x: number, y: number): boolean => Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < orbR(size);

test("face cells at 64 are pinned: the chevron with its one-cell ink box, the right eye the mirror of the left", () => {
  const r = render(64);
  // Left eye: box cols 21..27, rows 24..29; glyph cols 22..26, rows 25..28 (`..#..` / `.###.` / `##.##` / `#...#`);
  // the box is the Chebyshev dilation of the glyph, so it fills the chevron's cavity and stops at the feet.
  const left = ["..+++..", ".++#++.", "++###++", "+##+##+", "+#+++#+", "+++.+++"];
  assert.deepEqual(asciiMask(r, 21, 27, 24, 29), left);
  assert.deepEqual(asciiMask(r, 36, 42, 24, 29), left.map((row) => [...row].reverse().join("")), "the right eye is the left eye mirrored");
  // Nothing else on the orb is face: 20 glyph cells, 50 box cells.
  let glyph = 0;
  let box = 0;
  for (const m of r.mask) if (m === 1) glyph++; else if (m === 2) box++;
  assert.deepEqual([glyph, box], [20, 50]);
  // The row and the pair: 5 cells above the centre boundary, centres ±7.5 cells — the blob's −0.30 R and ≈ 30 % of the width.
  assert.equal(Math.round(ICON_CELLS_PER_R * 1000) / 1000, 16.269);
  assert.equal(Math.round(FACE.row * ICON_CELLS_PER_R), -5);
  assert.equal(Math.round(FACE.spread * ICON_CELLS_PER_R * 2) / 2, 7.5);
});

test("the cell pattern is one pattern from 64 to 1024: mask(N) is mask(64) in N/64-px cells", () => {
  const base = render(64);
  for (const N of [128, 256, 512, 1024]) {
    const r = render(N);
    const k = N / 64;
    let glyph = 0;
    let box = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const want = base.mask[Math.floor(y / k) * 64 + Math.floor(x / k)];
        const got = r.mask[y * N + x];
        if (got !== want) assert.fail(`icon ${N}: pixel (${x},${y}) is ${got}, the 64 grid says ${want}`);
        if (got === 1) glyph++;
        else if (got === 2) box++;
      }
    }
    assert.deepEqual([glyph, box], [20 * k * k, 50 * k * k], `icon ${N}: glyph and box pixel counts`);
  }
});

test("32 and 16 are hand bitmaps: six pinned glyph pixels with a 30-pixel ring; a dot pair with its shadow", () => {
  const r32 = render(32);
  const glyph32: string[] = [];
  const box32: string[] = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (r32.mask[y * 32 + x] === 1) glyph32.push(`${x},${y}`); else if (r32.mask[y * 32 + x] === 2) box32.push(`${x},${y}`);
  assert.deepEqual(glyph32, ["12,12", "19,12", "11,13", "13,13", "18,13", "20,13"], "a 3×2 `.#./#.#` per eye at cols 11..13 / 18..20, rows 12..13");
  assert.equal(box32.length, 30);
  for (const p of box32) {
    const [x, y] = p.split(",").map(Number) as [number, number];
    assert.ok(((x >= 10 && x <= 14) || (x >= 17 && x <= 21)) && y >= 11 && y <= 14, `ring pixel ${p} inside its 5×4`);
    assert.ok(!(y === 11 && (x === 10 || x === 14 || x === 17 || x === 21)), `ring pixel ${p}: the 8-neighbour ring has no top corners`);
  }
  assert.deepEqual([...faceMaskSmall(32)], [...r32.mask], "the render's mask IS the bitmap (every pixel of it is inside the orb)");

  const r16 = render(16);
  const glyph16: string[] = [];
  const box16: string[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (r16.mask[y * 16 + x] === 1) glyph16.push(`${x},${y}`); else if (r16.mask[y * 16 + x] === 2) box16.push(`${x},${y}`);
  assert.deepEqual([glyph16, box16], [["6,6", "9,6"], ["6,7", "9,7"]]);
  // The one-line retreat: FACE.at16 = "none" draws nothing at 16 and changes nothing else.
  const was = FACE.at16;
  try {
    FACE.at16 = "none";
    assert.equal(faceFor(16), "none");
    assert.ok(renderIcon(16).mask.every((m) => m === 0));
    assert.deepEqual([...renderIcon(32).mask], [...r32.mask]);
  } finally {
    FACE.at16 = was;
  }
});

test("faceFor: by the orb's diameter — dots at 16, the mini bitmap at 32, the chevron from 64 up", () => {
  assert.deepEqual(SIZES.map(faceFor), ["dots", "mini", "chevron", "chevron", "chevron", "chevron", "chevron"]);
  assert.equal(faceFor(8), "none", "a 4 px orb has no face");
  assert.equal(faceFor(48), "mini");
  assert.equal(faceFor(63), "chevron");
});

test("flat fills flat: every glyph pixel is exactly PAPER and every box pixel exactly INK after the ring pass, at all seven sizes", () => {
  for (const size of SIZES) {
    const r = render(size);
    checkIcon(r);
    const colours = new Set<string>();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const m = r.mask[y * size + x];
        if (!m) continue;
        const c = rgb(r, x, y);
        colours.add(c.join(","));
        assert.deepEqual(c, m === 1 ? [...PAPER] : [...INK], `icon ${size}: face pixel (${x},${y})`);
        assert.equal(alpha(r, x, y), 255, `icon ${size}: a face pixel is opaque`);
      }
    }
    assert.deepEqual([...colours].sort(), [[...INK].join(","), [...PAPER].join(",")].sort(), `icon ${size}: the face adds exactly two colours`);
  }
});

test("mirror symmetry: 0 asymmetric face pixels at every size (the orb's centre sits on a pixel boundary)", () => {
  for (const size of SIZES) {
    const r = render(size);
    let asymmetric = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (r.mask[y * size + x] !== r.mask[y * size + (size - 1 - x)]) asymmetric++;
    assert.equal(asymmetric, 0, `icon ${size}`);
    // The orb itself mirrors too: opaque coverage is symmetric left↔right and top↔bottom.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) assert.equal(alpha(r, x, y), alpha(r, size - 1 - x, y), `icon ${size}: alpha (${x},${y}) ↔ its mirror`);
  }
});

test("still a circle: every face pixel's centre within 0.82 R at every size; corner alpha 0, centre alpha 255", () => {
  for (const size of SIZES) {
    const r = render(size);
    assert.equal(alpha(r, 0, 0), 0, `icon ${size}: corner transparent`);
    assert.equal(alpha(r, Math.floor(size / 2), Math.floor(size / 2)), 255, `icon ${size}: centre opaque`);
    let max = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (isFace(r, x, y)) max = Math.max(max, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / orbR(size));
    assert.ok(max < FACE_MAX_R, `icon ${size}: farthest face pixel at ${max.toFixed(3)} R`);
    // Measured: 0.52 at 16, 0.80 at 32 (the ring's outer column), 0.73–0.77 from 64 up.
    if (size === 32) assert.ok(max > 0.79 && max < 0.81, `icon 32: ${max.toFixed(3)} R`);
    if (size >= 64) assert.ok(max > 0.72 && max < 0.78, `icon ${size}: ${max.toFixed(3)} R`);
  }
});

test("no smooth gradient: the orb's interior holds at most 64 distinct colours at every size (5 bands, dithered), and at least 5 from 64 up", () => {
  for (const size of SIZES) {
    const r = render(size);
    const colours = new Set<string>();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (insideOrb(size, x, y) && !isFace(r, x, y)) colours.add(rgb(r, x, y).join(","));
    assert.ok(colours.size <= 64, `icon ${size}: ${colours.size} colours inside the orb`);
    if (size >= 64) assert.ok(colours.size >= 5, `icon ${size}: ${colours.size} colours — a dither has bands`);
  }
});

test("light from the upper left: the sheen sits above the eyes at the rim and does not reach the glyph", () => {
  for (const size of [256, 1024]) {
    const r = render(size);
    const [gx, gy] = at(size, FACE.gleam.x, FACE.gleam.y);
    assert.ok(rgb(r, gx, gy).every((c) => c >= 200), `icon ${size}: the pixel nearest the gleam (${gx},${gy}) is lifted toward paper: ${rgb(r, gx, gy).join(",")}`);
    assert.ok(!isFace(r, gx, gy), "the gleam is not on the face");
    const sum = (p: [number, number]): number => rgb(r, ...p).reduce((a, b) => a + b, 0);
    assert.ok(sum(at(size, -0.5, -0.62)) > sum(at(size, 0.5, 0.62)), `icon ${size}: the upper left is lighter than the lower right`);
  }
  // At the left glyph's apex the sheen lifts by less than one of the highlight's eight levels.
  const apex = gleamLift(FACE.gleam, -FACE.spread, FACE.row - FACE.h / 2);
  assert.ok(apex <= 1 / ORB.highlightLevels, `lift at the apex ${apex.toFixed(3)}`);
  // And the old highlight sat exactly where the left eye is — the reason it moved.
  assert.ok(Math.hypot(ORB.highlight.x + FACE.spread, ORB.highlight.y - FACE.row) < 0.15);
});

test("orbInside's default highlight is unchanged (the 4th parameter widens without moving a byte)", () => {
  for (const nx of [-0.9, -0.5, -0.36, 0, 0.4, 0.8]) {
    for (const ny of [-0.9, -0.4, 0, 0.5, 0.9]) {
      const g = orbGeometry(nx * ORB.r, ny * ORB.r);
      if (g.sd > 0) continue;
      for (const t of [0.0078, 0.25, 0.5, 0.75, 0.9922]) assert.deepEqual(orbInside(g, 5, t), orbInside(g, 5, t, ORB.highlight));
    }
  }
});

test("determinism: rendering twice gives the same bytes; the face can be turned off", () => {
  assert.ok(renderIcon(64).px.equals(renderIcon(64).px));
  assert.ok(renderIcon(256).px.equals(renderIcon(256).px));
  const bare = renderIcon(128, { face: false });
  assert.ok(bare.mask.every((m) => m === 0), "no face pixels without the face");
  assert.ok(!bare.px.equals(render(128).px), "the faceless render differs (the face and its sheen)");
  checkIcon(bare);
});

test("checkIcon throws with the size named: a tinted glyph pixel, a face pixel with no mirror", () => {
  const r = render(64);
  const tinted: IconRender = { size: 64, px: Buffer.from(r.px), mask: r.mask };
  const [x, y] = [24, 25]; // the left apex
  assert.equal(r.mask[y * 64 + x], 1);
  tinted.px[(y * 64 + x) * 4] = 250;
  assert.throws(() => checkIcon(tinted), /icon 64: face pixel \(24,25\) is not flat PAPER/);
  const lopsided: IconRender = { size: 64, px: r.px, mask: Uint8Array.from(r.mask) };
  lopsided.mask[y * 64 + x] = 0;
  // Dropping one cell leaves it AND its mirror without a partner: two asymmetric pixels.
  assert.throws(() => checkIcon(lopsided), /icon 64: 2 face pixel\(s\) have no mirror/);
});

test("the banner wears the same face: sampled on 8 px cells with a 2-cell box, on the upper third, mirrored about the centre column", () => {
  const cols = 320;
  const rows = 100;
  const m = faceMask(cols, rows, 8, 1280, 400, 288);
  const glyphRows = new Set<number>();
  let glyph = 0;
  let box = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = m[r * cols + c];
      if (v === 1) (glyph++, glyphRows.add(r));
      else if (v === 2) box++;
      assert.equal(v, m[r * cols + (cols - 1 - c)], `banner cell (${c},${r}) mirrors`);
    }
  }
  assert.ok(glyph > 0 && box > 0);
  const rowsSorted = [...glyphRows].sort((a, b) => a - b);
  assert.ok((rowsSorted[0] ?? 0) >= 33 && (rowsSorted[rowsSorted.length - 1] ?? 99) <= 43, `glyph rows ${rowsSorted[0]}..${rowsSorted[rowsSorted.length - 1]} sit on the upper third (centre row 50)`);
  // Two cells of box: a glyph cell two cells away from its nearest neighbour is boxed, three is not.
  const rad = Math.max(1, Math.round((FACE.outline * 288) / 8));
  assert.equal(rad, 2);
});

test("build-mac's icns staleness rule: missing → stale; older than any renderer source → stale; newer than all → fresh; a source that is not there is ignored", () => {
  assert.equal(staleAgainst(undefined, [1, 2, 3]), true, "a missing icns is built");
  assert.equal(staleAgainst(1000, [900, 999, 1000]), false, "the same second counts as built after (mtime resolution)");
  assert.equal(staleAgainst(1000, [900, 1001]), true, "one newer source is enough");
  assert.equal(staleAgainst(1000, [undefined, 900]), false, "a source that does not exist does not force a rebuild");
  assert.equal(staleAgainst(1000, []), false);
  assert.deepEqual([...ICON_SOURCES], ["make-icon.ts", "icon-render.ts", "dither.ts"], "the three files whose change re-renders the icon");
  for (const f of ICON_SOURCES) assert.ok(existsSync(join(import.meta.dirname, "..", f)), `${f} is a real file under scripts/`);
});

test("build-mac's icns staleness rule on real mtimes: touch dither.ts → rebuild; an icns newer than every source → no rebuild", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-icon-stale-"));
  try {
    // The same mtime reader build-mac.ts uses (missing → undefined), over a stand-in scripts/ folder.
    const mtime = (p: string): number | undefined => (existsSync(p) ? statSync(p).mtimeMs : undefined);
    const stale = (icns: string): boolean => staleAgainst(mtime(icns), ICON_SOURCES.map((f) => mtime(join(dir, f))));
    const icns = join(dir, "Jarhead.icns");
    const at = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);
    for (const f of ICON_SOURCES) {
      writeFileSync(join(dir, f), "// source");
      utimesSync(join(dir, f), at(10), at(10));
    }
    assert.equal(stale(icns), true, "no icns yet");
    writeFileSync(icns, "icns");
    utimesSync(icns, at(5), at(5));
    assert.equal(stale(icns), false, "built after every source");
    utimesSync(join(dir, "dither.ts"), at(1), at(1));
    assert.equal(stale(icns), true, "a touched dither.ts makes the icns stale");
    utimesSync(icns, at(0), at(0));
    assert.equal(stale(icns), false, "rebuilt → fresh again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
