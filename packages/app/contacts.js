"use strict";

/**
 * What the buddy is currently pressed against.
 *
 * Every obstacle — a screen edge or another application's window — is treated as
 * the same thing: a solid rectangle. The blob's centre is tested against each
 * one, and the closest-point-on-rect formula covers approach, contact and
 * penetration with no special cases. That last part is what makes "keep dragging
 * and it squishes INTO the window" fall out for free instead of needing its own
 * branch: once the centre is inside a rect, the normal points back toward the
 * nearest way out and the press goes deep.
 *
 * Pure functions, so the squish is unit-testable without a display.
 */

/**
 * How far past the blob's radius a surface is still felt.
 *
 * Was 1.15, which meant contact began ~86px away from any window. On a desktop
 * with a dozen windows that is always true, so the buddy sat permanently
 * flattened. Under 1 it only reacts once the body genuinely overlaps the
 * surface, which is what "pressed against" should mean.
 */
const REACH = 0.82;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Contact with a solid rectangle.
 *
 * Returns a normal pointing from the obstacle toward free space, plus how hard
 * the blob is being pressed (0 = just touching, 1 = fully flattened, >1 = past
 * the surface and squeezing in).
 */
function contactWithRect(cx, cy, radius, rect) {
  const left = rect.x;
  const right = rect.x + rect.w;
  const top = rect.y;
  const bottom = rect.y + rect.h;

  const inside = cx > left && cx < right && cy > top && cy < bottom;

  if (inside) {
    // Which wall is nearest? That is the one it entered through, so the blob
    // flattens against it and bulges back out the way it came.
    const dl = cx - left;
    const dr = right - cx;
    const dt = cy - top;
    const db = bottom - cy;
    const min = Math.min(dl, dr, dt, db);
    const n = min === dl ? [-1, 0] : min === dr ? [1, 0] : min === dt ? [0, -1] : [0, 1];
    // Deeper in means more squish, saturating so it never inverts.
    return { nx: n[0], ny: n[1], press: clamp(1 + min / radius, 0, 1.6) };
  }

  const px = clamp(cx, left, right);
  const py = clamp(cy, top, bottom);
  const dx = cx - px;
  const dy = cy - py;
  const dist = Math.hypot(dx, dy);

  if (dist >= radius * REACH || dist === 0) return undefined;

  return {
    nx: dx / dist,
    ny: dy / dist,
    press: clamp((radius * REACH - dist) / radius, 0, 1),
  };
}

/**
 * Contacts with the four inside faces of the work area.
 *
 * Modelled as half-planes rather than one rect, because the buddy is INSIDE this
 * rectangle and the obstacle is each wall — the opposite orientation to a window.
 */
function screenContacts(cx, cy, radius, area) {
  const walls = [
    { nx: 1, ny: 0, d: cx - area.x },
    { nx: -1, ny: 0, d: area.x + area.width - cx },
    { nx: 0, ny: 1, d: cy - area.y },
    { nx: 0, ny: -1, d: area.y + area.height - cy },
  ];
  const out = [];
  for (const w of walls) {
    if (w.d < radius * REACH) {
      out.push({ nx: w.nx, ny: w.ny, press: clamp((radius * REACH - w.d) / radius, 0, 1.4) });
    }
  }
  return out;
}

/**
 * All contacts for a buddy window, strongest first and capped at two.
 *
 * Two is enough for a corner; stacking more stops reading as a blob and just
 * collapses it.
 *
 * `dragging` gates WINDOW contacts only. A parked buddy overlapping a window
 * should simply sit there — squishing into windows is a thing that happens
 * because Kevin is pushing it. Screen edges are hard walls and always press back.
 */
function computeContacts(buddy, area, windows, dragging) {
  const radius = Math.min(buddy.width, buddy.height) * 0.34;
  const cx = buddy.x + buddy.width / 2;
  const cy = buddy.y + buddy.height / 2;

  const found = screenContacts(cx, cy, radius, area);

  if (dragging) {
    for (const win of windows || []) {
      const c = contactWithRect(cx, cy, radius, win);
      if (c) found.push(c);
    }
  }

  found.sort((a, b) => b.press - a.press);

  // Merge near-parallel contacts so two windows sharing an edge do not
  // double-squish the same axis.
  const kept = [];
  for (const c of found) {
    if (kept.some((k) => k.nx * c.nx + k.ny * c.ny > 0.85)) continue;
    kept.push(c);
    if (kept.length === 2) break;
  }
  return kept;
}

module.exports = { computeContacts, contactWithRect, screenContacts, REACH };
