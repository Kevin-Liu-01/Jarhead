/**
 * The card's clock: the page's live engines (the blob, the glass Install) driven frame by frame on a clock of the card's
 * own, so a capture is the same picture every time. requestAnimationFrame is taken over for the card page (its callbacks
 * wait in a queue until `advance` runs them at 60 fps on synthetic time), and while a frame runs, performance.now reads
 * that time and Math.random a seeded generator (mulberry32). Dev only: app/card/page.tsx is the one importer.
 */

const queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
let installed = false;
/** Synthetic time in ms. */
let now = 1000;
let state = 1;

function seeded(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Take over requestAnimationFrame for this page (once). */
export function installClock(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    queue.delete(id);
  };
}

/** Start the generator over from `seed`. */
export function seedClock(seed: number): void {
  state = seed | 0;
}

/** Run `fn` with the card's time and the seeded generator in place of the page's. */
export function inClock<T>(fn: () => T): T {
  const random = Math.random;
  const real = performance.now;
  Math.random = seeded;
  performance.now = () => now;
  try {
    return fn();
  } finally {
    Math.random = random;
    performance.now = real;
  }
}

/** Advance the clock by `ms` in 60 fps frames, running every queued frame; `each` runs before each frame. */
export function advance(ms: number, each?: (t: number) => void): void {
  inClock(() => {
    const end = now + ms;
    while (now < end - 1e-6) {
      now = Math.min(end, now + 1000 / 60);
      each?.(now);
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(now);
    }
  });
}

/** The card's time in ms. */
export function clockNow(): number {
  return now;
}
