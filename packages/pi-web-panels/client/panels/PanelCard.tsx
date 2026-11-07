"use client";

import React, { useState } from "react";
import { formatElapsed } from "../BackgroundAgentsPanel";
import type { PanelItem } from "./usePanelData";

/**
 * Shared chrome + honesty primitives for the four operations panels.
 *
 * Every panel header carries its own count and a `last refreshed` stamp, and a
 * panel can only reach its empty state when the route said `ok: true`; a failed
 * route renders UNAVAILABLE plus the route's own error string. That is why the
 * empty/unavailable decision lives here in the card instead of in each panel —
 * a panel cannot pad its way to looking busy.
 */

/** Wall-clock stamp for "last refreshed", local time, seconds precision. */
export function formatClock(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Age severity for the decisions queue. Calibrated in hours, not days: the
 * live HITL queue's oldest pending row was ~20h, so a single day of waiting is
 * already the pathological case and must read as urgent.
 */
export function decisionAgeClass(ageMs: number | null | undefined): string {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
    return "bg-slate-500/20 text-slate-400 border border-slate-500/30";
  }
  if (ageMs >= 2 * 60 * 60 * 1000) return "bg-rose-500/20 text-rose-400 border border-rose-500/30";
  if (ageMs >= 30 * 60 * 1000) return "bg-amber-500/20 text-amber-400 border border-amber-500/30";
  return "bg-slate-500/20 text-slate-400 border border-slate-500/30";
}

/**
 * Status → badge classes. Local copy of the convention used by the sidebar's
 * Background Agents panel: `getStatusBadgeClass` is module-private over there
 * (components/BackgroundAgentsPanel.tsx:263) and this task must not edit that
 * file, so the mapping is duplicated here rather than coupled.
 */
export function statusBadgeClass(status: string): string {
  const s = (status || "").toLowerCase();
  if (s.includes("running") || s.includes("progress") || s.includes("active")) {
    return "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30";
  }
  if (s.includes("stalled") || s.includes("overdue") || s.includes("waiting") || s.includes("pending")) {
    return "bg-amber-500/20 text-amber-400 border border-amber-500/30";
  }
  if (s.includes("fail") || s.includes("error") || s.includes("dead") || s.includes("blocked")) {
    return "bg-rose-500/20 text-rose-400 border border-rose-500/30";
  }
  if (s.includes("complet") || s.includes("done") || s.includes("success")) {
    return "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
  }
  return "bg-slate-500/20 text-slate-400 border border-slate-500/30";
}

/** Read an optional string field without inventing one. */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface PanelCardProps {
  title: string;
  /** Stable id for the header/region (used by tests and a11y). */
  panelKey: string;
  count: number | null;
  /** How many items the body actually renders, for truncation honesty. */
  shown?: number;
  fetchedAt: number | null;
  cacheAgeMs: number | null;
  stale: boolean;
  ok: boolean;
  /** Route-level or transport-level error, rendered verbatim. */
  error: string | null;
  loading: boolean;
  emptyLabel: string;
  source?: string;
  children: React.ReactNode;
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`text-[9px] uppercase px-1.5 py-0.5 rounded font-bold tracking-wide whitespace-nowrap ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export function PanelCard({
  title,
  panelKey,
  count,
  shown,
  fetchedAt,
  cacheAgeMs,
  stale,
  ok,
  error,
  loading,
  emptyLabel,
  source,
  children,
}: PanelCardProps) {
  const [open, setOpen] = useState(true);
  const truncated = typeof shown === "number" && count !== null && shown < count;

  return (
    <section
      data-testid={`panel-${panelKey}`}
      className="rounded-xl border border-border bg-bg-panel/40 overflow-hidden flex flex-col min-w-0"
    >
      <header className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={`panel-body-${panelKey}`}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left bg-transparent border-0 p-0 cursor-pointer text-text hover:text-accent"
        >
          <span aria-hidden="true" className="text-[9px] text-text-dim w-2 shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <span className="text-[12px] font-semibold truncate">{title}</span>
          {/* Count is omitted when unavailable — never a fabricated 0. */}
          <span className="text-[11px] text-text-muted tabular-nums shrink-0">
            {ok && count !== null ? `(${count})` : "(—)"}
          </span>
        </button>
        <span className="flex items-center gap-1 shrink-0">
          {!ok && !loading ? <Chip className="bg-rose-500/20 text-rose-400 border border-rose-500/30">unavailable</Chip> : null}
          {ok && stale ? <Chip className="bg-amber-500/20 text-amber-400 border border-amber-500/30">stale</Chip> : null}
        </span>
      </header>

      {open ? (
        <div id={`panel-body-${panelKey}`} className="border-t border-border">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-2.5 py-1 text-[10px] text-text-dim">
            <span className="truncate" title={source ?? undefined}>
              last refreshed {formatClock(fetchedAt)}
            </span>
            <span className="tabular-nums whitespace-nowrap">
              {cacheAgeMs !== null && cacheAgeMs > 0 ? `data ${formatElapsed(cacheAgeMs)} old` : "fresh read"}
            </span>
          </div>

          {/* A failed refresh over last-good data is visible, not silent. */}
          {error ? (
            <div
              data-testid={`panel-${panelKey}-refresh-error`}
              className="border-y border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[10px] text-rose-400 break-words"
            >
              refresh failed: {error}
            </div>
          ) : null}

          {loading ? (
            <div className="px-2.5 py-3 text-[11px] text-text-muted italic">loading…</div>
          ) : !ok ? (
            <div
              data-testid={`panel-${panelKey}-unavailable`}
              className="px-2.5 py-3 text-[11px] text-rose-400 break-words"
            >
              <div className="font-bold tracking-wide mb-1">UNAVAILABLE</div>
              <div className="font-mono text-[10px] text-rose-300/80">{error ?? "route reported ok:false with no error string"}</div>
            </div>
          ) : count === 0 ? (
            <div
              data-testid={`panel-${panelKey}-empty`}
              className="px-2.5 py-3 text-[11px] text-text-muted"
            >
              {emptyLabel}
            </div>
          ) : (
            <>
              {children}
              {truncated ? (
                <div className="px-2.5 py-1 text-[10px] text-text-dim border-t border-border">
                  showing {shown} of {count}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** A single panel row: title on the left, age/badges pinned right. */
export function PanelRow({
  item,
  ageMs,
  ageClass,
  badges,
  meta,
  href,
  tone,
}: {
  item: PanelItem;
  ageMs?: number | null;
  ageClass?: string;
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  href?: string | null;
  tone?: string;
}) {
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span className="text-[11px] leading-snug text-text break-words flex-1 min-w-0" title={item.title}>
          {item.title}
        </span>
        <span className="flex flex-col items-end gap-0.5 shrink-0">
          {typeof ageMs === "number" ? (
            <Chip className={ageClass ?? statusBadgeClass("")}>{formatElapsed(ageMs)}</Chip>
          ) : null}
          {item.stale ? (
            <Chip className="bg-amber-500/20 text-amber-400 border border-amber-500/30">stale</Chip>
          ) : null}
        </span>
      </div>
      {badges || meta ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-text-dim">
          {badges}
          {meta}
        </div>
      ) : null}
    </>
  );
  return (
    <li
      className={`px-2.5 py-1.5 border-b border-border/60 last:border-b-0 hover:bg-bg-hover/40 ${tone ?? ""}`}
    >
      {href ? (
        <a href={href} className="no-underline text-inherit block">
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}
