import type { ReactElement } from "react";
import { CopyButton } from "@/components/install/CopyButton";
import { Group, Row } from "@/components/kit";
import { INSTALL, SHOTS } from "@/content/deck";
import { from, upTo } from "@/lib/cut";
import { InstallRail } from "../railGroups";
import { Cut, Pic, Sec, Tone } from "./parts";

/** The note's last two sentences, whole; the URL closes it and renders as the link. */
const NOTE = from(INSTALL.note, 3);
const NOTE_HEAD = upTo(NOTE, INSTALL.url);
if (!NOTE.endsWith(INSTALL.url)) throw new Error("the plate note no longer ends with the script's URL");
/** The lead from its second sentence: the title row's `source only` label already says the first. */
const LEAD = from(INSTALL.lead, 1); // One line clones the repo and runs four commands. Setup opens on first launch and writes your key.

/**
 * Install (picture left) as a Console pane (IMMERSE.md §7): the h2 and the lead, the note with the linked script; the four
 * commands as tool rows (terminal glyph, mono title, the README comment as the meta line, a ghost Copy in the verb slot),
 * the spoken fifth row; the three lines. The picture is the Setup wizard's Permissions pane at 1× (onboarding-permissions.png
 * from x 190, y 199: the required fold's head and its rows down to the pane's own edge, where the app clips Input
 * Monitoring), captioned with the deck's alt. The one-liner is the stream's composer while this
 * conversation is in view (console/Composer.tsx); Requirements is the rail's group.
 */
export function Install(): ReactElement {
  return (
    <Sec
      id={INSTALL.id}
      name={INSTALL.name}
      label={INSTALL.label}
      h2={INSTALL.h2}
      lead={LEAD}
      side="left"
      rail={<InstallRail />}
      pic={
        <Pic caption={SHOTS.setupPermissions.alt}>
          <Cut shot={SHOTS.setupPermissions} scale={1} x={190} y={199} />
        </Pic>
      }
    >
      <p className="ins-note">
        {NOTE_HEAD}
        <a href={INSTALL.url} rel="noopener">
          {INSTALL.url}
        </a>
      </p>
      <Group className="ins-cmds">
        {INSTALL.commands.map((c) => (
          <Row
            key={c.cmd}
            size={13}
            mono
            icon={<Tone name="terminal" />}
            title={c.cmd}
            meta={"note" in c ? c.note : undefined}
            trailing={
              <span className="kit-row-verb">
                <CopyButton text={c.cmd} kind="ghost" size={24} />
              </span>
            }
          />
        ))}
        <Row size={13} icon={<Tone name="mic" tone="listening" />} title={INSTALL.then} />
      </Group>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="key" />} title={INSTALL.lines[0]} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={INSTALL.lines[1]} />
        <Row size={13} icon={<Tone name="terminal" />} title={INSTALL.lines[2]} />
      </ul>
    </Sec>
  );
}
