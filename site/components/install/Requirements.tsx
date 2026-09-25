import { Icon } from "@/components/ui/Icons";
import { REQUIREMENTS, REQUIREMENTS_HEAD } from "@/content/install";
import { RichText } from "./CommandRows";

/** Six checks under `Requirements · 6`, a solid check glyph on a 16 px column; the certificate is sixth. */
export function Requirements() {
  return (
    <div className="ins-list">
      <h3 className="ins-list-head">
        {REQUIREMENTS_HEAD.word}
        <span className="ins-list-count"> · {REQUIREMENTS_HEAD.count}</span>
      </h3>
      <ul className="ins-req">
        {REQUIREMENTS.map((r, i) => (
          <li key={i}>
            <Icon.check size={16} />
            <span>
              <RichText parts={r} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
