import type { ReactElement } from "react";
import Slack from "@thesvg/react/slack";
import Spotify from "@thesvg/react/spotify";
import { Glyph, Group, Row } from "@/components/kit";
import { Fact, Figure } from "@/components/ui/Figure";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Pill } from "@/components/ui/Pill";
import { Section } from "@/components/ui/Section";
import { NUMBERS, SHOTS, THREADS } from "@/content/deck";
import { row } from "./cut";

const LIVE = row(NUMBERS.figures, 10); // `3` · live threads beside the main one · README:336

/** #threads: the h2, the lede, then the figure: the island acting (two thread tiles) at 1:1 beside the three lines as rows, Slack and Spotify wearing their marks. */
export function Threads(): ReactElement {
  return (
    <Section id={THREADS.id} h2={THREADS.h2} lead={THREADS.lead}>
      <Figure
        head={
          <>
            <Pill phase={THREADS.phase} />
            <Fact value={LIVE.value} label={LIVE.label} />
          </>
        }
      >
        <IslandStrip {...SHOTS.islandWorking} />
        <Group className="mr-rows">
          <Row size={13} icon={<Slack width={16} height={16} aria-hidden="true" focusable="false" />} title={THREADS.lines[0]} />
          <Row size={13} icon={<Spotify variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />} title={THREADS.lines[1]} />
          <Row size={13} icon={<Glyph name="stop" size={16} />} title={THREADS.lines[2]} />
        </Group>
      </Figure>
    </Section>
  );
}
