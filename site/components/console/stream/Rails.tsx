import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { RAILS, SHOTS } from "@/content/deck";
import { first } from "@/lib/cut";
import { NeverRail } from "../railGroups";
import { Cut, Pic, Sec, Tone } from "./parts";

const CONVERSATION = { ...SHOTS.consoleDark, width: 1600, height: 1030 } as const;
/** The alt's first sentence: the frame holds the session's head, its `asks` badge and `needs Kevin's yes or no`; the Allow and Deny buttons sit at the pane's foot, 120 px of bare stream under the last row, outside a 4:3 window at 0.5×, so the caption does not name them. */
const CAPTION = first(CONVERSATION.alt, 1); // A Claude Code session in the Console.

/** 05 · Rails (picture right): the three lines as rows; the Claude Code session's stream at 0.5× (console-conversation.jpg, the stream pane from x 384, y 72 at 2×: the session that asks, `needs Kevin's yes or no`, its Read · Edit · Bash rows); the never-list is the rail's group (railGroups.tsx). */
export function Rails(): ReactElement {
  return (
    <Sec
      id={RAILS.id}
      name={RAILS.name}
      n={RAILS.n}
      h2={RAILS.h2}
      lead={RAILS.lead}
      side="right"
      rail={<NeverRail />}
      pic={
        <Pic caption={CAPTION}>
          <Cut shot={CONVERSATION} scale={0.5} x={192} y={36} />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={RAILS.lines[0]} />
        <Row size={13} icon={<Tone name="handRaised" tone="speaking" />} title={RAILS.lines[1]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={RAILS.lines[2]} />
      </ul>
    </Sec>
  );
}
