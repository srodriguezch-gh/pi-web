"use client";

import React from "react";
import { PanelCard, PanelRow, optionalString, statusBadgeClass } from "./PanelCard";
import { usePanelData } from "./usePanelData";

/**
 * Backlog: queued work that has not started.
 * Source (route-side): /home/silvio/plans/task-board.md,
 * /home/silvio/plans/cac-llc-migration/BACKLOG.md, /home/silvio/plans/queued/*.md.
 * A `plans/queued/` file whose own header says `Status: queued` arrives here
 * with that status string verbatim and is rendered as-is.
 */
export function BacklogPanel() {
  const { payload, error, loading, receivedAt } = usePanelData("backlog");
  const items = payload?.items ?? [];

  return (
    <PanelCard
      title="Backlog"
      panelKey="backlog"
      count={payload ? payload.count : null}
      shown={items.length}
      fetchedAt={receivedAt}
      cacheAgeMs={payload?.cacheAgeMs ?? null}
      stale={payload?.stale ?? false}
      ok={payload?.ok ?? false}
      error={error ?? payload?.error ?? null}
      loading={loading}
      emptyLabel="no open items — the backlog is genuinely empty"
      source={payload?.source}
    >
      <ul className="m-0 p-0 list-none">
        {items.map((item) => {
          const status = optionalString(item.status);
          const section = optionalString(item.section) ?? optionalString(item.board);
          const origin = optionalString(item.source) ?? optionalString(item.path);
          return (
            <PanelRow
              key={item.id}
              item={item}
              ageMs={typeof item.ageMs === "number" ? item.ageMs : null}
              href={optionalString(item.href)}
              badges={
                <>
                  {status ? (
                    <span
                      className={`px-1 py-0.5 rounded font-bold uppercase tracking-wide ${statusBadgeClass(status)}`}
                      title="status as written in the source file"
                    >
                      {status}
                    </span>
                  ) : null}
                  {section ? <span className="font-mono">{section}</span> : null}
                  {origin ? (
                    <span className="font-mono truncate max-w-[60%]" title={origin}>
                      {origin}
                    </span>
                  ) : null}
                </>
              }
            />
          );
        })}
      </ul>
    </PanelCard>
  );
}
