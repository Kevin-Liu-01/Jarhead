import { logger } from "@jarhead/core";
import type { LiveSession, ResponsesDelegationConfig } from "@jarhead/live";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { SYSTEM_PROMPT_VERSION, brainSystemPrompt } from "./brain.ts";
import { toolSpecsFor, type ToolSpec } from "./tools.ts";
import { resultText, type ToolRunner } from "./runner.ts";
import { loadAttachments, type LoadedAttachment } from "./attachments.ts";

/**
 * The OpenAI brain: Live's own "responses" delegation.
 *
 * Live runs a Responses model (gpt-5.6-terra by default) with our function
 * tools and speaks its final text itself. What we do here is the tool loop:
 * every `response.output_item.done` with a function_call runs through the
 * ToolRunner, results go back with `response.item.create`, screenshots ride
 * along as `input_image` items, and `response.create` continues the backend.
 *
 * Unlike the client brains, this one cannot know when a delegation "starts"
 * beyond the function calls it sees, so progress reporting is per tool.
 */

const log = logger("brain.responses");

export const DEFAULT_RESPONSES_MODEL = "gpt-5.6-terra";

export interface ResponsesBrainOptions {
  readonly model?: string | undefined;
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  readonly runner: ToolRunner;
  readonly webSearch?: boolean | undefined;
  /** What the standing orders call the person Jarhead works for (release F1). */
  readonly userName?: string | undefined;
}

export interface ResponsesConfigOptions {
  readonly model?: string | undefined;
  readonly effort?: ResponsesBrainOptions["effort"] | undefined;
  readonly webSearch?: boolean | undefined;
  readonly userName?: string | undefined;
}

export function responsesDelegationConfig(opts: ResponsesConfigOptions): { type: "responses"; responses: ResponsesDelegationConfig } {
  return {
    type: "responses",
    responses: {
      // Settings.brainModel is "" for "the backend's default"; only a real id overrides.
      model: opts.model || DEFAULT_RESPONSES_MODEL,
      instructions: brainSystemPrompt(opts.userName),
      tools: [...toolSpecsFor(opts.userName ?? "Kevin").map(toFunctionTool), ...(opts.webSearch === false ? [] : [{ type: "web_search" }])],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: opts.effort ?? "low" },
    },
  };
}

export function toFunctionTool(spec: ToolSpec): unknown {
  return { type: "function", name: spec.name, description: spec.description, parameters: spec.parameters, strict: false };
}

interface PendingCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * Bound to one LiveSession. Per delegation it tracks the active response id and
 * the function calls still owed, and finishes when the nested response completes.
 */
export class ResponsesBrain implements Brain {
  readonly kind = "openai-responses";
  private live: LiveSession | undefined;
  private sinks = new Map<string, { sink: BrainSink; resolve: (r: BrainResult) => void; started: number }>();
  private pendingByDelegation = new Map<string, PendingCall[]>();
  /** Circled regions not yet shown to the backend, per delegation. */
  private attachments = new Map<string, LoadedAttachment[]>();
  private cancelled = new Set<string>();
  private unbind: (() => void) | undefined;

  constructor(private readonly opts: ResponsesBrainOptions) {}

  /** Attach to a session; called by the orchestrator when the session starts. */
  bind(live: LiveSession): void {
    this.unbind?.();
    this.live = live;
    const onEvent = (delegationId: string | null, event: Record<string, unknown>): void => {
      void this.onResponseEvent(delegationId, event);
    };
    live.on("responseEvent", onEvent);
    this.unbind = () => live.off("responseEvent", onEvent);
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    log.info(`ready; standing orders v${SYSTEM_PROMPT_VERSION}`);
    return { ready: true, detail: `responses delegation via ${this.opts.model || DEFAULT_RESPONSES_MODEL}` };
  }

  /**
   * In this mode the work is already running inside Live by the time the
   * orchestrator calls handle(); we register the sink and resolve when the nested
   * response completes.
   */
  handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    this.opts.runner.attach(sink, task);
    return new Promise<BrainResult>((resolve) => {
      this.sinks.set(task.delegationId, { sink, resolve, started: Date.now() });
      // The backend is already answering by the time we hear of the delegation, so
      // the circled regions cannot go in with the words; they ride as input_image
      // items with the first batch of tool results, before the backend continues —
      // or, when it answers without any tool, right after that answer (see
      // onResponseEvent), so a "what is this?" never goes unseen.
      const loaded = loadAttachments(task);
      if (loaded.length > 0) this.attachments.set(task.delegationId, loaded);
      task.signal.addEventListener("abort", () => {
        this.cancelled.add(task.delegationId);
        this.finish(task.delegationId, { status: "cancelled" });
      }, { once: true });
    });
  }

  private finish(delegationId: string, result: BrainResult): void {
    const entry = this.sinks.get(delegationId);
    if (!entry) return;
    this.sinks.delete(delegationId);
    this.pendingByDelegation.delete(delegationId);
    this.attachments.delete(delegationId);
    entry.resolve(result);
  }

  private async onResponseEvent(delegationId: string | null, event: Record<string, unknown>): Promise<void> {
    const type = String(event["type"] ?? "");
    const id = delegationId ?? "";
    const entry = this.sinks.get(id);

    if (type === "response.output_item.done") {
      const item = event["item"] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
      if (item?.type === "function_call" && item.call_id && item.name) {
        let args: unknown = {};
        try {
          args = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          args = {};
        }
        const list = this.pendingByDelegation.get(id) ?? [];
        list.push({ callId: item.call_id, name: item.name, args });
        this.pendingByDelegation.set(id, list);
      }
      return;
    }

    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const pending = this.pendingByDelegation.get(id) ?? [];
      this.pendingByDelegation.set(id, []);
      if (pending.length > 0 && !this.cancelled.has(id)) {
        await this.runCalls(id, pending, entry?.sink);
        return;
      }
      // The backend answered without a single tool call, so the circled region never
      // went in: show it now and let it answer once more, seeing what Kevin meant.
      if (type !== "response.failed" && entry && !this.cancelled.has(id) && this.sendAttachments(id, true)) {
        this.live?.createResponse();
        return;
      }
      if (type === "response.failed") {
        const err = (event["response"] as { error?: { message?: string } } | undefined)?.error?.message ?? "backend response failed";
        this.finish(id, { status: "failed", error: err });
      } else {
        this.finish(id, { status: "done" });
      }
      return;
    }

    if (type === "response.output_text.done" && entry) {
      const text = String(event["text"] ?? "");
      // Live speaks this itself; record it as the commentary so timings line up.
      if (text) entry.sink.step({ kind: "commentary", text: text.slice(0, 1000) });
    }
  }

  private async runCalls(delegationId: string, calls: readonly PendingCall[], sink: BrainSink | undefined): Promise<void> {
    const live = this.live;
    if (!live) return;
    if (sink) this.opts.runner.attach(sink);
    for (const call of calls) {
      if (this.cancelled.has(delegationId)) return;
      sink?.thinking(progressLine(call.name, call.args));
      const outcome = await this.opts.runner.run(call.name, call.args);
      const r = outcome.result;
      live.createResponseItem({ type: "function_call_output", call_id: call.callId, output: resultText(r) });
      if (r.kind === "image") {
        live.createResponseItem({
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${r.pngBase64}`, detail: "high" },
            { type: "input_text", text: `Screenshot from ${call.name} (${r.width}x${r.height} px). Coordinates for clicks are pixels of this image.` },
          ],
        });
      }
      if (r.kind === "needs-confirmation") sink?.step({ kind: "confirm", text: r.question });
    }
    this.sendAttachments(delegationId, false);
    live.createResponse();
    log.debug(`continued backend after ${calls.length} call(s)`);
  }

  /**
   * The circled regions go to the backend once, as one user message of
   * input_text notes and input_image items. `late` means the backend already
   * answered without them, so the message also says what to do with them.
   * Returns whether anything was sent.
   */
  private sendAttachments(delegationId: string, late: boolean): boolean {
    const live = this.live;
    const attachments = this.attachments.get(delegationId);
    if (!live || !attachments || attachments.length === 0) return false;
    this.attachments.delete(delegationId);
    const content: unknown[] = attachments.flatMap((a) => [
      { type: "input_text", text: a.note },
      { type: "input_image", image_url: `data:image/png;base64,${a.pngBase64}`, detail: "high" },
    ]);
    if (late) {
      content.push({
        type: "input_text",
        text: `You answered before seeing what ${this.opts.userName ?? "Kevin"} circled. Look at it now: if your answer changes or was missing what he meant by "this", give the corrected answer in one or two sentences; if it stands, answer "done."`,
      });
    }
    live.createResponseItem({ type: "message", role: "user", content });
    if (late) log.debug(`showed ${attachments.length} circled region(s) after a tool-less answer`);
    return true;
  }

  async cancel(): Promise<void> {
    for (const id of this.sinks.keys()) {
      this.cancelled.add(id);
      this.finish(id, { status: "cancelled" });
    }
  }

  async stop(): Promise<void> {
    this.unbind?.();
    await this.cancel();
  }
}

function base(v: unknown): string {
  const s = String(v ?? "").trim();
  return s ? (s.split("/").filter(Boolean).pop() ?? s).slice(0, 40) : "a file";
}

function hostOf(v: unknown): string {
  try {
    return new URL(String(v ?? "")).host || "a page";
  } catch {
    return "a page";
  }
}

/** Short, speakable progress for the thinking channel. */
export function progressLine(name: string, args: unknown): string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "screenshot":
      return "Taking a screenshot.";
    case "zoom":
      return "Zooming in to read the screen.";
    case "left_click":
    case "double_click":
    case "right_click":
      return `Clicking${typeof a["coordinate"] === "object" ? " on the screen" : ""}.`;
    case "type":
      return `Typing "${String(a["text"] ?? "").slice(0, 40)}".`;
    case "key":
      return `Pressing ${String(a["text"] ?? "")}.`;
    case "scroll":
      return `Scrolling ${String(a["scroll_direction"] ?? "")}.`;
    case "open_app":
    case "focus_app":
      return `Opening ${String(a["name"] ?? "the app")}.`;
    case "run_shell":
      return `Running ${String(a["command"] ?? "a command").slice(0, 60)}.`;
    case "read_file":
      return `Reading ${base(a["path"])}.`;
    case "write_file":
      return `Writing ${base(a["path"])}.`;
    case "edit_file":
      return `Editing ${base(a["path"])}.`;
    case "list_dir":
      return `Listing ${base(a["path"])}.`;
    case "search_files":
      return `Searching for ${String(a["pattern"] ?? "").slice(0, 40)}.`;
    case "web_fetch":
      return `Fetching ${hostOf(a["url"])}.`;
    case "web_search":
      return `Searching the web for ${String(a["query"] ?? "").slice(0, 50)}.`;
    case "applescript":
      return "Running an AppleScript.";
    case "open_url":
      return `Opening ${hostOf(a["url"])} in the browser.`;
    case "clipboard_read":
      return "Reading the clipboard.";
    case "clipboard_write":
      return "Copying to the clipboard.";
    case "self_edit":
      return "Starting a change to my own code.";
    case "self_check":
      return "Re-running my checks.";
    case "self_review":
      return "Looking at what I changed.";
    case "self_apply":
      return "Applying the change to myself.";
    case "self_discard":
      return "Throwing the change away.";
    case "self_status":
      return "Checking my pending changes.";
    case "agents_list":
      return "Checking the agents.";
    case "agent_send":
      return `Messaging ${String(a["agent"] ?? "an agent")}.`;
    case "agent_wait":
      return `Waiting on ${String(a["agent"] ?? "an agent")}.`;
    case "agent_read":
      return `Reading ${String(a["agent"] ?? "an agent")}'s output.`;
    // The thread tools are silent as a first tool (the scheduler's own split line speaks); these lines are for the timeline.
    case "thread_start":
      return `Starting ${String(a["name"] ?? "a second hand")} on the side.`;
    case "thread_wait":
      return `Waiting for ${a["name"] === "all" || a["name"] === undefined ? "the other hands" : String(a["name"])}.`;
    case "thread_read":
      return `Checking on ${String(a["name"] ?? "the other hand")}.`;
    case "thread_stop":
      return `Stopping ${String(a["name"] ?? "the other hand")}.`;
    // Automations: set while awake, fired by the daemon asleep (design11).
    case "automation_set":
      return `Setting ${String(a["name"] ?? "an automation")}.`;
    case "automation_list":
      return "Checking what is set.";
    case "automation_change":
      return `${String(a["verb"] ?? "Changing")} ${String(a["name"] ?? "an automation")}.`.replace(/^[a-z]/, (c) => c.toUpperCase());
    case "recipe_list":
      return "Checking the approved recipes.";
    case "frontmost_app":
      return "Checking which app is in front.";
    case "list_windows":
      return "Listing the open windows.";
    case "read_focused_text":
      return "Reading the focused text.";
    case "element_at":
      return "Inspecting that element.";
    case "mouse_move":
      return "Pointing at it.";
    case "show_circle":
    case "show_arrow":
    case "show_rect":
    case "show_text":
    case "show_stroke":
      return "Drawing on the screen.";
    case "show_clear":
      return "Clearing the drawings.";
    case "wait":
      return "Waiting a moment.";
    default:
      return `Checking ${name.replace(/_/g, " ")}.`;
  }
}
