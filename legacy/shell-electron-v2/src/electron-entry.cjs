// Electron's main process cannot execute TypeScript, and this repo has no build
// step by design. tsx's module hooks can be registered from inside Electron, so
// this shim is the real entry and main.ts stays ESM TypeScript.
const { register } = require("tsx/esm/api");
register();
import("./main.ts").catch((error) => {
  console.error("jarhead: failed to load main.ts through tsx:", error);
  process.exit(1);
});
