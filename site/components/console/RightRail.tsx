"use client";
import type { ReactElement } from "react";
import { Group, GroupHead, Meter } from "@/components/kit";
import { NUMBERS } from "@/content/deck";
import { part, row } from "@/lib/cut";
import { useLive } from "@/lib/live";
import { RAIL_GROUPS } from "./railGroups";
import { AudioRows, Session } from "./Session";
import { Tone } from "./stream/parts";

const TOOLS = row(NUMBERS.figures, 8); // 71 · 16 permissions, 7 required · 6 brains + auto
const REQUIRED = part(TOOLS.tip, "7 required");

/**
 * The right rail (RightRailView.swift; every Console shot): the phase card, Audio's two meters, Permissions as a group
 * with its count, the required figure and the 7/16 meter; then the group of the conversation in view (railGroups.tsx),
 * arriving as the app's fold content does. Sticky beside the stream; a phone folds each group into its section instead.
 */
export function RightRail(): ReactElement {
  const live = useLive();
  const Sec = RAIL_GROUPS[live.section];
  return (
    <aside className="rr">
      <Session />
      <Group className="rr-group" head={<GroupHead title="Audio" rule />}>
        <li className="rr-audio-host">
          <AudioRows />
        </li>
      </Group>
      <Group className="rr-group" head={<GroupHead title="Permissions" count={16} figure={REQUIRED} rule />}>
        <li className="rr-meter-row rr-meter-row--pad">
          <span className="kit-icon">
            <Tone name="checkCircle" tone="acting" />
          </span>
          <Meter fraction={7 / 16} width={160} height={6} />
          <span className="rr-mono rr-level">7/16</span>
        </li>
      </Group>
      {Sec ? (
        <div key={live.section} className="rr-sec">
          <Sec />
        </div>
      ) : null}
    </aside>
  );
}
