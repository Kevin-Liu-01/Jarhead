import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LABEL, plistPath, renderPlist } from "../launchd.ts";

// installLaunchAgent/uninstallLaunchAgent shell out to launchctl and write to
// ~/Library/LaunchAgents, so only the pure parts are tested here.

test("the plist lands in the user's LaunchAgents under the label", () => {
  assert.equal(plistPath(), join(homedir(), "Library", "LaunchAgents", "com.kevin.jarvisd.plist"));
});

test("renders a plist that launchd can actually start", () => {
  const plist = renderPlist({ stateDir: "/Users/kevinliu/.jarvis" });

  assert.match(plist, /<key>Label<\/key>\s*<string>com\.kevin\.jarvisd<\/string>/);
  // An absolute node path, because launchd's PATH knows nothing about nvm/brew.
  assert.ok(plist.includes(`<string>${process.execPath}</string>`));
  assert.match(plist, /node_modules\/\.bin\/tsx/);
  assert.match(plist, /packages\/daemon\/src\/main\.ts/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // Restart on crash, stay stopped after a clean {"cmd":"stop"}.
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(plist.includes("/Users/kevinliu/.jarvis/logs/jarvisd.log"));
  assert.equal(LAUNCHD_LABEL, "com.kevin.jarvisd");
});

test("paths are XML-escaped so an odd directory name cannot corrupt the plist", () => {
  const plist = renderPlist({ stateDir: "/tmp/state & <stuff>" });
  assert.ok(plist.includes("/tmp/state &amp; &lt;stuff&gt;/logs"));
  assert.ok(!plist.includes("state & <stuff>"));
});
