"use client";

import React from "react";
import { BacklogPanel } from "./BacklogPanel";
import { DecisionsPanel } from "./DecisionsPanel";
import { InProgressPanel } from "./InProgressPanel";
import { ScheduledRunsPanel } from "./ScheduledRunsPanel";

export { BacklogPanel } from "./BacklogPanel";
export { DecisionsPanel } from "./DecisionsPanel";
export { InProgressPanel } from "./InProgressPanel";
export { ScheduledRunsPanel } from "./ScheduledRunsPanel";
export { PanelCard } from "./PanelCard";
export { usePanelData } from "./usePanelData";
export type { PanelItem, PanelPayload, PanelKey } from "./usePanelData";

/**
 * The four operations panels, mounted on the home dashboard.
 *
 * Each panel polls its own route (/api/panels/<key>, 15s, matching the route's
 * cache TTL) and independently owns its empty / stale / unavailable rendering,
 * so one dead data source cannot make the whole group look blank — or healthy.
 */
export function PanelsGroup({ compact = false }: { compact?: boolean }) {
  return (
    <section aria-label="Operations panels" className="px-3 py-2 min-w-0">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          Operations — what is actually happening
        </h2>
        <span className="text-[9px] text-text-dim">
          auto-refresh 15s · stale, empty and unavailable states are shown, never hidden
        </span>
      </div>
      <div
        className={`grid grid-cols-1 ${compact ? "" : "sm:grid-cols-2"} gap-2 min-w-0`}
        data-testid="panels-group"
      >
        <BacklogPanel />
        <DecisionsPanel />
        <InProgressPanel />
        <ScheduledRunsPanel />
      </div>
    </section>
  );
}
