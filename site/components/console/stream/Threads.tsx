import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { SHOTS, THREADS } from "@/content/deck";
import { ThreadsRail } from "../railGroups";
import { Cut, Pic, Sec, Tone } from "./parts";

/** 03 · Threads (picture right): the three lines as rows with the app's badges; the split in the Console's stream at 0.5× (console-threads.jpg, the stream pane from x 372, y 436 at 2×, the pane's text centred in the window with 4 px to each hairline: the three thread_start rows and Slack's ask); the Now rail's Threads group in the rail. */
export function Threads(): ReactElement {
  return (
    <Sec
      id={THREADS.id}
      name={THREADS.name}
      n={THREADS.n}
      h2={THREADS.h2}
      lead={THREADS.lead}
      side="right"
      rail={<ThreadsRail />}
      pic={
        <Pic caption={SHOTS.consoleThreads.alt}>
          <Cut shot={SHOTS.consoleThreads} scale={0.5} x={186} y={218} />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="handRaised" tone="speaking" />} title={THREADS.lines[0]} badge={{ word: "asks", tone: "speaking" }} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={THREADS.lines[1]} badge={{ word: "done" }} />
        <Row size={13} icon={<Tone name="stop" />} title={THREADS.lines[2]} />
      </ul>
    </Sec>
  );
}
