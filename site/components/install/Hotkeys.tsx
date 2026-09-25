import { Chips } from "@/components/ui/Chips";
import { HOTKEYS } from "@/content/install";

/** The hotkeys as one wrapping row of chips (README:424-435). */
export function Hotkeys() {
  return (
    <div className="ins-hotkeys">
      <Chips items={HOTKEYS} />
    </div>
  );
}
