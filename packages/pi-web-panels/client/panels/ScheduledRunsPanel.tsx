"use client";

import React from "react";
import { PanelCard, PanelRow, formatClock, optionalNumber, optionalString, statusBadgeClass } from "./PanelCard";
import { usePanelData, type PanelItem } from "./usePanelData";

/**
 * Scheduled runs: the existing heart jobs registry (no second scheduler).
 * Fields per job: name, schedule, last run status, next fire time.
 *
 * Honesty rule: a job whose next_run is in the past renders OVERDUE with the
 * age of the miss, and a job whose last run failed renders its failure — both
 * sort above healthy jobs so they are seen first, not buried.
 */
export function ScheduledRunsPanel() {
  const { payload, error, loading, receivedAt, now } = usePanelData("scheduled");
  const items = payload?.items ?? [];

  const overdueFor = (item: PanelItem) => {
    const next = optionalNumber(item.nextRunAt);
    return next !== null && next < now ? now - next : null;
  };
  const failedLast = (item: PanelItem) =>
    /fail|error|abort|timeout/i.test(optionalString(item.lastStatus) ?? optionalString(item.status) ?? "");

  const sorted = [...items].sort((a, b) => {
    const rank = (item: typeof a) => (failedLast(item) ? 0 : overdueFor(item) !== null ? 1 : 2);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (overdueFor(b) ?? 0) - (overdueFor(a) ?? 0);
  });

  return (
    <PanelCard
      title="Scheduled runs"
      panelKey="scheduled"
      count={payload ? payload.count : null}
      shown={items.length}
      fetchedAt={receivedAt}
      cacheAgeMs={payload?.cacheAgeMs ?? null}
      stale={payload?.stale ?? false}
      ok={payload?.ok ?? false}
      error={error ?? payload?.error ?? null}
      loading={loading}
      emptyLabel="no scheduled jobs registered"
      source={payload?.source}
    >
      <ul className="m-0 p-0 list-none">
        {sorted.map((item) => {
          const schedule = optionalString(item.schedule);
          const lastStatus = optionalString(item.lastStatus) ?? optionalString(item.status);
          const nextRunAt = optionalNumber(item.nextRunAt);
          const overdueMs = overdueFor(item);
          const failed = failedLast(item);
          // An overdue job's most important fact is how late it is.
          const ageMs = overdueMs ?? (typeof item.ageMs === "number" ? item.ageMs : null);
          return (
            <PanelRow
              key={item.id}
              item={item}
              ageMs={ageMs}
              ageClass={statusBadgeClass(overdueMs !== null ? "overdue" : "")}
              tone={failed || overdueMs !== null ? "bg-rose-500/5" : undefined}
              href={optionalString(item.href)}
              badges={
                <>
                  {schedule ? <span className="font-mono truncate max-w-[35%]">{schedule}</span> : null}
                  {lastStatus ? (
                    <span className={`px-1 py-0.5 rounded font-bold uppercase tracking-wide ${statusBadgeClass(lastStatus)}`}>
                      last: {lastStatus}
                    </span>
                  ) : null}
                  {overdueMs !== null ? (
                    <span className="px-1 py-0.5 rounded font-bold uppercase tracking-wide bg-rose-500/20 text-rose-400 border border-rose-500/30">
                      overdue
                    </span>
                  ) : nextRunAt !== null ? (
                    <span className="tabular-nums">next {formatClock(nextRunAt)}</span>
                  ) : (
                    <span className="text-text-dim">no next fire time</span>
                  )}
                </>
              }
            />
          );
        })}
      </ul>
    </PanelCard>
  );
}
