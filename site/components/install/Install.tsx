import { Crop } from "@/components/ui/Crop";
import { Figure } from "@/components/ui/Figure";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { Block } from "@/components/sections/Block";
import { after, row, upTo } from "@/components/sections/cut";
import { NUMBERS } from "@/content/copy";
import { ONBOARDING, ONBOARDING_SIZE, PERMISSIONS_NOTE, SECTION_H2, SECTION_ID, SECTION_LEAD } from "@/content/install";
import { CommandRows } from "./CommandRows";
import { InstallPlate } from "./InstallPlate";
import { Requirements } from "./Requirements";

/** `16 permissions, 7 required` (NUMBERS.tiles[9].proof, README:332) cut into the figure, its label and its proof. */
const PERMS = upTo(row(NUMBERS.tiles, 9).proof, " · ");
const PERMS_FIGURE = upTo(PERMS, " ");
const PERMS_LABEL = upTo(after(PERMS, " "), ",");
const PERMS_PROOF = after(PERMS, ", ");
/** The seven required permissions, cut from PERMISSIONS_NOTE (README:437-452), one per line. */
const REQUIRED = upTo(after(PERMISSIONS_NOTE, "seven required: "), ".").split(", ");
const PERMISSIONS_SHOT = ONBOARDING[2]; // Setup, Permissions

/**
 * Section 11: the rail plate with the one-liner, then the four command rows beside the six
 * requirements, then one plate: the Permissions step at 1:1 with `16` as display type and the seven
 * required names as one block.
 */
export function Install() {
  return (
    <Section id={SECTION_ID} h2={SECTION_H2} lead={SECTION_LEAD}>
      <InstallPlate variant="rail" className="ins-plate--head" />
      <div className="ins-split">
        <div className="ins-col ins-col--commands">
          <CommandRows />
        </div>
        <div className="ins-col ins-col--checks">
          <Requirements />
        </div>
      </div>
      <Plate className="ins-perm-plate">
        <div className="sec-frame">
          <Crop src={PERMISSIONS_SHOT.src} alt={PERMISSIONS_SHOT.alt} width={ONBOARDING_SIZE.width} height={ONBOARDING_SIZE.height} scale={1} box={[620, 552]} fit />
          <div className="ins-perm">
            <Figure value={PERMS_FIGURE} label={PERMS_LABEL} proof={PERMS_PROOF} size="lg" />
            <Block items={REQUIRED} />
          </div>
        </div>
      </Plate>
    </Section>
  );
}
