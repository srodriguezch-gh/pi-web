/**
 * "Scheduled runs" panel source.
 *
 * Real source: the EXISTING heart jobs registry — no second scheduler is
 * invented here. Read over HTTP from the running service:
 *
 *   GET <heart>/heart/api/jobs →
 *     { running: boolean, jobs_count: 111,
 *       jobs: [{ job_id, job_name, schedule, enabled,
 *                last_run, next_run, last_status }] }
 *
 * `next_run`/`last_run` carry `+00:00`; they are parsed strictly (any naive
 * value is treated as UTC by the shared parser) so "overdue" is not an artifact
 * of the browser's timezone.
 *
 * Honesty rules applied:
 *  - The registry has 111 jobs. Shipping all of them is a dump, not a panel, so
 *    the list is ordered failures-first, then overdue, then soonest-to-fire, and
 *    capped — with `totalJobs` reported so the cap is visible.
 *  - `overdue` is computed from `next_run < now` for an ENABLED job: a disabled
 *    job's stale `next_run` is not a missed run.
 *  - `last_status` is surfaced verbatim; failures are never filtered out.
 *  - `stale` on an item = failed OR overdue. `ageMs` = time since the last run
 *    (null if it never ran), which is what "it has not fired in 3 days" means.
 */

import {
  MINUTE_MS,
  PANEL_CACHE_TTL_MS,
  ageOf,
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

export const SCHEDULED_SOURCE = "scheduled";
export const SCHEDULED_JOBS_PATH = "/heart/api/jobs";
/** Bound the payload; `totalJobs` keeps the truncation visible. */
export const SCHEDULED_MAX_ITEMS = 40;

export interface ScheduledItem extends PanelItemBase {
  jobId: string;
  /** Human job name, verbatim from the registry. */
  jobName: string;
  /** Cron expression, verbatim (e.g. "*​/30 * * * *"). */
  schedule: string;
  enabled: boolean;
  /** "success" | "failed" | … verbatim; null when it never ran. */
  lastStatus: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** ms until the next fire; negative when it is already late. */
  nextRunInMs: number | null;
  overdue: boolean;
  /** How late, when overdue. */
  overdueByMs: number | null;
  failed: boolean;
  /** Age-derived badge from time-since-last-run. */
  severity: PanelSeverity;
}

export interface ScheduledEnvelope extends PanelEnvelope<ScheduledItem> {
  /** Registry truth: how many jobs exist in total (not just shipped rows). */
  totalJobs: number;
  enabledCount: number;
  disabledCount: number;
  failedCount: number;
  overdueCount: number;
  /** The scheduler's own liveness flag as reported by the registry. */
  schedulerRunning: boolean | null;
  jobsUrl: string | null;
  truncated: boolean;
}

function parseJob(row: Record<string, unknown>, now: number): ScheduledItem | null {
  const jobId = asString(row.job_id);
  if (jobId === null) return null;
  const jobName = asString(row.job_name) ?? jobId;
  const schedule = asString(row.schedule) ?? "unknown";
  const enabled = row.enabled === true;
  const lastStatus = asString(row.last_status);
  const lastRunMs = parseNaiveUtc(row.last_run);
  const nextRunMs = parseNaiveUtc(row.next_run);

  const overdue = enabled && nextRunMs !== null && nextRunMs < now;
  const overdueByMs = overdue && nextRunMs !== null ? now - nextRunMs : null;
  const failed = lastStatus !== null && lastStatus.toLowerCase() !== "success" && lastStatus.toLowerCase() !== "ok";
  const ageMs = ageOf(now, lastRunMs);

  return {
    id: jobId,
    title: `${boundLine(jobName, 120)} · ${schedule}`,
    ageMs,
    stale: failed || overdue,
    jobId,
    jobName: boundLine(jobName, 120),
    schedule,
    enabled,
    lastStatus,
    lastRunAt: isoOrNull(lastRunMs),
    nextRunAt: isoOrNull(nextRunMs),
    nextRunInMs: nextRunMs === null ? null : nextRunMs - now,
    overdue,
    overdueByMs,
    failed,
    severity: urgencyForAgeMs(ageMs),
  };
}

function sortJobs(items: ScheduledItem[]): ScheduledItem[] {
  return items.sort((a, b) => {
    // 1. failures, 2. overdue, 3. enabled by soonest next fire, 4. disabled.
    if (a.failed !== b.failed) return a.failed ? -1 : 1;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aNext = a.nextRunInMs ?? Number.MAX_SAFE_INTEGER;
    const bNext = b.nextRunInMs ?? Number.MAX_SAFE_INTEGER;
    return aNext - bNext;
  });
}

function failedEnvelope(now: number, error: string): ScheduledEnvelope {
  return {
    source: SCHEDULED_SOURCE,
    ok: false,
    error,
    fetchedAt: nowIso(now),
    cacheAgeMs: 0,
    stale: false,
    count: 0,
    items: [],
    lastGoodAt: null,
    lastGoodCount: null,
    totalJobs: 0,
    enabledCount: 0,
    disabledCount: 0,
    failedCount: 0,
    overdueCount: 0,
    schedulerRunning: null,
    jobsUrl: null,
    truncated: false,
  };
}

export function readScheduledFromPayload(
  body: unknown,
  now: number,
  jobsUrl: string | null,
): ScheduledEnvelope {
  const rows = isRecord(body) ? body.jobs : undefined;
  if (!Array.isArray(rows)) {
    const keys = isRecord(body) ? Object.keys(body).join(",") : typeof body;
    return failedEnvelope(
      now,
      `unexpected payload from ${jobsUrl ?? "heart"}: no \`jobs\` array (keys: ${keys || "none"})`,
    );
  }

  const items: ScheduledItem[] = [];
  let enabledCount = 0;
  let disabledCount = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const item = parseJob(row, now);
    if (item === null) continue;
    if (item.enabled) enabledCount += 1;
    else disabledCount += 1;
    items.push(item);
  }

  const sorted = sortJobs(items);
  const bounded = sorted.slice(0, SCHEDULED_MAX_ITEMS);
  const reportedTotal = isRecord(body) ? body.jobs_count : undefined;
  const totalJobs =
    typeof reportedTotal === "number" && Number.isFinite(reportedTotal) ? reportedTotal : items.length;
  const schedulerRunning = isRecord(body) && typeof body.running === "boolean" ? body.running : null;

  return {
    source: SCHEDULED_SOURCE,
    ok: true,
    error: null,
    fetchedAt: nowIso(now),
    cacheAgeMs: 0,
    stale: false,
    count: bounded.length,
    items: bounded,
    lastGoodAt: null,
    lastGoodCount: null,
    totalJobs,
    enabledCount,
    disabledCount,
    failedCount: sorted.filter((item) => item.failed).length,
    overdueCount: sorted.filter((item) => item.overdue).length,
    schedulerRunning,
    jobsUrl,
    truncated: items.length > bounded.length,
  };
}

/** Read the live jobs registry. Never throws — failures become `ok:false`. */
export async function readScheduledPanel(now: number): Promise<ScheduledEnvelope> {
  const result = await fetchJsonFromBases(heartApiBases(), SCHEDULED_JOBS_PATH);
  if ("error" in result) return failedEnvelope(now, result.error);
  return readScheduledFromPayload(result.body, now, result.url);
}

/** Cached read used by `app/api/panels/scheduled/route.ts`. */
export async function getScheduledPanel(): Promise<ScheduledEnvelope> {
  return readPanel<ScheduledItem>(SCHEDULED_SOURCE, (now) =>
    readScheduledPanel(now),
  ) as Promise<ScheduledEnvelope>;
}

export const SCHEDULED_REFRESH_MS = PANEL_CACHE_TTL_MS;
export { MINUTE_MS };
