"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll hook for the honest panels (backlog / decisions / in-progress / scheduled).
 *
 * Contract (fixed, served by app/api/panels/<key>/route.ts):
 *   GET /api/panels/{backlog|decisions|in-progress|scheduled} -> 200 JSON
 *   { source, ok, error: string|null, fetchedAt, cacheAgeMs, stale, count, items[] }
 *   each item: { id, title, ageMs, stale, ...panel-specific }
 *
 * Honesty rules encoded here (not in the views, so no view can drift from them):
 *  - A transport/parse failure does NOT clear the panel and does NOT invent a
 *    zero. The last successful payload is kept and the failure is surfaced via
 *    `error`, so the view renders "last good data + FAILED to refresh".
 *  - A payload that is not the documented shape is treated as a failure, never
 *    coerced into `{ok: true, count: 0}`.
 *  - Polling never overlaps itself (setTimeout chain, not setInterval) and backs
 *    off while the tab is hidden, so a slow route cannot be hammered into a
 *    queue of stale responses.
 */

/** Poll cadence. Matches the route's 15s cache TTL: one request per TTL. */
export const PANEL_POLL_MS = 15_000;

/** Ages/elapsed labels re-render on this tick without re-fetching. */
export const PANEL_TICK_MS = 5_000;

export interface PanelItem {
  id: string;
  title: string;
  /** How old this item is (waiting/stalled/overdue). Absent is allowed. */
  ageMs?: number | null;
  /** True when the item itself is past its expected refresh. */
  stale?: boolean;
  /** Panel-specific extras: status, schedule, severity, href, progress, ... */
  [key: string]: unknown;
}

export interface PanelPayload {
  source: string;
  ok: boolean;
  error: string | null;
  fetchedAt: number;
  cacheAgeMs: number;
  stale: boolean;
  count: number;
  items: PanelItem[];
}

export type PanelKey = "backlog" | "decisions" | "in-progress" | "scheduled";

export interface PanelDataState<T extends PanelItem = PanelItem> {
  /** Last *successfully parsed* payload, or null before the first one. */
  payload: PanelPayload & { items: T[] } | null;
  /** Transient failure to refresh. Does not clear `payload`. */
  error: string | null;
  /** True until the first response (success or failure) lands. */
  loading: boolean;
  /** Client clock at the moment `payload` was received (epoch ms). */
  receivedAt: number | null;
  /** Ticking clock so ages/elapsed advance without a second timer. */
  now: number;
  /** Force an immediate refresh (bypasses the remaining interval). */
  refresh: () => void;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a response body, refusing anything that does not match the contract.
 * Returns `{ payload }` or `{ malformed: reason }`; never throws.
 */
export function parsePanelPayload(raw: unknown): { payload: PanelPayload } | { malformed: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { malformed: "response is not a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.ok !== "boolean") {
    return { malformed: "response has no boolean `ok`" };
  }
  if (!Array.isArray(body.items)) {
    return { malformed: "response has no `items` array" };
  }
  const items: PanelItem[] = [];
  for (const entry of body.items) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : null;
    if (id === null) continue;
    items.push({
      ...item,
      id,
      title: typeof item.title === "string" && item.title.length > 0 ? item.title : "(untitled)",
      ageMs: asNumber(item.ageMs),
      stale: item.stale === true,
    });
  }
  const count = asNumber(body.count);
  return {
    payload: {
      source: typeof body.source === "string" ? body.source : "unknown",
      ok: body.ok,
      error: typeof body.error === "string" ? body.error : null,
      fetchedAt: asNumber(body.fetchedAt) ?? Date.now(),
      cacheAgeMs: asNumber(body.cacheAgeMs) ?? 0,
      stale: body.stale === true,
      // The route's own count is authoritative; `items.length` is only a
      // fallback for a route that omits it. Never manufactured from 0.
      count: count ?? items.length,
      items,
    },
  };
}

export function usePanelData<T extends PanelItem = PanelItem>(key: PanelKey): PanelDataState<T> {
  const [payload, setPayload] = useState<(PanelPayload & { items: T[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Guards: no overlapping fetches, no state writes after unmount.
  const inFlight = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kick = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    // A hidden tab does not need fresh numbers; resuming re-arms immediately.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const url = `/api/panels/${key}`;
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      const text = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status} — non-JSON response: ${text.slice(0, 160)}`);
      }
      const parsed = parsePanelPayload(raw);
      if ("malformed" in parsed) {
        throw new Error(`HTTP ${response.status} — ${parsed.malformed}`);
      }
      if (!alive.current) return;
      setPayload(parsed.payload as PanelPayload & { items: T[] });
      setReceivedAt(Date.now());
      setError(null);
      setNow(Date.now());
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (!alive.current) return;
      // Keep the last good payload; flag that it could not be refreshed.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setLoading(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [key]);

  useEffect(() => {
    alive.current = true;

    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void load().finally(() => {
          if (alive.current) schedule();
        });
      }, PANEL_POLL_MS);
    };

    kick.current = () => {
      if (timer.current) clearTimeout(timer.current);
      void load().finally(() => {
        if (alive.current) schedule();
      });
    };

    void load().finally(() => {
      if (alive.current) schedule();
    });

    // Coming back to the tab refreshes immediately instead of waiting a tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") kick.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    const tick = setInterval(() => setNow(Date.now()), PANEL_TICK_MS);

    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tick);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [load]);

  const refresh = useCallback(() => {
    kick.current?.();
  }, []);

  return { payload, error, loading, receivedAt, now, refresh };
}
