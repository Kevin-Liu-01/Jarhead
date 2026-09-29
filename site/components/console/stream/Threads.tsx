import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { SHOTS, THREADS } from "@/content/deck";
import { from, upTo } from "@/lib/cut";
import { ThreadsRail } from "../railGroups";
import { Card, Sec, Tone } from "./parts";

const ASKED = upTo(THREADS.lead, " splits"); // "Tell Ben on Slack I'm late and put on Focus on Spotify"
const LEAD = from(THREADS.lead, 1); // Each has its own brain, conversation, budget and blob. Up to three run beside the main one.

/** 03 · Threads: the split as the app's own delegation card (the utterance as its head, one row per line with its badge), then the island acting; the Console's Threads group in the rail. */
export function Threads(): ReactElement {
  return (
    <Sec id={THREADS.id} name={THREADS.name} n={THREADS.n} phase={THREADS.phase} face={THREADS.face} h2={THREADS.h2} lead={LEAD} rail={<ThreadsRail />}>
      <Card icon={<Tone name="checkCircle" tone="acting" />} title={ASKED}>
        <Row size={13} icon={<Tone name="handRaised" tone="speaking" />} title={THREADS.lines[0]} badge={{ word: "asks", tone: "speaking" }} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={THREADS.lines[1]} badge={{ word: "done" }} />
        <Row size={13} icon={<Tone name="stop" />} title={THREADS.lines[2]} />
      </Card>
      <div className="sec-pic">
        <IslandStrip src={SHOTS.islandWorking.src} alt={SHOTS.islandWorking.alt} width={SHOTS.islandWorking.width} height={SHOTS.islandWorking.height} />
      </div>
    </Sec>
  );
}
