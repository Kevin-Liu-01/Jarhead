"use client";
import type { ReactElement } from "react";
import { ISLAND } from "@/components/desk/Island";
import { CopyButton } from "@/components/install/CopyButton";
import { Glyph, TIPS } from "@/components/kit";
import { INSTALL } from "@/content/deck";
import { CMD, HOST, SCRIPT, TAIL } from "@/content/oneLiner";
import { useLive } from "@/lib/live";

/**
 * The stream's composer (StreamView.swift; console-threads.jpg): Pause · Mute · the Say box · Send · Stop, 32 tall on
 * one row, sticky at the stream's foot. A drawing of the app's own row (aria-hidden): the Say box types the utterance
 * while the island listens (Top.tsx writes [data-say-typed]) and keeps the last line said. While the Install conversation
 * is in view the composer becomes the install field (IMMERSE.md §7): the one-liner in the mono field, the primary Copy
 * in the Send slot; the drawn tiles stay drawings.
 */
export function Composer(): ReactElement {
  const live = useLive();
  if (live.section === INSTALL.id) {
    return (
      <div className="cp" data-mode="install">
        <span className="kit-btn kit-btn--ghost kit-btn--icon cp-btn" aria-hidden="true">
          <Glyph name="pause" size={16} />
        </span>
        <span className="kit-btn kit-btn--ghost kit-btn--icon cp-btn" aria-hidden="true">
          <Glyph name="mic" size={16} />
        </span>
        <code className="kit-field kit-field--composer is-mono cp-code">
          <span className="ins-seg">{CMD}</span> <span className="ins-seg">{HOST}</span>
          <wbr />
          <span className="ins-seg">{SCRIPT}</span> <span className="ins-seg">{TAIL}</span>
        </code>
        <CopyButton text={INSTALL.code} kind="primary" size={32} label={`${INSTALL.copy}: ${INSTALL.code}`} />
      </div>
    );
  }
  return (
    <div className="cp" aria-hidden="true">
      <span className="kit-btn kit-btn--ghost kit-btn--icon cp-btn">
        <Glyph name="pause" size={16} />
      </span>
      <span className="kit-btn kit-btn--ghost kit-btn--icon cp-btn">
        <Glyph name="mic" size={16} />
      </span>
      <span className="kit-field kit-field--composer cp-say" data-say>
        <span className="cp-ph">{ISLAND.sayAwake}</span>
        <span className="cp-typed" data-say-typed />
        <span className="cp-caret" />
      </span>
      <span className="kit-btn kit-btn--ghost kit-btn--icon cp-btn">
        <Glyph name="send" size={16} />
      </span>
      <span className="kit-btn kit-btn--ghost cp-btn cp-stop">
        <Glyph name="stop" size={16} />
        <span className="kit-btn-label">{TIPS.stop.name}</span>
      </span>
    </div>
  );
}
