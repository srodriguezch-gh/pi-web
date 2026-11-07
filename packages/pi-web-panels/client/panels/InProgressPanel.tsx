"use client";

import React from "react";
import { PanelCard, PanelRow, optionalNumber, optionalString, statusBadgeClass } from "./PanelCard";
import { usePanelData, type PanelItem } from "./usePanelData";

/**
 * In progress: what agents are working on right now, with elapsed time.
 *
 * Honesty rule: a run is only "running" when the route proves a live pid AND a
 * fresh heartbeat. Everything else renders its real status — `stalled` plus the
 * age — so a wedged run can never masquerade as progress. Stalled and failed
 * runs sort to the top; nothing is filtered out to make the panel look busy.
 */
export function InProgressPanel() {
  const { payload, error, loading, receivedAt } = usePanelData("in-progress");
  const items = payload?.items ?? [];

  const rank = (item: PanelItem) => {
    const status = (optionalString(item.status) ?? "").toLowerCase();
    if (item.stalled === true || /stall|dead|wedg|fail|error/.test(status)) return 0;
    return 1;
  };
  const sorted = [...items].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const ageA = typeof a.ageMs === "number" ? a.ageMs : -1;
    const ageB = typeof b.ageMs === "number" ? b.ageMs : -1;
    return ageB - ageA;
  });

  return (
    <PanelCard
      title="In progress"
      panelKey="in-progress"
      count={payload ? payload.count : null}
      shown={items.length}
      fetchedAt={receivedAt}
      cacheAgeMs={payload?.cacheAgeMs ?? null}
      stale={payload?.stale ?? false}
      ok={payload?.ok ?? false}
      error={error ?? payload?.error ?? null}
      loading={loading}
      emptyLabel="no agents running — nothing is in flight right now"
      source={payload?.source}
    >
      <ul className="m-0 p-0 list-none">
        {sorted.map((item) => {
          const status = optionalString(item.status);
          const stalled = item.stalled === true || /stall|dead|fail|error/i.test(status ?? "");
          // Never default a status to "running": an unknown run reads as unknown.
          const label = status ?? (item.stale ? "stale" : "unknown");
          const role = optionalString(item.role) ?? optionalString(item.kind);
          const progress = item.progress as { completed?: unknown; total?: unknown } | undefined;
          const completed = optionalNumber(progress?.completed);
          const total = optionalNumber(progress?.total);
          const href = optionalString(item.href) ?? `/runs/${encodeURIComponent(item.id)}`;
          return (
            <PanelRow
              key={item.id}
              item={item}
              ageMs={typeof item.ageMs === "number" ? item.ageMs : null}
              ageClass={statusBadgeClass(stalled ? "stalled" : "running")}
              href={href}
              tone={stalled ? "bg-rose-500/5" : undefined}
              badges={
                <>
                  <span
                    className={`px-1 py-0.5 rounded font-bold uppercase tracking-wide ${
                      statusBadgeClass(stalled ? "stalled" : "running")
                    }`}
                  >
                    {stalled ? (label.toLowerCase().includes("stall") ? label : `stalled · ${label}`) : label}
                  </span>
                  {role ? <span className="font-mono">{role}</span> : null}
                  {completed !== null && total !== null ? (
                    <span className="tabular-nums">
                      {completed}/{total} tasks
                    </span>
                  ) : null}
                  {stalled ? <span className="text-text-dim">pid/heartbeat not live</span> : null}
                </>
              }
            />
          );
        })}
      </ul>
    </PanelCard>
  );
}
