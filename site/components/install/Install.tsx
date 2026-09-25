import { Screen } from "@/components/ui/Screen";
import { Section } from "@/components/ui/Section";
import {
  KEYS_PARAGRAPH,
  ONBOARDING,
  ONBOARDING_SIZE,
  PERMISSIONS_NOTE,
  SECTION_H2,
  SECTION_ID,
  SECTION_LABEL,
  SECTION_LEAD,
} from "@/content/install";
import { CommandRows, RichText } from "./CommandRows";
import { Hotkeys } from "./Hotkeys";
import { InstallPlate } from "./InstallPlate";
import { Requirements } from "./Requirements";
import { SetupSteps } from "./SetupSteps";

/**
 * Section 11 (design.md §2.11): the rail plate with the one-liner (the dominant element), then the
 * 2/3 + 1/3 row (the command rows, the keys and signing paragraph, the hotkeys · the six requirements
 * and the seven Setup steps), then the onboarding 2 × 2 beside the permissions note.
 */
export function Install() {
  return (
    <Section id={SECTION_ID} label={SECTION_LABEL} h2={SECTION_H2} lead={SECTION_LEAD}>
      <InstallPlate variant="rail" className="ins-plate--head" />
      <div className="ins-split">
        <div className="ins-col ins-col--commands">
          <CommandRows />
          <p className="ins-keys">
            <RichText parts={KEYS_PARAGRAPH} />
          </p>
          <Hotkeys />
        </div>
        <div className="ins-col ins-col--checks">
          <Requirements />
          <SetupSteps />
        </div>
      </div>
      <div className="ins-setup">
        <div className="ins-shots">
          {ONBOARDING.map((s) => (
            <Screen
              key={s.src}
              src={s.src}
              alt={s.alt}
              width={ONBOARDING_SIZE.width}
              height={ONBOARDING_SIZE.height}
              maxWidth={ONBOARDING_SIZE.maxWidth}
              ground="screen"
            />
          ))}
        </div>
        <p className="ins-perm">{PERMISSIONS_NOTE}</p>
      </div>
    </Section>
  );
}
