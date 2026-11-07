"use client";

import React from "react";
import { PanelCard, PanelRow, decisionAgeClass, optionalString } from "./PanelCard";
import { usePanelData } from "./usePanelData";

/**
 * Decisions waiting on Silvio: the HITL queue behind home.silrod.org/business
 * (`heart.watchdog_approvals` WHERE decision IS NULL, served by the route).
 *
 * Age is a first-class signal here: rows sort oldest-first and the age chip
 * escalates (30m amber → 2h rose), so a decision that has been sitting for days
 * cannot look neutral next to one that arrived a minute ago.
 */
export function DecisionsPanel() {
  const { payload, error, loading, receivedAt } = usePanelData("decisions");
  const items = payload?.items ?? [];
  // Oldest first — the most overdue decision is the one that most needs a look.
  const sorted = [...items].sort((a, b) => {
    const ageA = typeof a.ageMs === "number" ? a.ageMs : -1;
    const ageB = typeof b.ageMs === "number" ? b.ageMs : -1;
    return ageB - ageA;
  });

  return (
    <PanelCard
      title="Decisions waiting on you"
      panelKey="decisions"
      count={payload ? payload.count : null}
      shown={items.length}
      fetchedAt={receivedAt}
      cacheAgeMs={payload?.cacheAgeMs ?? null}
      stale={payload?.stale ?? false}
      ok={payload?.ok ?? false}
      error={error ?? payload?.error ?? null}
      loading={loading}
      emptyLabel="nothing is waiting on you — the approvals queue is empty"
      source={payload?.source}
    >
      <ul className="m-0 p-0 list-none">
        {sorted.map((item) => {
          const reason = optionalString(item.reason) ?? optionalString(item.asking) ?? optionalString(item.action);
          const endpoint = optionalString(item.endpoint) ?? optionalString(item.kind);
          const ageMs = typeof item.ageMs === "number" ? item.ageMs : null;
          const urgent = ageMs !== null && ageMs >= 2 * 60 * 60 * 1000;
          return (
            <PanelRow
              key={item.id}
              item={item}
              ageMs={ageMs}
              ageClass={decisionAgeClass(ageMs)}
              href={optionalString(item.href)}
              tone={urgent ? "bg-rose-500/5" : undefined}
              badges={
                <>
                  <span className="text-text-dim">waiting</span>
                  {endpoint ? <span className="font-mono truncate max-w-[45%]">{endpoint}</span> : null}
                  {reason ? (
                    <span className="text-text-muted truncate max-w-[70%]" title={reason}>
                      {reason}
                    </span>
                  ) : null}
                  {urgent ? (
                    <span className="px-1 py-0.5 rounded font-bold uppercase tracking-wide bg-rose-500/20 text-rose-400 border border-rose-500/30">
                      overdue
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
