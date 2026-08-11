// Electron's main process cannot execute TypeScript, and this repo has no
// build step by design — everything runs through tsx. The tsx CLI cannot wrap
// the electron binary, but its module-hooks API can be registered from inside
// it, so this tiny CJS shim is the real entry point and main.ts stays ESM.
const { register } = require("tsx/esm/api");
register();

import("./main.ts").catch((error) => {
  console.error("overlay: failed to load main.ts through tsx:", error);
  process.exit(1);
});
