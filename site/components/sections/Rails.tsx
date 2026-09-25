import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { NeverPanel } from "./NeverPanel";
import { RAILS } from "@/content/copy";
import { row, upTo } from "./cut";

/** 05 · Rails: the never-list as one block of seven lines on the ink plate; two rails and the self-edit beside the head. */
export function Rails(): JSX.Element {
  return (
    <Section
      id={RAILS.id}
      phase="speaking"
      h2={RAILS.h2}
      lead={upTo(RAILS.lead, " Send, pay")} // the first sentence, README:41
      lines={[
        { glyph: "stop", text: row(RAILS.rows, 5).title }, // § 6 · README:40
        { glyph: "check", text: row(RAILS.rows, 3).title }, // § 4 · README:338
        { glyph: "eraser", text: RAILS.rewrites.h3 }, // README:56
      ]}
    >
      <Plate ink>
        <NeverPanel label={RAILS.never.label} list={RAILS.never.list} line={RAILS.never.line} />
      </Plate>
    </Section>
  );
}
