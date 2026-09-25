import type { JSX } from "react";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import type { StatTile } from "@/content/copy";

/** Sixteen tiles on the seam grid: figure 32 px tabular + unit · label · mono proof. No accent on figures. */
export function StatGrid({ tiles }: { readonly tiles: readonly StatTile[] }): JSX.Element {
  return (
    <div className="sec-stats">
      <CardGrid cols={4}>
        {tiles.map((t) => (
          <Card key={t.label}>
            <div className="sec-stat">
              <div className="sec-stat-v">
                {t.figure}
                {t.unit ? <span className="sec-stat-u"> {t.unit}</span> : null}
              </div>
              <div className="sec-stat-l">{t.label}</div>
              <div className="sec-stat-p">{t.proof}</div>
            </div>
          </Card>
        ))}
      </CardGrid>
    </div>
  );
}
