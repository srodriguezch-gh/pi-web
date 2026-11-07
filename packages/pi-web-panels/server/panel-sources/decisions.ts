/**
 * "Decisions waiting on Silvio" panel source.
 *
 * Real source: the HITL queue behind `home.silrod.org/business`, i.e. pending
 * rows of `heart.watchdog_approvals` in `silrod_core`. The heart service already
 * exposes exactly those rows (`decision IS NULL`) over HTTP, so pi-web reads it
 * from there instead of opening a database connection:
 *
 *   GET <heart>/heart/api/approvals → { pending: [...], count: n }
 *   row = { id, endpoint, action, reason, severity, timestamp }
 *
 * Why HTTP rather than SQL: pi-web has no postgres driver and must not gain one
 * (`no new dependencies`), and the same service already performs the
 * `decision IS NULL` filter — a second query path would be a second truth.
 *
 * Honesty details that matter here:
 *  - `timestamp` has NO timezone designator but is UTC (the heart scheduler runs
 *    UTC: every `next_run` carries `+00:00`). It is parsed as UTC, otherwise a
 *    4-hour local offset would make a 24h-old decision look 20h old.
 *  - The table has no `title` column. The title is DERIVED from `action` (which
 *    is often a JSON array whose items carry `label`) and says so via
 *    `titleBasis`, falling back to `endpoint`. Nothing is invented.
 *  - `ageMs` is how long Silvio has been waited on; age — not the reported
 *    severity — drives `urgency`, because a 4-day-old "info" item is still a
 *    decision blocking work.
 *  - `stale` means "waiting longer than the 24h attention budget".
 */

import {
  AGE_URGENT_MS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  PANEL_CACHE_TTL_MS,
  ageOf,
  asArray,
  asNumber,
  asString,
  boundLine,
  fetchJsonFromBases,
  heartApiBases,
  isRecord,
  isoOrNull,
  nowIso,
  parseNaiveUtc,
  readPanel,
  urgencyForAgeMs,
  type PanelEnvelope,
  type PanelItemBase,
  type PanelSeverity,
} from "./cache";

export const DECISIONS_SOURCE = "decisions";
export const DECISIONS_MAX_ITEMS = 50;
export const DECISIONS_APPROVALS_PATH = "/heart/api/approvals";
/** The HITL queue page this panel mirrors. */
export const DECISIONS_QUEUE_URL = "https://home.silrod.org/business";

export interface DecisionItem extends PanelItemBase {
  decisionId: string;
  /** Which subsystem raised it (verbatim). */
  endpoint: string | null;
  /** What the approval is asking for — the row's `reason`, verbatim. */
  whatIsAsked: string;
  /** The proposed action, bounded; JSON-in-text is preserved as-is. */
  action: string | null;
  /** Severity as reported by the producer ("high"|"medium"|"info"|…), verbatim. */
  reportedSeverity: string | null;
  /** Age-derived: >=24h urgent, >=4h warning. Age wins over reported severity. */
  urgency: PanelSeverity;
  /** ISO (UTC) timestamp of the row. */
  openedAt: string | null;
  /** Human age, e.g. "1d 3h" — the headline number of this panel. */
  ageLabel: string;
  /** How `title` was obtained, so a fallback title is not mistaken for real. */
  titleBasis: "action-label" | "action-text" | "endpoint" | "none";
}

export interface DecisionsEnvelope extends PanelEnvelope<DecisionItem> {
  /** URL actually queried (first base that answered). */
  approvalsUrl: string | null;
  queueUrl: string;
  oldestAgeMs: number | null;
  byUrgency: Record<PanelSeverity, number>;
  byReportedSeverity: Record<string, number>;
  /** true when more rows existed than the cap allowed. */
  truncated: boolean;
}

/** "1d 3h" / "5h 12m" / "8m" — deliberately coarse; exact seconds are noise. */
export function humanAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  const day = Math.floor(ageMs / DAY_MS);
  const hour = Math.floor((ageMs % DAY_MS) / HOUR_MS);
  const minute = Math.floor((ageMs % HOUR_MS) / MINUTE_MS);
  if (day > 0) return `${day}d ${hour}h`;
  if (hour > 0) return `${hour}h ${minute}m`;
  return `${minute}m`;
}

interface DerivedTitle {
  title: string;
  basis: DecisionItem["titleBasis"];
}

/**
 * Derive a human title from `action`. Producers write either a JSON array of
 * `{label, action, confidence, …}` objects or a plain sentence.
 */
export function deriveDecisionTitle(
  action: unknown,
  endpoint: string | null,
  fallbackId: string,
): DerivedTitle {
  const raw = asString(action);
  if (raw !== null) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (isRecord(first)) {
          const label = asString(first.label);
          if (label !== null) return { title: boundLine(label, 160), basis: "action-label" };
          const text = asString(first.action) ?? asString(first.title) ?? asString(first.summary);
          if (text !== null) return { title: boundLine(text, 160), basis: "action-text" };
        }
        const stringified = boundLine(trimmed, 160);
        if (stringified.length > 0) return { title: stringified, basis: "action-text" };
      } catch {
        // Not valid JSON despite looking like it — fall through to the text form.
        const text = boundLine(trimmed, 160);
        if (text.length > 0) return { title: text, basis: "action-text" };
      }
    } else {
      return { title: boundLine(trimmed, 160), basis: "action-text" };
    }
  }
  if (endpoint !== null) return { title: boundLine(endpoint, 160), basis: "endpoint" };
  return { title: fallbackId, basis: "none" };
}

function emptyCounts(): Record<PanelSeverity, number> {
  return { urgent: 0, warning: 0, normal: 0 };
}

export function readDecisionsFromPayload(
  body: unknown,
  now: number,
  approvalsUrl: string | null,
): DecisionsEnvelope {
  const rows = isRecord(body) ? body.pending : undefined;
  if (!Array.isArray(rows)) {
    const keys = isRecord(body) ? Object.keys(body).join(",") : typeof body;
    return {
      source: DECISIONS_SOURCE,
      ok: false,
      error: `unexpected payload from ${approvalsUrl ?? "heart"}: no \`pending\` array (keys: ${keys || "none"})`,
      fetchedAt: nowIso(now),
      cacheAgeMs: 0,
      stale: false,
      count: 0,
      items: [],
      lastGoodAt: null,
      lastGoodCount: null,
      approvalsUrl,
      queueUrl: DECISIONS_QUEUE_URL,
      oldestAgeMs: null,
      byUrgency: emptyCounts(),
      byReportedSeverity: {},
      truncated: false,
    };
  }

  const byUrgency = emptyCounts();
  const byReportedSeverity: Record<string, number> = {};
  const items: DecisionItem[] = [];

  for (const row of asArray(rows)) {
    if (!isRecord(row)) continue;
    const id = asString(row.id) ?? `row-${items.length}`;
    const endpoint = asString(row.endpoint);
    const openedAtMs = parseNaiveUtc(row.timestamp);
    const ageMs = ageOf(now, openedAtMs);
    const urgency = urgencyForAgeMs(ageMs);
    const reportedSeverity = asString(row.severity);
    const derived = deriveDecisionTitle(row.action, endpoint, id);

    byUrgency[urgency] += 1;
    const severityKey = reportedSeverity ?? "unspecified";
    byReportedSeverity[severityKey] = (byReportedSeverity[severityKey] ?? 0) + 1;

    items.push({
      id,
      title: derived.title,
      ageMs,
      stale: ageMs !== null && ageMs >= AGE_URGENT_MS,
      decisionId: id,
      endpoint,
      whatIsAsked: boundLine(row.reason, 300) || "(no reason recorded)",
      action: boundLine(row.action, 400) || null,
      reportedSeverity,
      urgency,
      openedAt: isoOrNull(openedAtMs),
      ageLabel: humanAge(ageMs),
      titleBasis: derived.basis,
    });
  }

  // Oldest first: the longest-waiting decision is the one blocking the most work.
  items.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const bounded = items.slice(0, DECISIONS_MAX_ITEMS);
  const oldestAgeMs = items.reduce<number | null>((max, item) => {
    if (item.ageMs === null) return max;
    return max === null ? item.ageMs : Math.max(max, item.ageMs);
  }, null);

  return {
    source: DECISIONS_SOURCE,
    ok: true,
    error: null,
    fetchedAt: nowIso(now),
    cacheAgeMs: 0,
    stale: false,
    count: bounded.length,
    items: bounded,
    lastGoodAt: null,
    lastGoodCount: null,
    approvalsUrl,
    queueUrl: DECISIONS_QUEUE_URL,
    oldestAgeMs,
    byUrgency,
    byReportedSeverity,
    truncated: items.length > bounded.length,
  };
}

/** Read the live HITL queue. Never throws — failures become `ok:false`. */
export async function readDecisionsPanel(now: number): Promise<DecisionsEnvelope> {
  const result = await fetchJsonFromBases(heartApiBases(), DECISIONS_APPROVALS_PATH);
  if ("error" in result) {
    return {
      source: DECISIONS_SOURCE,
      ok: false,
      error: result.error,
      fetchedAt: nowIso(now),
      cacheAgeMs: 0,
      stale: false,
      count: 0,
      items: [],
      lastGoodAt: null,
      lastGoodCount: null,
      approvalsUrl: null,
      queueUrl: DECISIONS_QUEUE_URL,
      oldestAgeMs: null,
      byUrgency: emptyCounts(),
      byReportedSeverity: {},
      truncated: false,
    };
  }
  return readDecisionsFromPayload(result.body, now, result.url);
}

/** Cached read used by `app/api/panels/decisions/route.ts`. */
export async function getDecisionsPanel(): Promise<DecisionsEnvelope> {
  return readPanel<DecisionItem>(DECISIONS_SOURCE, (now) => readDecisionsPanel(now)) as Promise<DecisionsEnvelope>;
}

export const DECISIONS_REFRESH_MS = PANEL_CACHE_TTL_MS;

// Referenced by tests / future filters; keep the imports meaningful.
void asNumber;
