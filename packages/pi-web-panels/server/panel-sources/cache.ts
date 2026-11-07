/**
 * Shared plumbing for the four "honest panels" API routes:
 *   /api/panels/backlog       → lib/panel-sources/backlog.ts
 *   /api/panels/decisions     → lib/panel-sources/decisions.ts
 *   /api/panels/in-progress   → lib/panel-sources/runs.ts
 *   /api/panels/scheduled     → lib/panel-sources/scheduled.ts
 *
 * Design rules (the whole point of these panels is that they do not lie):
 *  - Never fabricate. A source that could not be read yields `ok: false`,
 *    `error: <exact message>`, `items: []` — never a zero that looks real.
 *  - `fetchedAt` is the time of the *real* fetch that produced the payload,
 *    never the time of the read. `cacheAgeMs` is served alongside it so the
 *    UI can say "last refreshed <n>s ago" truthfully.
 *  - Every panel item carries `ageMs` (null when genuinely unknown) and
 *    `stale`, so staleness is a property of the data, not of the styling.
 *
 * Caching: module-level Map keyed per source, TTL 15s, with in-flight
 * dedupe — ten concurrent polls of a cold key cause exactly one fetch.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A panel payload is reused for this long before a re-read is attempted. */
export const PANEL_CACHE_TTL_MS = 15_000;
/** Hard ceiling on any network/DB/subprocess read a panel performs. */
export const PANEL_FETCH_TIMEOUT_MS = 6_000;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Age thresholds that drive the "urgent / warning / normal" badge. */
export const AGE_URGENT_MS = 24 * HOUR_MS;
export const AGE_WARNING_MS = 4 * HOUR_MS;

export type PanelSeverity = "urgent" | "warning" | "normal";

export interface PanelItemBase {
  /** Stable within a poll, so React keys and diffs behave. */
  id: string;
  /** One bounded line suitable for a list row. */
  title: string;
  /**
   * Age of this item's freshest evidence, in ms (null = genuinely unknown,
   * e.g. a file with no timestamped content). Per-source semantics are
   * documented in each module — it is never invented.
   */
  ageMs: number | null;
  /**
   * true when the item is past its expected refresh. Per-source semantics are
   * documented in each module (e.g. a run with a dead pid, a job that is
   * overdue, a decision older than its 24h attention budget).
   */
  stale: boolean;
}

export interface PanelEnvelope<T extends PanelItemBase = PanelItemBase> {
  /** Which panel this payload belongs to ("backlog" | "decisions" | ...). */
  source: string;
  /** true only when the underlying source actually answered. */
  ok: boolean;
  /** Exact error text when ok === false; null otherwise. */
  error: string | null;
  /** ISO timestamp of the real fetch behind this payload. */
  fetchedAt: string;
  /** How long ago that fetch happened (grows while served from cache). */
  cacheAgeMs: number;
  /** true when the served payload is older than PANEL_CACHE_TTL_MS. */
  stale: boolean;
  /** items.length, so the header count cannot drift from the list. */
  count: number;
  items: T[];
  /**
   * Honest fallback marker: when a re-read fails we return ok:false and empty
   * items, but still report when the last good payload was captured and how
   * many items it had, instead of pretending we know nothing.
   */
  lastGoodAt: string | null;
  lastGoodCount: number | null;
}

/** Filesystem locations. Overridable so the parsers are unit-testable. */
export function plansRoot(): string {
  const override = process.env.PI_PLANS_ROOT;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), "plans");
}

/** Base URL of the heart service that owns approvals + the jobs registry. */
export function heartApiBases(): string[] {
  const override = process.env.HEART_API_BASE;
  const bases: string[] = [];
  if (override && override.trim().length > 0) bases.push(override.replace(/\/+$/, ""));
  bases.push("http://127.0.0.1:8005");
  bases.push("https://home.silrod.org");
  return bases;
}

interface CacheSlot {
  envelope: PanelEnvelope<PanelItemBase>;
  storedAt: number;
  lastGoodAt: string | null;
  lastGoodCount: number | null;
}

/** Module-level cache: one slot per source key. Survives between requests. */
const slots = new Map<string, CacheSlot>();
/** In-flight reads, so concurrent polls share one fetch. */
const inflight = new Map<string, Promise<PanelEnvelope<PanelItemBase>>>();

/** Exact, non-lossy description of why something failed. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${name}${error.message}`;
  }
  return String(error);
}

function failedEnvelope<T extends PanelItemBase>(
  source: string,
  now: number,
  error: unknown,
  lastGoodAt: string | null,
  lastGoodCount: number | null,
): PanelEnvelope<T> {
  return {
    source,
    ok: false,
    error: describeError(error),
    fetchedAt: new Date(now).toISOString(),
    cacheAgeMs: 0,
    stale: false,
    count: 0,
    items: [],
    lastGoodAt,
    lastGoodCount,
  };
}

/**
 * Read a panel through the shared 15s cache.
 *
 * `produce` must itself be bounded (timeouts) and must not throw for expected
 * failures — it may simply return an envelope with `ok: false`. If it throws
 * anyway, the throw is converted into an `ok: false` envelope here so a route
 * can never 500 because of a data source.
 */
export async function readPanel<T extends PanelItemBase>(
  source: string,
  produce: (now: number) => Promise<PanelEnvelope<T>>,
): Promise<PanelEnvelope<T>> {
  const now = Date.now();
  const slot = slots.get(source);
  if (slot && now - slot.storedAt <= PANEL_CACHE_TTL_MS) {
    return asTyped<T>({ ...slot.envelope, cacheAgeMs: now - slot.storedAt, stale: false });
  }

  let pending = inflight.get(source);
  if (!pending) {
    pending = (async (): Promise<PanelEnvelope<PanelItemBase>> => {
      const startedAt = Date.now();
      const previous = slots.get(source);
      let envelope: PanelEnvelope<PanelItemBase>;
      try {
        envelope = asBase<T>(await produce(startedAt));
      } catch (error) {
        envelope = failedEnvelope<PanelItemBase>(
          source,
          startedAt,
          error,
          previous?.lastGoodAt ?? null,
          previous?.lastGoodCount ?? null,
        );
      }
      const good = envelope.ok;
      slots.set(source, {
        envelope,
        storedAt: Date.now(),
        lastGoodAt: good ? envelope.fetchedAt : (previous?.lastGoodAt ?? null),
        lastGoodCount: good ? envelope.items.length : (previous?.lastGoodCount ?? null),
      });
      return envelope;
    })().finally(() => {
      inflight.delete(source);
    });
    inflight.set(source, pending);
  }

  const settled = await pending;
  const stored = slots.get(source);
  const age = stored ? Math.max(0, Date.now() - stored.storedAt) : 0;
  return asTyped<T>({ ...settled, cacheAgeMs: age, stale: age > PANEL_CACHE_TTL_MS });
}

/** Test-only: drop cached payloads so a fresh read happens next call. */
export function resetPanelCache(source?: string): void {
  if (source === undefined) {
    slots.clear();
    inflight.clear();
    return;
  }
  slots.delete(source);
  inflight.delete(source);
}

function asBase<T extends PanelItemBase>(envelope: PanelEnvelope<T>): PanelEnvelope<PanelItemBase> {
  return envelope as unknown as PanelEnvelope<PanelItemBase>;
}

function asTyped<T extends PanelItemBase>(envelope: PanelEnvelope<PanelItemBase>): PanelEnvelope<T> {
  return envelope as unknown as PanelEnvelope<T>;
}

// ---------------------------------------------------------------------------
// formatting / parsing helpers shared by the four panels
// ---------------------------------------------------------------------------

/** Collapse a value to a single bounded line (never multi-line in a row). */
export function boundLine(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const collapsed = first.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Parse an ISO string that has NO timezone designator as UTC.
 *
 * The heart scheduler stores/emits naive timestamps (`2026-10-28T19:01:18.82`)
 * that are UTC, but `new Date("2026-10-28T19:01:18.82")` reads them as the
 * *host* local zone (America/New_York, -04:00 here) and silently shifts ages by
 * four hours. Everything is therefore normalized to explicit UTC.
 */
export function parseNaiveUtc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const iso = hasZone ? raw : `${raw}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return parseNaiveUtc(value);
}

export function isoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function ageOf(now: number, ms: number | null): number | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.max(0, now - ms);
}

export function urgencyForAgeMs(ageMs: number | null): PanelSeverity {
  if (ageMs === null || !Number.isFinite(ageMs)) return "normal";
  if (ageMs >= AGE_URGENT_MS) return "urgent";
  if (ageMs >= AGE_WARNING_MS) return "warning";
  return "normal";
}

/** mtime of a file, or null when it is missing/unreadable. Never throws. */
export function fileMtimeMs(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Read a UTF-8 text file, or return null plus the reason. Never throws. */
export function readTextFile(path: string): { text: string | null; error: string | null } {
  try {
    return { text: readFileSync(path, "utf8"), error: null };
  } catch (error) {
    return { text: null, error: describeError(error) };
  }
}

/**
 * Fetch JSON, trying each base URL in order with an explicit timeout.
 * Returns the first successful parse, or the exact error from the last try.
 */
export async function fetchJsonFromBases(
  bases: string[],
  path: string,
  timeoutMs = PANEL_FETCH_TIMEOUT_MS,
): Promise<{ body: unknown; url: string } | { error: string }> {
  let lastError = "no base URL configured";
  for (const base of bases) {
    const url = `${base}${path}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastError = `${url} → HTTP ${response.status} ${response.statusText}`.trim();
        continue;
      }
      const body: unknown = await response.json();
      return { body, url };
    } catch (error) {
      lastError = `${url} → ${describeError(error)}`;
    }
  }
  return { error: lastError };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** ISO timestamp for "now", used by every panel envelope. */
export function nowIso(now: number): string {
  return new Date(now).toISOString();
}
