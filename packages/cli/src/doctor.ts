import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_BRAIN_ORDER, DEFAULT_WAKE, type BrainKind, type WakeSettings } from "@jarhead/protocol";
import { REPO_ROOT, keySource, readConfig } from "@jarhead/core";
import { defaultConnectors } from "@jarhead/agents";
import { probeCodex, selfEditDoctorRow } from "@jarhead/brain";
import { DaemonClient } from "@jarhead/daemon";
import { NativeHandsProcess } from "@jarhead/hands";

/**
 * Preflight for the things that fail silently. Exits non-zero only on failures
 * that make Jarhead unusable; advisories never fail the build.
 */

export type Status = "ok" | "warn" | "fail";

export interface Check {
  readonly group: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly required: boolean;
  readonly fix?: string | undefined;
}

function sh(cmd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
  } catch {
    return undefined;
  }
}

async function json(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  return { status: r.status, body };
}

/** The brain settings the engine actually uses: ~/.jarhead/settings.json overrides the env defaults. */
function readSavedSettings(stateDir: string): { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string } {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string };
    return {
      ...(saved.brain ? { brain: saved.brain } : {}),
      ...(typeof saved.brainModel === "string" ? { brainModel: saved.brainModel } : {}),
      ...(saved.brainBaseUrl ? { brainBaseUrl: saved.brainBaseUrl } : {}),
    };
  } catch {
    return {};
  }
}

/** Ask a running daemon which brain it resolved to; undefined when none answers within 1.5 s. */
async function daemonBrain(socketPath: string): Promise<{ resolved: string | undefined; detail: string } | undefined> {
  if (!existsSync(socketPath)) return undefined;
  const client = new DaemonClient(socketPath);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 1500);
      client.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      client.on("message", (m) => {
        if (m.type !== "snapshot") return;
        clearTimeout(timer);
        const setup = (m.snapshot as { setup?: { brainResolved?: string; brainDetail?: string } } | undefined)?.setup;
        resolve({ resolved: setup?.brainResolved, detail: setup?.brainDetail ?? "" });
      });
      client.connect({ pid: process.pid, audio: false }).catch(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  } finally {
    client.close();
  }
}

export async function runChecks(): Promise<Check[]> {
  const cfg = readConfig();
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);

  // ---- keys
  if (!cfg.openaiApiKey) {
    add({ group: "keys", name: "OPENAI_API_KEY", status: "fail", detail: "missing", required: true, fix: "put OPENAI_API_KEY=... in ~/.jarhead/env" });
  } else {
    try {
      const r = await json("https://api.openai.com/v1/models", { Authorization: `Bearer ${cfg.openaiApiKey}` });
      const ids = new Set(((r.body as { data?: { id: string }[] } | undefined)?.data ?? []).map((m) => m.id));
      const hasLive = ids.has(cfg.liveModel);
      const src = keySource("OPENAI_API_KEY");
      const where = src === "state-dir" ? "~/.jarhead/env" : src === "repo" ? ".env.local" : "shell env";
      add({
        group: "keys",
        name: "OPENAI_API_KEY",
        status: r.status === 200 ? "ok" : "fail",
        detail: r.status === 200 ? `valid, from ${where} (${ids.size} models)` : `HTTP ${r.status} for the key from ${where}`,
        required: true,
        fix: r.status === 200 ? undefined : src === "shell" ? "the shell's OPENAI_API_KEY is stale; put a working key in ~/.jarhead/env (it takes precedence)" : "replace OPENAI_API_KEY in ~/.jarhead/env with a working key",
      });
      add({ group: "keys", name: cfg.liveModel, status: hasLive ? "ok" : "fail", detail: hasLive ? "available on this key" : "not listed for this key", required: true, fix: "the Live model must be enabled on the OpenAI project" });
      const backend = ids.has("gpt-5.6-terra");
      add({ group: "keys", name: "gpt-5.6-terra (openai brain)", status: backend ? "ok" : "warn", detail: backend ? "available" : "not listed; set JARHEAD_BRAIN_MODEL to an available Responses model", required: false });
    } catch (e) {
      add({ group: "keys", name: "OPENAI_API_KEY", status: "fail", detail: `could not reach api.openai.com: ${(e as Error).message}`, required: true });
    }
  }

  // ---- claude code brain
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settingsKey: string | undefined;
  try {
    settingsKey = (JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: { ANTHROPIC_API_KEY?: string } }).env?.ANTHROPIC_API_KEY;
  } catch {
    settingsKey = undefined;
  }
  const anthropicKey = cfg.anthropicApiKey ?? settingsKey;
  if (anthropicKey) {
    try {
      const r = await json("https://api.anthropic.com/v1/models", { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" });
      add({
        group: "brain",
        name: "ANTHROPIC_API_KEY",
        status: r.status === 200 ? "ok" : "warn",
        detail: r.status === 200 ? `valid (${settingsKey && anthropicKey === settingsKey ? "from ~/.claude/settings.json" : "from env"})` : `rejected with HTTP ${r.status} — Claude Code headless will fail to authenticate`,
        required: false,
        fix: r.status === 200 ? undefined : "rotate the key in ~/.claude/settings.json (env.ANTHROPIC_API_KEY) or remove it and run `claude /login` so OAuth is used",
      });
    } catch (e) {
      add({ group: "brain", name: "ANTHROPIC_API_KEY", status: "warn", detail: (e as Error).message, required: false });
    }
  } else {
    add({ group: "brain", name: "ANTHROPIC_API_KEY", status: "warn", detail: "not set — the anthropic-api brain is unavailable; claude-code uses your Claude login instead", required: false });
  }
  // ---- codex brain (first in auto's order): the CLI bundled in ChatGPT.app, on Kevin's ChatGPT login
  const codex = await probeCodex({ bin: cfg.codexBin });
  add({
    group: "brain",
    name: "codex",
    status: codex.bin && codex.signedIn ? "ok" : "warn",
    detail: codex.bin ? `${codex.bin.path}${codex.version ? ` (${codex.version})` : ""}: ${codex.detail}` : codex.detail,
    required: false,
    fix: !codex.bin ? "install Codex Desktop (inside ChatGPT.app) or set JARHEAD_CODEX_BIN" : !codex.signedIn ? "sign in to Codex in ChatGPT, or run `codex login`" : undefined,
  });
  const claudeBin = cfg.claudeBin ?? sh("which", ["claude"]);
  add({ group: "brain", name: "claude", status: claudeBin ? "ok" : "warn", detail: claudeBin ? `${claudeBin} (${sh(claudeBin, ["--version"]) ?? "?"})` : "not on PATH — the claude-code brain is unavailable; auto skips to the next backend", required: false });
  // What `auto` resolves to: the running daemon's answer when there is one, else what this Mac's configuration implies.
  const saved = readSavedSettings(cfg.stateDir);
  const brain: BrainKind = saved.brain ?? cfg.brain;
  const brainModel = saved.brainModel ?? cfg.brainModel;
  const brainBaseUrl = saved.brainBaseUrl ?? cfg.brainBaseUrl;
  const running = await daemonBrain(cfg.socketPath);
  const anthropicOk = checks.some((c) => c.name === "ANTHROPIC_API_KEY" && c.status === "ok");
  const expected = codex.bin && codex.signedIn ? "codex" : claudeBin || existsSync(join(homedir(), ".claude")) ? "claude-code (if its login answers the start-up probe)" : anthropicOk ? "anthropic-api" : brainBaseUrl ? "openai-compatible" : "openai-responses";
  const resolved =
    brain === "auto"
      ? running?.resolved
        ? `resolves to ${running.resolved} in the running daemon (${running.detail})`
        : `expected to resolve to ${expected} on this Mac`
      : running?.resolved && running.resolved !== brain
        ? `the running daemon fell back to ${running.resolved} (${running.detail})`
        : running?.resolved
          ? `running (${running.detail})`
          : "explicit";
  add({
    group: "brain",
    name: "default brain",
    status: "ok",
    detail: `${brain}${brainModel ? ` (${brainModel})` : ""}${brainBaseUrl ? ` @ ${brainBaseUrl}` : ""} — ${resolved}; auto order ${AUTO_BRAIN_ORDER.join(" → ")}`,
    required: false,
  });

  // ---- hands
  const hands = new NativeHandsProcess({ binPath: cfg.handsBin });
  if (!hands.available) {
    add({ group: "hands", name: "jarhead-hands", status: "fail", detail: `not built at ${cfg.handsBin}`, required: false, fix: "pnpm build:hands" });
  } else {
    try {
      const hello = await hands.hello();
      add({ group: "hands", name: "jarhead-hands", status: "ok", detail: `v${hello.version} pid ${hello.pid}`, required: false });
      add({ group: "hands", name: "Accessibility", status: hello.permissions.accessibility ? "ok" : "warn", detail: hello.permissions.accessibility ? "granted to this launcher" : "not granted — clicks/typing will silently no-op", required: false, fix: "System Settings → Privacy & Security → Accessibility: switch Jarhead on; if it is already on, remove the row (−) and press Request in Setup — that row was made by an earlier build" });
      add({ group: "hands", name: "Screen Recording", status: hello.permissions.screenRecording ? "ok" : "warn", detail: hello.permissions.screenRecording ? "granted" : "not granted — falls back to `screencapture`", required: false, fix: "System Settings → Privacy & Security → Screen & System Audio Recording" });
    } catch (e) {
      add({ group: "hands", name: "jarhead-hands", status: "fail", detail: (e as Error).message, required: false });
    } finally {
      hands.stop();
    }
  }

  // ---- agents: the sessions on this Mac and the connector that continues one
  for (const c of defaultConnectors({ claudeBin: cfg.claudeBin })) {
    try {
      const h = await c.health();
      add({ group: "agents", name: c.kind, status: h.ok ? "ok" : "warn", detail: h.detail, required: false });
    } catch (e) {
      add({ group: "agents", name: c.kind, status: "warn", detail: (e as Error).message, required: false });
    }
  }

  // ---- native app
  const appPath = join(REPO_ROOT, "build", "Jarhead.app");
  if (existsSync(appPath)) {
    const signed = sh("codesign", ["--verify", "--strict", appPath]) !== undefined || sh("codesign", ["-dv", appPath]) !== undefined;
    const installed = existsSync("/Applications/Jarhead.app");
    add({ group: "app", name: "Jarhead.app", status: signed ? "ok" : "warn", detail: `${appPath}${installed ? " (also in /Applications)" : ""}${signed ? "" : " — signature does not verify"}`, required: false, fix: installed ? undefined : "cp -R build/Jarhead.app /Applications/ && open -a Jarhead" });
    // codesign -dvv reports on stderr; an ad-hoc signature means TCC forgets the grants on every rebuild.
    let signature = "unknown";
    try {
      execFileSync("codesign", ["-dvv", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      signature = `${err.stderr ?? ""}${err.stdout ?? ""}`;
    }
    if (signature === "unknown") {
      const out = sh("sh", ["-c", `codesign -dvv "${appPath}" 2>&1`]) ?? "";
      signature = out;
    }
    const adhoc = /Signature=adhoc/.test(signature);
    const authority = signature.match(/^Authority=(.+)$/m)?.[1];
    add({ group: "app", name: "signing identity", status: adhoc ? "warn" : "ok", detail: adhoc ? "ad-hoc — microphone/screen/accessibility grants reset on every rebuild" : (authority ?? "signed with a real identity"), required: false, fix: adhoc ? "Keychain Access → Certificate Assistant → Create a Certificate (Code Signing), then pnpm build:mac; or set JARHEAD_SIGN_IDENTITY" : undefined });
  } else {
    add({ group: "app", name: "Jarhead.app", status: "warn", detail: "not built", required: false, fix: "pnpm build:mac" });
  }
  // ---- wake word gate (the app enforces it; doctor reports the configuration)
  try {
    const settingsPath = join(cfg.stateDir, "settings.json");
    const saved = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as { wake?: Partial<WakeSettings> }) : {};
    const wake: WakeSettings = { ...DEFAULT_WAKE, ...(saved.wake ?? {}) };
    const passphrase = existsSync(join(cfg.stateDir, "wake-auth.json"));
    const needsPassphrase = wake.auth === "passphrase" || wake.auth === "either";
    const unguarded = wake.enabled && wake.auth === "none";
    add({
      group: "app",
      name: "wake word",
      status: !wake.enabled ? "warn" : unguarded ? "warn" : needsPassphrase && !passphrase && wake.auth === "passphrase" ? "warn" : "ok",
      detail: !wake.enabled
        ? "off — the session opens on launch (autoWake) or by command"
        : `on: "${wake.phrases.join('" / "')}" → ${wake.auth}${passphrase ? ", passphrase set" : ", no passphrase (Touch ID / Mac password only)"}; on-device recognition, no API until authenticated`,
      required: false,
      fix: unguarded ? "set wake.auth to touch-id, passphrase or either in the Console" : needsPassphrase && !passphrase && wake.auth === "passphrase" ? "set a passphrase in Console › Settings › Wake" : undefined,
    });
  } catch (e) {
    add({ group: "app", name: "wake word", status: "warn", detail: (e as Error).message, required: false });
  }
  const daemonSock = existsSync(cfg.socketPath);
  add({ group: "app", name: "daemon socket", status: daemonSock ? "ok" : "warn", detail: daemonSock ? `${cfg.socketPath} present (app or jarheadd running)` : "no daemon running", required: false });
  // ---- self-edit: worktrees the brain made of this repo and the last one it applied
  try {
    const se = selfEditDoctorRow(join(cfg.stateDir, "worktrees"));
    add({ group: "app", name: "self-edit", status: se.stale > 0 ? "warn" : "ok", detail: se.detail, required: false, fix: se.stale > 0 ? `${se.stale} worktree${se.stale === 1 ? "" : "s"} older than a day: say "discard the old self-edits" or run git worktree remove under ${join(cfg.stateDir, "worktrees")}` : undefined });
  } catch (e) {
    add({ group: "app", name: "self-edit", status: "warn", detail: (e as Error).message, required: false });
  }

  // ---- toolchain
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({ group: "toolchain", name: "node", status: nodeMajor >= 24 ? "ok" : "fail", detail: process.versions.node, required: true, fix: "use Node 24+" });
  for (const [bin, why] of [["ffmpeg", "headless CLI mic"], ["ffplay", "headless CLI speaker"], ["swiftc", "building the hands helper"]] as const) {
    const out = sh(bin, ["-version"]) ?? sh(bin, ["--version"]);
    add({ group: "toolchain", name: bin, status: out ? "ok" : "warn", detail: out ? (out.split("\n")[0] ?? "present").slice(0, 60) : `missing — needed for ${why}`, required: false });
  }
  const volume = Number(sh("osascript", ["-e", "output volume of (get volume settings)"]) ?? "-1");
  add({ group: "toolchain", name: "output volume", status: volume > 0 ? "ok" : volume === 0 ? "warn" : "warn", detail: volume >= 0 ? `${volume}%` : "unknown", required: false, fix: "a muted Mac makes the whole thing look broken" });
  add({ group: "state", name: "state dir", status: "ok", detail: cfg.stateDir, required: false });
  return checks;
}

export function render(checks: readonly Check[]): { text: string; blocking: number } {
  const icon: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘" };
  const lines: string[] = [`\njarhead doctor  ·  ${REPO_ROOT}\n`];
  for (const g of [...new Set(checks.map((c) => c.group))]) {
    lines.push(`  ${g}`);
    for (const c of checks.filter((x) => x.group === g)) lines.push(`    ${icon[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
    lines.push("");
  }
  const fixes = checks.filter((c) => c.status !== "ok" && c.fix);
  if (fixes.length) {
    lines.push("  next steps");
    for (const f of fixes) lines.push(`    · ${f.name}: ${f.fix}`);
    lines.push("");
  }
  const blocking = checks.filter((c) => c.status === "fail" && c.required).length;
  lines.push(`  ${checks.filter((c) => c.status === "ok").length} ok · ${checks.filter((c) => c.status === "warn").length} warn · ${checks.filter((c) => c.status === "fail").length} fail\n`);
  return { text: lines.join("\n"), blocking };
}
