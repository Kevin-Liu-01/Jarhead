import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertContract } from "@jarvis/wiki-bridge";

/**
 * "Want me to make that recurring?" — "go for it."
 *
 * Two deliberate constraints, both taken from the wiki's own rules rather than
 * invented here:
 *
 * 1. **Schedule vocabulary is fixed.** The contract enum is exactly
 *    every-4-hours | daily | weekly | on-demand. "every hour" is not
 *    expressible, so Jarvis counter-offers instead of silently rounding.
 * 2. **Writes land in Jarvis's own state dir, not the wiki.** The wiki is a
 *    shared linked worktree whose AGENTS.md says to preserve work you did not
 *    create, and direct-writing `schedulers/registrations.json` bypasses the
 *    SCHEDULE_BINDINGS gate the ops hub warns about. Registrations are still
 *    validated against the real wiki contract, so promoting them later is a
 *    file move, not a rewrite.
 */

export const SCHEDULES = ["every-4-hours", "daily", "weekly", "on-demand"] as const;
export type Schedule = (typeof SCHEDULES)[number];

export interface RegistrationEntry {
  registrationId: string;
  slug: string;
  workflowId: string;
  profile: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  quietDelivery: boolean;
  jitterSeconds: number;
  input: Record<string, unknown>;
}

export interface Registry {
  schemaVersion: "1";
  generatedAt: string;
  digest: string;
  entries: RegistrationEntry[];
}

export interface CreateRequest {
  /** What Kevin actually asked, verbatim. This is the automation's reason to exist. */
  readonly intent: string;
  readonly schedule: Schedule;
  readonly stateDir: string;
  readonly timezone?: string;
  /** Verbatim spoken consent, recorded as the approval trail. */
  readonly spokenConsent: string;
  readonly now: Date;
}

export interface CreateResult {
  readonly slug: string;
  readonly registrationId: string;
  readonly markdownPath: string;
  readonly registryPath: string;
  readonly entry: RegistrationEntry;
}

export function slugify(intent: string): string {
  const base = intent
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-");
  return base || "automation";
}

/** Maps spoken cadence words onto the contract enum. Returns undefined if inexpressible. */
export function parseSchedule(utterance: string): Schedule | undefined {
  const u = utterance.toLowerCase();
  if (/\bweekly|every week|once a week\b/.test(u)) return "weekly";
  if (/\bevery (four|4) hours|four times a day\b/.test(u)) return "every-4-hours";
  if (/\bdaily|every day|each day|every morning|mornings\b/.test(u)) return "daily";
  if (/\bon demand|manually|when i ask\b/.test(u)) return "on-demand";
  return undefined;
}

export function registryPathFor(stateDir: string): string {
  return join(stateDir, "automations", "registrations.json");
}

export function readRegistry(stateDir: string): Registry {
  const path = registryPathFor(stateDir);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Registry;
    } catch {
      // Fall through to a fresh registry rather than wedging the assistant.
    }
  }
  return { schemaVersion: "1", generatedAt: new Date(0).toISOString(), digest: "0".repeat(64), entries: [] };
}

function digestOf(entries: readonly RegistrationEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function createAutomation(req: CreateRequest): CreateResult {
  const slug = slugify(req.intent);
  const dir = join(req.stateDir, "automations");
  mkdirSync(dir, { recursive: true });

  const registrationId = `jarvis-${slug}-${req.now.toISOString().slice(0, 10)}`;
  const timezone = req.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const entry: RegistrationEntry = {
    registrationId,
    slug,
    workflowId: "research.refresh",
    profile: "jarvis-voice",
    schedule: req.schedule,
    timezone,
    enabled: true,
    quietDelivery: false,
    jitterSeconds: 120,
    input: {
      requestId: registrationId,
      profile: "jarvis-voice",
      intent: req.intent,
    },
  };

  const registry = readRegistry(req.stateDir);
  registry.entries = [...registry.entries.filter((e) => e.registrationId !== registrationId), entry];
  registry.generatedAt = req.now.toISOString();
  registry.digest = digestOf(registry.entries);

  // Validate against the wiki's real contract before writing. If this throws,
  // nothing is persisted — a malformed registration is worse than none.
  assertContract("scheduler-registration-registry", registry);

  const registryPath = registryPathFor(req.stateDir);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const markdownPath = join(dir, `${slug}.md`);
  writeFileSync(markdownPath, renderMarkdown(entry, req));

  return { slug, registrationId, markdownPath, registryPath, entry };
}

function renderMarkdown(entry: RegistrationEntry, req: CreateRequest): string {
  return `---
schemaVersion: "1"
slug: ${entry.slug}
registrationId: ${entry.registrationId}
workflowId: ${entry.workflowId}
profile: ${entry.profile}
schedule: ${entry.schedule}
timezone: ${entry.timezone}
enabled: true
createdBy: jarvis
createdAt: ${req.now.toISOString()}
---

# ${entry.slug}

Created by voice. Kevin asked:

> ${req.intent}

Consent was spoken, verbatim:

> ${req.spokenConsent}

Runs **${entry.schedule}** in ${entry.timezone}.

## Status

Registered in Jarvis's own state directory, not in the wiki. Promoting this into
\`schedulers/registrations.json\` requires landing the \`SCHEDULE_BINDINGS\` entry
first, otherwise \`pnpm kw automation-v2 audit\` reports drift.
`;
}
