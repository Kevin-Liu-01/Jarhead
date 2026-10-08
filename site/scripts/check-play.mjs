/**
 * The hero's blob in the hand (components/site/heroPlay.ts), checked in headless Chromium against a built site:
 *
 *   pnpm -C site build && pnpm -C site start        (http://localhost:3939)
 *   node site/scripts/check-play.mjs [url]
 *
 * Three passes: a desk at 1440 × 900 (the arrival, a tap, a drag and a place, the hover pause, a fling, the island, the
 * Install key under a drop, the frame time, the idle cost, the layout), a phone at 390 × 844 driven by touch over CDP
 * (the disc drags, a swipe anywhere else scrolls), and reduced motion (carried 1:1 and cut home). Each check prints ok or
 * FAIL; any FAIL exits non-zero. Headless only: never headed, never a preview window.
 */
import { chromium } from "playwright-core";

const BASE = (process.argv[2] ?? "http://localhost:3939").replace(/\/$/, "");
let failed = 0;
function check(name, pass, detail = "") {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!pass) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, k = 1) => Math.round(v * 10 ** k) / 10 ** k;

/** Before any script: the trace switch, the layout shifts summed, the long tasks kept, the play states logged. */
function boot() {
  window.__jhTrace = true;
  window.__cls = 0;
  window.__long = [];
  window.__plays = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  // every change of data-play, timed
  new MutationObserver(() => {
    const el = document.querySelector(".hero-body");
    const v = el ? (el.dataset.play ?? null) : null;
    const last = window.__plays[window.__plays.length - 1];
    if (!last || last[1] !== v) window.__plays.push([performance.now(), v]);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-play"], childList: true });
}

async function open(browser, opts, path = "/") {
  const ctx = await browser.newContext(opts);
  // the star count's refresh (lib/stars.ts) answered here: the check never leans on GitHub's rate limit
  await ctx.route("https://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"stargazers_count":6}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(boot);
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  return { ctx, page, errors };
}

// ---- in-page reads ----
const play = (page) => page.evaluate(() => document.querySelector(".hero-body")?.dataset.play ?? null);
const kind = (page) => page.evaluate(() => document.querySelector(".top")?.dataset.kind ?? null);
const off = (page) =>
  page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector(".hero-body")).transform);
    return [m.m41, m.m42];
  });
const disc = (page) =>
  page.evaluate(() => {
    const r = document.querySelector(".hero-grab").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, R: r.width / 2 };
  });
/** The h1's stop as seen: its opacity once it wears ink (without the arrival it is clear until play inks it). */
const stopOpacity = (page) =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".h1-stop"));
    return /rgba\(.*,\s*0\)|transparent/.test(cs.color) ? 0 : Number(cs.opacity);
  });
/** Layout shifts are counted from here: the island's and the key's canvases size themselves as the page loads. */
const freshShifts = (page) => page.evaluate(() => (window.__cls = 0));
const rect = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, sel);
/** Polls `fn` until it holds or `ms` pass; returns the ms it took, or -1. */
async function until(fn, ms, every = 16) {
  const t0 = Date.now();
  while (Date.now() - t0 <= ms) {
    if (await fn()) return Date.now() - t0;
    await sleep(every);
  }
  return -1;
}
const waitPlay = (page, v, ms) => until(async () => (await play(page)) === v, ms);
/** When data-play last became `v`, in the page's clock (ms), or null. */
const playAt = (page, v) =>
  page.evaluate((w) => {
    for (let i = window.__plays.length - 1; i >= 0; i--) if (window.__plays[i][1] === w) return window.__plays[i][0];
    return null;
  }, v);
/** Samples the wrapper's offset every frame for `ms` (started now, read back when done). */
const sampleOffsets = (page, ms) =>
  page.evaluate(
    (dur) =>
      new Promise((done) => {
        const out = [];
        const el = document.querySelector(".hero-body");
        const t0 = performance.now();
        const tick = (now) => {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          out.push([now - t0, m.m41, m.m42]);
          if (now - t0 < dur) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
const layout = (page) =>
  page.evaluate(() =>
    [".hero-h1", ".hero-lead", ".hero-calls", ".glass"].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    }),
  );
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const a = [...xs].sort((u, v) => u - v);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

/**
 * A mouse drag: down at (x, y), then `n` moves along `path(u)` (u from 1/n to 1) paced `gap` ms apart by the clock (a move
 * itself waits about a frame for the page), `each` after every move.
 */
async function drag(page, x, y, n, gap, path, each) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  const t0 = Date.now();
  for (let i = 1; i <= n; i++) {
    const due = t0 + i * gap - Date.now();
    if (due > 0) await sleep(due);
    const [px, py] = path(i / n);
    await page.mouse.move(px, py);
    if (each) await each(i, px, py);
  }
}

// ---- A. the desk ----
async function desk(browser) {
  console.log("\n# desk 1440 × 900");
  const { ctx, page, errors } = await open(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
  await page.mouse.move(10, 880);

  // 1. the arrival: nothing to grab until it ends
  let during = false;
  let clickKept = true;
  const arriving = await until(async () => (await kind(page)) === "listening" && (await play(page)) === null, 6000, 20);
  if (arriving >= 0) {
    during = (await play(page)) === null;
    const d = await disc(page);
    const before = await kind(page);
    await page.mouse.click(d.x, d.y);
    await sleep(120);
    // the arrival itself may have ended meanwhile; a click that landed while it ran never steps the kind
    clickKept = (await kind(page)) === before || (await play(page)) !== null;
    await page.mouse.move(10, 880);
  }
  check("arrival: no data-play while it runs", during);
  check("arrival: a click on the disc does not step the kind", clickKept);
  check("arrival: home within 8 s", (await waitPlay(page, "home", 8000)) >= 0);
  const charT = await page.evaluate(() => getComputedStyle(document.querySelector(".hero-char")).transform);
  check("arrival: the host's transform is identity", charT === "none" || charT === "matrix(1, 0, 0, 1, 0, 0)", charT);
  await sleep(300);
  await freshShifts(page);
  const before = await layout(page);
  const k0 = await kind(page);

  // 2. a tap: the step, a hop, home
  let d = await disc(page);
  const R = d.R;
  const hop = sampleOffsets(page, 600);
  await page.mouse.click(d.x, d.y);
  const stepped = await until(async () => (await kind(page)) !== k0, 150, 10);
  const k1 = await kind(page);
  const samples = await hop;
  const peak = Math.min(...samples.map((s) => s[2]));
  check("tap: steps the kind within 150 ms", stepped >= 0 && k1 === "thinking", `${k0} → ${k1}`);
  check("tap: no hash, no scroll", (await page.evaluate(() => location.hash === "" && scrollY === 0)));
  check("tap: hops at least 0.25 R", peak <= -0.25 * R, `${round(peak / R, 2)} R`);
  const tapHome = await waitPlay(page, "home", 1200);
  check("tap: home within 1.2 s", tapHome >= 0, `${tapHome} ms`);
  check("tap: the wrapper's transform cleared", (await page.evaluate(() => document.querySelector(".hero-body").style.transform)) === "");

  // 3. drag and place
  d = await disc(page);
  let lagOk = false;
  let lagSeen = 0;
  await drag(page, d.x, d.y, 30, 16, (u) => [d.x - 320 * u, d.y + 160 * u], async (i, px, py) => {
    if (i !== 15) return;
    const [ox, oy] = await off(page);
    lagSeen = Math.hypot(px - (d.x + ox), py - (d.y + oy));
    lagOk = (await play(page)) === "held" && (await page.evaluate(() => document.documentElement.dataset.grabbing !== undefined)) && lagSeen >= 0.2 * R && lagSeen <= 2 * R;
  });
  check("drag: held, grabbing, the lag visible at move 15", lagOk, `${round(lagSeen / R, 2)} R`);
  await sleep(200);
  await page.mouse.up();
  const upAt = await page.evaluate(() => performance.now());
  await page.mouse.move(40, 860);
  const perched = await waitPlay(page, "perched", 1000);
  const [px, py] = await off(page);
  check("drag: perched where it was put", perched >= 0 && Math.hypot(px + 320, py - 160) < 0.6 * R, `(${round(px)}, ${round(py)})`);
  check("drag: nothing selected", (await page.evaluate(() => getSelection().toString())) === "");
  await sleep(Math.max(0, upAt + 500 - (await page.evaluate(() => performance.now()))));
  check("drag: the h1's stop shows its ink", (await stopOpacity(page)) >= 0.95, String(await stopOpacity(page)));
  await waitPlay(page, "homing", 4500);
  const pAt = await playAt(page, "perched");
  const hAt = await playAt(page, "homing");
  const gap = hAt !== null && pAt !== null ? hAt - pAt : -1;
  check("drag: homing 3 s after it perched", gap >= 2800 && gap <= 3800, `${round(gap)} ms`);
  check("drag: home by 6.5 s", (await waitPlay(page, "home", 6500)) >= 0);
  await sleep(300);
  check("drag: the stop's ink gone", (await stopOpacity(page)) <= 0.05, String(await stopOpacity(page)));
  check("drag: the wrapper's transform cleared", (await page.evaluate(() => document.querySelector(".hero-body").style.transform)) === "");

  // 4. the hover pause
  d = await disc(page);
  await drag(page, d.x, d.y, 30, 16, (u) => [d.x - 320 * u, d.y + 160 * u]);
  await sleep(200);
  await page.mouse.up();
  await waitPlay(page, "perched", 1500);
  {
    const b = await disc(page);
    await page.mouse.move(b.x + 0.5 * R, b.y);
  }
  await sleep(5000);
  check("hover: a mouse near it holds it 5 s", (await play(page)) === "perched", String(await play(page)));
  {
    const b = await disc(page);
    await page.mouse.move(b.x - 600, Math.min(880, b.y + 300));
  }
  const left = await waitPlay(page, "homing", 3500);
  check("hover: let go, it goes home within 3.5 s", left >= 0, `${left} ms`);
  await waitPlay(page, "home", 4000);

  // 5. a fling to the left wall
  d = await disc(page);
  const home = { x: d.x, y: d.y };
  const flight = page.evaluate(
    ([hx, hy, dur]) =>
      new Promise((done) => {
        const out = [];
        const el = document.querySelector(".hero-body");
        const t0 = performance.now();
        const tick = (now) => {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          const top = document.querySelector(".top").getBoundingClientRect().bottom;
          const hero = document.querySelector("section.hero").getBoundingClientRect();
          out.push([hx + m.m41, hy + m.m42, top, hero.left, hero.top, hero.right, hero.bottom, innerWidth]);
          if (now - t0 < dur) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    [home.x, home.y, 2500],
  );
  await drag(page, d.x, d.y, 4, 12, (u) => [d.x - 260 * u, d.y]);
  await page.mouse.up();
  await page.mouse.move(40, 860);
  check("fling: free", (await until(async () => (await play(page)) === "free", 200, 5)) >= 0);
  const path = await flight;
  let inside = true;
  let wall = false;
  for (const [cx, cy, top, hl, ht, hr, hb, w] of path) {
    if (cx < 0.25 * R || cx > w - 0.25 * R || cy < top + 0.25 * R || cx < hl || cx > hr || cy < ht || cy > hb) inside = false;
    if (cx <= 1.2 * R) wall = true;
  }
  check("fling: always inside the hero and under the bar", inside);
  check("fling: reached the left wall", wall, `${round(Math.min(...path.map((p) => p[0])))} px`);
  const after = await play(page);
  check("fling: ends perched or homing", after === "perched" || after === "homing", String(after));
  await waitPlay(page, "perched", 2000);

  // 6. the island puts it to bed (picked up from wherever it perched)
  d = await disc(page);
  const isl = await rect(page, ".top-scale");
  const tx = isl.x;
  const ty = isl.b + 0.3 * R;
  await drag(page, d.x, d.y, 40, 16, (u) => [d.x + (tx - d.x) * u, d.y + (ty - d.y) * u]);
  await sleep(150);
  await page.mouse.up();
  await page.mouse.move(40, 860);
  const asleep = await until(async () => (await kind(page)) === "asleep", 300, 10);
  check("island: asleep within 300 ms", asleep >= 0, String(await kind(page)));
  const tucked = await until(
    async () => (await play(page)) === "tucked" && (await page.evaluate(() => Number(getComputedStyle(document.querySelector(".hero-body")).opacity))) < 0.1,
    450,
    10,
  );
  check("island: tucked and faded within 450 ms", tucked >= 0);
  check("island: homing by 2.6 s", (await waitPlay(page, "homing", 2600)) >= 0);
  check("island: home by 6 s", (await waitPlay(page, "home", 6000)) >= 0);
  check("island: it came home asleep", await page.evaluate(() => !!document.querySelector('.hero-char[data-phase="asleep"]')));

  // 7. dropped on the Install key, the key's link is never followed
  d = await disc(page);
  await page.mouse.click(d.x, d.y);
  await waitPlay(page, "home", 1500);
  d = await disc(page);
  const glass = await rect(page, ".glass");
  await drag(page, d.x, d.y, 30, 16, (u) => [d.x + (glass.x - d.x) * u, d.y + (glass.y - d.y) * u]);
  await sleep(120);
  await page.mouse.up();
  await sleep(200);
  check("key: a drop on it follows no link", await page.evaluate(() => location.hash === "" && scrollY === 0));
  await page.mouse.move(40, 860);
  await waitPlay(page, "home", 6000);

  // 8. the frame time while held
  d = await disc(page);
  const t0 = await page.evaluate(() => {
    window.__raf = [];
    window.__rafOn = true;
    const tick = (now) => {
      window.__raf.push(now);
      if (window.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return performance.now();
  });
  const cx = d.x - 75;
  await drag(page, d.x, d.y, 125, 16, (u) => {
    const a = u * 2 * 2 * Math.PI;
    return [cx + 75 * Math.cos(a), d.y + 75 * Math.sin(a)];
  });
  await page.mouse.up();
  const frames = await page.evaluate((from) => {
    window.__rafOn = false;
    const to = performance.now();
    const draws = performance.getEntriesByName("blob-draw").filter((e) => e.startTime >= from && e.startTime <= to).map((e) => e.duration);
    const r = window.__raf;
    const gaps = r.slice(1).map((v, i) => v - r[i]);
    const longs = window.__long.filter(([s]) => s >= from && s <= to).map(([, dur]) => dur);
    return { draws, gaps, longs };
  }, t0);
  const p95 = pct(frames.draws, 0.95);
  const max = Math.max(...frames.draws);
  const g95 = pct(frames.gaps, 0.95);
  console.log(`     blob-draw median ${round(pct(frames.draws, 0.5), 2)} ms, p95 ${round(p95, 2)}, max ${round(max, 2)} (${frames.draws.length} draws); frame median ${round(pct(frames.gaps, 0.5), 2)} ms, p95 ${round(g95, 2)}`);
  check("frames: blob-draw p95 ≤ 4 ms and max ≤ 8 ms", p95 <= 4 && max <= 8, `p95 ${round(p95, 2)}, max ${round(max, 2)}`);
  check("frames: rAF p95 ≤ 20 ms while held", g95 <= 20, `${round(g95, 2)} ms`);
  check("frames: no long task over 50 ms", !frames.longs.some((v) => v > 50), frames.longs.map((v) => round(v)).join(", "));
  await page.mouse.move(40, 860);

  // 9. home again, play costs nothing
  await waitPlay(page, "perched", 2000);
  await waitPlay(page, "home", 6000);
  await sleep(100);
  const idle = await page.evaluate(
    () =>
      new Promise((done) => {
        const from = performance.now();
        setTimeout(() => done(performance.getEntriesByName("hero-play-frame").filter((e) => e.startTime >= from).length), 1000);
      }),
  );
  check("idle: no play frame at home over 1 s", (await play(page)) === "home" && idle === 0, `${idle} marks, ${await play(page)}`);

  // 10. the layout never moved
  const now = await layout(page);
  const moved = before.some((r, i) => r.some((v, j) => Math.abs(v - now[i][j]) > 0.5));
  check("layout: the h1, the lead, the calls and the key where they were", !moved);
  const cls = await page.evaluate(() => window.__cls);
  check("layout: no layout shift", cls < 0.001, String(round(cls, 5)));
  check("layout: no sideways scroll", await page.evaluate(() => document.scrollingElement.scrollWidth === innerWidth));
  check("desk: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// ---- B. the phone ----
async function phone(browser) {
  console.log("\n# phone 390 × 844, touch");
  const { ctx, page, errors } = await open(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: "no-preference" });
  const cdp = await ctx.newCDPSession(page);
  check("phone: home", (await waitPlay(page, "home", 8000)) >= 0);
  await sleep(300);
  await freshShifts(page);
  const wide = async () => page.evaluate(() => document.scrollingElement.scrollWidth === innerWidth);
  let narrow = await wide();
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });

  // 2. a drag that starts on the disc carries the blob and never scrolls
  let d = await disc(page);
  let still = true;
  let heldBy6 = false;
  await touch("touchStart", d.x, d.y);
  for (let i = 1; i <= 12; i++) {
    await touch("touchMove", d.x + (90 * i) / 12, d.y + (140 * i) / 12);
    await sleep(16);
    if ((await page.evaluate(() => scrollY)) !== 0) still = false;
    if (i === 6) heldBy6 = (await play(page)) === "held";
  }
  await touch("touchEnd", 0, 0);
  const [ox, oy] = await off(page);
  const centre = { x: d.x + ox, y: d.y + oy };
  check("phone: a drag on the disc never scrolls", still);
  check("phone: held by the sixth move", heldBy6);
  check("phone: carried at least 60 px, inside the screen", Math.hypot(ox, oy) >= 60 && centre.x > 0 && centre.x < 390 && centre.y > 0 && centre.y < 844, `(${round(ox)}, ${round(oy)})`);
  narrow &&= await wide();

  // 3. a swipe that starts on the disc moves the blob, not the page
  await waitPlay(page, "home", 8000);
  d = await disc(page);
  await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(d.x), y: Math.round(d.y), yDistance: -300, gestureSourceType: "touch", speed: 800 });
  const moved = (await play(page)) !== "home" || Math.hypot(...(await off(page))) > 1;
  check("phone: a swipe on the disc never scrolls", (await page.evaluate(() => scrollY)) === 0);
  check("phone: a swipe on the disc moves the blob", moved, String(await play(page)));
  narrow &&= await wide();

  // 4. a swipe anywhere else scrolls as ever
  await waitPlay(page, "home", 8000);
  const lead = await rect(page, ".hero-lead");
  await cdp.send("Input.synthesizeScrollGesture", { x: 195, y: Math.round(lead.y), yDistance: -300, gestureSourceType: "touch", speed: 800 });
  const sy1 = await page.evaluate(() => scrollY);
  check("phone: a swipe on the lead scrolls", sy1 > 100, `${sy1} px`);
  await page.evaluate(() => scrollTo(0, 0));
  await waitPlay(page, "home", 8000);
  await sleep(200);
  const host = await rect(page, ".hero-char");
  await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(host.l + 6), y: Math.round(host.t + 6), yDistance: -300, gestureSourceType: "touch", speed: 800 });
  const sy2 = await page.evaluate(() => scrollY);
  check("phone: a swipe on the halo, off the disc, scrolls", sy2 > 50, `${sy2} px`);
  await page.evaluate(() => scrollTo(0, 0));
  await waitPlay(page, "home", 8000);
  await sleep(200);
  narrow &&= await wide();

  // 5. a tap steps the kind
  d = await disc(page);
  const k0 = await kind(page);
  await page.touchscreen.tap(d.x, d.y);
  const tapped = await until(async () => (await kind(page)) !== k0, 400, 10);
  check("phone: a tap steps the kind", tapped >= 0, `${k0} → ${await kind(page)}`);
  narrow &&= await wide();
  check("phone: no sideways scroll", narrow);
  const cls = await page.evaluate(() => window.__cls);
  check("phone: no layout shift", cls < 0.001, String(round(cls, 5)));
  check("phone: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// ---- C. reduced motion (and #still) ----
async function calm(browser, path) {
  console.log(`\n# calm ${path === "/" ? "(reduced motion)" : path}`);
  const opts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: path === "/" ? "reduce" : "no-preference" };
  const { ctx, page, errors } = await open(browser, opts, path);
  await page.mouse.move(10, 880);
  check("calm: no arrival", await page.evaluate(() => document.documentElement.dataset.arrive === undefined));
  check("calm: home at once", (await waitPlay(page, "home", 1500)) >= 0);
  const d = await disc(page);
  const R = d.R;
  const t0 = await page.evaluate(() => performance.now());
  let exact = true;
  let inkCut = true;
  let firstPast = true;
  await drag(page, d.x, d.y, 10, 16, (u) => [d.x - 200 * u, d.y + 100 * u], async (i, px, py) => {
    const [ox, oy] = await off(page);
    if (Math.abs(ox - (px - d.x)) > 0.5 || Math.abs(oy - (py - d.y)) > 0.5) exact = false;
    if (firstPast && Math.hypot(ox, oy) >= 0.6 * R) {
      firstPast = false;
      if ((await stopOpacity(page)) !== 1) inkCut = false;
    }
  });
  check("calm: carried 1:1", exact);
  check("calm: the stop's ink cut in", inkCut && !firstPast);
  const marks = await page.evaluate((from) => ({
    draws: performance.getEntriesByName("blob-draw").filter((e) => e.startTime >= from).length,
    frames: performance.getEntriesByName("hero-play-frame").filter((e) => e.startTime >= from).length,
  }), t0);
  check("calm: no loop while held", marks.draws <= 2 && marks.frames === 0, `${marks.draws} draws, ${marks.frames} frames`);
  await page.mouse.up();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const back = await off(page);
  check("calm: cut home on release", back[0] === 0 && back[1] === 0 && (await page.evaluate(() => document.querySelector(".hero-body").style.transform)) === "");
  check("calm: the stop's ink cut out", (await stopOpacity(page)) === 0);
  // a drop in the island's zone
  const isl = await rect(page, ".top-scale");
  await drag(page, d.x, d.y, 10, 16, (u) => [d.x + (isl.x - d.x) * u, d.y + (isl.b + 0.3 * R - d.y) * u]);
  await page.mouse.up();
  check("calm: the island puts it to bed", (await play(page)) === "home" && (await until(async () => (await kind(page)) === "asleep", 300, 10)) >= 0);
  // a tap steps the kind, no hop
  const k0 = await kind(page);
  await page.mouse.click(d.x, d.y);
  let flat = true;
  for (let i = 0; i < 15; i++) {
    const [ox, oy] = await off(page);
    if (ox !== 0 || oy !== 0) flat = false;
    await sleep(20);
  }
  check("calm: a tap steps the kind and never hops", (await kind(page)) !== k0 && flat, `${k0} → ${await kind(page)}`);
  check("calm: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

const t0 = Date.now();
const browser = await chromium.launch({ headless: true });
try {
  await desk(browser);
  await phone(browser);
  await calm(browser, "/");
  await calm(browser, "/#still");
} finally {
  await browser.close();
}
console.log(`\n${failed ? `${failed} FAIL` : "all ok"} in ${round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
