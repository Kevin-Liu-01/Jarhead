import { readFileSync } from "node:fs";
import { logger } from "@jarhead/core";
import type { Rect } from "@jarhead/protocol";
import type { BrainAttachment, BrainTask } from "./brain.ts";

/**
 * Images that ride along with a task — today the regions Kevin circled on his
 * screen. The delegator turns pending ScreenMarks into BrainAttachments; each
 * brain calls `loadAttachments` and encodes the pixels the way its transport
 * takes them (image blocks, image_url parts, `-i` files, input_image items).
 * The note is the same words everywhere so a "what is this?" means the same
 * thing to every backend.
 */

const log = logger("brain.attachments");

export interface LoadedAttachment extends BrainAttachment {
  readonly pngBase64: string;
}

/** Read the task's attachments; an unreadable file is logged and skipped, never fatal. */
export function loadAttachments(task: BrainTask): LoadedAttachment[] {
  const out: LoadedAttachment[] = [];
  for (const a of task.attachments ?? []) {
    try {
      out.push({ ...a, pngBase64: readFileSync(a.path).toString("base64") });
    } catch (e) {
      log.warn(`attachment ${a.path} unreadable: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * The note every brain reads with a circled region: where it is, in global
 * points, and — once it is more than a minute old — how long ago, so a circle
 * from before a nap is weighed as such rather than read as "this, right now".
 */
export function markNote(rect: Rect, ageMs = 0): string {
  const where = `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}×${Math.round(rect.h)} (global points)`;
  return `Kevin circled this region of his screen: ${where}${markAge(ageMs)}`;
}

function markAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 120) return `, circled ${minutes} min ago`;
  return `, circled ${Math.round(minutes / 60)} h ago`;
}

/**
 * The lines the prompt carries so the model knows what each attached image is.
 * Pass the images that actually go to the model with this prompt — the numbering
 * must match what the transport sends, not what the task listed.
 */
export function attachmentsPreamble(attachments: readonly BrainAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  const lines = attachments.map((a, i) => `Attached image ${i + 1}: ${a.note}`);
  if (attachments.some((a) => a.kind !== "screen")) lines.push("Treat the circled region as what Kevin means by \"this\"; look at it before answering.");
  return lines.join("\n");
}

/**
 * The note on the pre-warm screenshot: the display under the cursor as the task
 * began. It is the "last screenshot" the toolset maps coordinates through, so the
 * model can click on it straight away instead of spending its first turn looking.
 * With the composite look (`controls` > 0) the task's first note lists the front
 * window's labelled controls with their centres in this image's pixels: the model
 * can `click_element` by name or `left_click` a centre without a zoom to read the labels.
 */
export function screenNote(width: number, height: number, detail = "", controls = 0): string {
  const listed = controls > 0 ? ` The ${controls} controls listed in the notes below are on this screenshot, centres in its pixels: click_element them by name, or left_click a centre.` : "";
  return `the screen right now (${width}x${height} px${detail ? `, ${detail}` : ""}), taken as this task began. This counts as your last screenshot: click coordinates are pixels of this image.${listed} Act on it directly; take another screenshot only after the screen has changed.`;
}

/**
 * The same regions named without claiming pixels: for a turn kept as history
 * (the image is not carried into later turns) and for transports that cannot
 * take images. The coordinates stay, so "click it" a turn later still has a where.
 */
export function attachmentsRecap(attachments: readonly BrainAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  return attachments.map((a) => a.note).join("\n");
}
