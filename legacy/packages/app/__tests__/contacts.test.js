const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeContacts, contactWithRect, screenContacts } = require("../contacts.js");

const AREA = { x: 0, y: 0, width: 1000, height: 800 };
const buddy = (x, y) => ({ x, y, width: 220, height: 220 });
// computeContacts uses min(w,h) * 0.34 as the blob radius.
const R = 220 * 0.34;

test("free space in the middle means no contacts", () => {
  assert.deepEqual(computeContacts(buddy(400, 300), AREA, [], true), []);
});

test("a screen edge presses back with an inward normal", () => {
  // Centre near the left wall.
  const [c] = computeContacts(buddy(-100, 300), AREA, [], true);
  assert.ok(c, "expected a contact against the left wall");
  assert.equal(c.nx, 1, "normal should point right, into free space");
  assert.equal(c.ny, 0);
  assert.ok(c.press > 0, "should be pressed");
});

test("press grows as it is pushed further into the wall", () => {
  const near = computeContacts(buddy(-60, 300), AREA, [], true)[0];
  const deep = computeContacts(buddy(-130, 300), AREA, [], true)[0];
  assert.ok(deep.press > near.press, `${deep.press} should exceed ${near.press}`);
});

test("a corner produces two contacts on different axes", () => {
  const cs = computeContacts(buddy(-100, -100), AREA, [], true);
  assert.equal(cs.length, 2);
  assert.ok(cs.some((c) => c.nx === 1) && cs.some((c) => c.ny === 1));
});

test("never more than two contacts, however boxed in", () => {
  const tiny = { x: 0, y: 0, width: 200, height: 200 };
  assert.ok(computeContacts(buddy(-10, -10), tiny, [], true).length <= 2);
});

test("an approaching window is felt before it is touched", () => {
  const win = { x: 500, y: 0, w: 400, h: 800 };
  const far = contactWithRect(500 - R * 3, 400, R, win);
  const close = contactWithRect(500 - R * 0.8, 400, R, win);
  assert.equal(far, undefined, "should not feel a window that is far away");
  assert.ok(close, "should feel a window within reach");
  assert.equal(close.nx, -1, "normal points away from the window");
});

test("dragging INTO a window squishes harder than touching its face", () => {
  const win = { x: 500, y: 0, w: 400, h: 800 };
  const touching = contactWithRect(500 - R * 0.5, 400, R, win);
  const inside = contactWithRect(520, 400, R, win);
  assert.ok(inside.press > touching.press, "penetration must squish more than contact");
  assert.equal(inside.nx, -1, "should push back out the side it entered");
});

test("inside a window, the normal points at the nearest way out", () => {
  const win = { x: 0, y: 0, w: 1000, h: 200 };
  // Just below the top edge: the top is the nearest exit.
  const c = contactWithRect(500, 20, R, win);
  assert.equal(c.ny, -1);
  assert.equal(c.nx, 0);
});

test("press saturates rather than inverting deep inside a window", () => {
  const win = { x: 0, y: 0, w: 4000, h: 3000 };
  const c = contactWithRect(2000, 1500, R, win);
  assert.ok(c.press <= 1.6 && c.press > 0, `press ${c.press} should stay bounded`);
});

test("windows sharing an edge do not double-squish the same axis", () => {
  const a = { x: 500, y: 0, w: 200, h: 400 };
  const b = { x: 500, y: 400, w: 200, h: 400 };
  const cs = computeContacts(buddy(500 - 220, 300), AREA, [a, b], true);
  const rightish = cs.filter((c) => c.nx < -0.85);
  assert.ok(rightish.length <= 1, "parallel normals should have merged");
});

test("screen contacts are independent of window contacts", () => {
  assert.equal(screenContacts(500, 400, R, AREA).length, 0);
  assert.ok(screenContacts(5, 400, R, AREA).length >= 1);
});

test("window contacts only apply while dragging", () => {
  // A parked buddy overlapping a window should not be squished by it; pushing it
  // in is the gesture that earns the squish.
  const win = { x: 300, y: 200, w: 400, h: 400 };
  const parked = computeContacts(buddy(390, 290), AREA, [win], false);
  const pushed = computeContacts(buddy(390, 290), AREA, [win], true);
  assert.deepEqual(parked, [], "parked should feel nothing from the window");
  assert.ok(pushed.length > 0, "dragging into it should squish");
});

test("screen edges press back even when parked", () => {
  assert.ok(computeContacts(buddy(-120, 300), AREA, [], false).length > 0);
});
