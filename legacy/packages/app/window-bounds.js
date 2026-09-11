"use strict";

/**
 * Bounds of every visible window on screen, for the buddy to squish against.
 *
 * Electron has no API for other applications' windows, and the accessibility
 * route (System Events, per app) takes seconds. CoreGraphics'
 * CGWindowListCopyWindowInfo answers in ~90ms for the whole desktop, which is
 * fast enough to refresh when a drag starts.
 *
 * The JXA is written to a temp file rather than passed with -e because it is
 * long enough that quoting it through a shell argument is a footgun.
 */

const { execFile } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const JXA = `
ObjC.import("CoreGraphics");
// kCGWindowListOptionOnScreenOnly = 1, kCGNullWindowID = 0.
var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0));
var out = [];
for (var i = 0; i < arr.count; i++) {
  var w = arr.objectAtIndex(i);
  // Layer 0 is the normal window layer: skips the Dock, menu bar, wallpaper,
  // and our own screen-saver-level overlay.
  if (ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
  var name = ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || "";
  if (name === "Jarhead") continue;
  var b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
  if (!b) continue;
  // Ignore slivers: tooltips and shadows are not worth squishing against.
  if (b.Width < 140 || b.Height < 100) continue;
  out.push({ app: name, x: b.X, y: b.Y, w: b.Width, h: b.Height });
}
JSON.stringify(out);
`;

let scriptPath;

function ensureScript() {
  if (scriptPath) return scriptPath;
  const dir = mkdtempSync(join(tmpdir(), "jarvis-winbounds-"));
  scriptPath = join(dir, "bounds.js");
  writeFileSync(scriptPath, JXA);
  return scriptPath;
}

/**
 * Resolves to a list of window rects, or [] on any failure.
 *
 * Failure is not exceptional here: without Screen Recording consent the window
 * list comes back without geometry, and the right response is a buddy that
 * squishes against screen edges only rather than one that stops working.
 */
function windowBounds(timeoutMs = 1500) {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", ensureScript()], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = { windowBounds };
