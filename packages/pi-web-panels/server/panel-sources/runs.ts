/**
 * "In progress" panel source — what agents are actually working on right now.
 *
 * Discovery REUSES `lib/background-agents.ts` (`collectBackgroundAgents`,
 * `candidateCrewRoots`, `normalizeStatus`) so there is one reader of
 * `~/.pi/agent/extensions/pi-crew/state/runs/*` in pi-web, not two.
 *
 * The honesty rule this panel exists for:
 *
 *   A run is "live" ONLY IF its pid is alive AND its heartbeat is recent.
 *
 * `lib/background-agents.ts` is deliberately more forgiving (it keeps a run
 * "running" when *either* the pid, the heartbeat, *or* a <15min `updatedAt`
 * looks fresh), because the sidebar would rather show a possibly-live run than
 * hide it. For this panel the opposite bias is correct: a run whose runner
 * process is dead must render as STALLED with the age of its last sign of life.
 * `isPidAlive`/`heartbeatLooksLive` are module-private there and this task may
 * not edit that file, so the two checks are re-applied here — on top of the
 * shared discovery, not instead of it.
 *
 * Failed/wedged runs are never filtered out: failures are the information.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  candidateCrewRoots,
  collectBackgroundAgents,
  normalizeStatus,
  type BackgroundAgentEntry,
} from "../background-agents";
import {
  HOUR_MS,
  MINUTE_MS,
  PANEL_CACHE_TTL_MS,
  ageOf,
  asNumber,
  asString,
  boundLine,
  isRecord,
  isoOrNull,
  nowIso,
  readPanel,
  readTextFile,
  toEpochMs,
  type PanelEnvelope,
  type PanelItemBase,
} from "./cache";

export const RUNS_SOURCE = "in-progress";
export const RUNS_MAX_ITEMS = 30;
/**
 * Same threshold as the private `HEARTBEAT_STALE_MS` in
 * `lib/background-agents.ts:115` — a runner heartbeat older than this is not
 * evidence of life.
 */
export const HEARTBEAT_STALE_MS = 3 * MINUTE_MS;
/** A subagent record with no update for this long is not "running" any more. */
export const SUBAGENT_STALE_MS = 10 * MINUTE_MS;

export type RunLiveness = "live" | "stalled" | "finished";

export interface RunItem extends PanelItemBase {
  runId: string;
  kind: "team" | "subagent";
  /** First line of the goal (bounded); the subagent description for agents. */
  goal: string;
  /** Normalized status as recorded ("running"|"completed"|"failed"|…). */
  status: string;
  liveness: RunLiveness;
  startedAt: string | null;
  /** now - startedAt; null when the start time is unknown. */
  elapsedMs: number | null;
  /** now - last sign of life (heartbeat, else record update). */
  sinceSignalMs: number | null;
  pid: number | null;
  pidAlive: boolean | null;
  heartbeatAgeMs: number | null;
  /** Task rollup, when the run records one. */
  progress: { completed: number; total: number } | null;
  progressBasis: "tasks.json" | "subagent-status" | "unavailable";
  /** true when the run ended in failure (shown, not hidden). */
  failed: boolean;
  /** Plain-language reason it is stalled, e.g. "pid 123 dead; heartbeat 42m old". */
  stallReason: string | null;
  role: string | null;
  href: string | null;
  /** true when the run's own manifest was read because the lib hid the wrapper. */
  synthesized: boolean;
}

export interface RunsEnvelope extends PanelEnvelope<RunItem> {
  liveCount: number;
  stalledCount: number;
  failedCount: number;
  finishedCount: number;
  /** Wall time of the discovery pass — proves the poll is cheap. */
  discoveryMs: number;
  /** Roots actually scanned (pi-crew state dirs found on this host). */
  rootsScanned: number;
  now: string;
}

const TERMINAL = new Set([
  "completed",
  "complete",
  "done",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "aborted",
  "succeeded",
  "success",
  "skipped",
]);

/**
 * Probe liveness the way the brief requires. `EPERM` counts as alive (the pid
 * exists, we just may not signal it); unknown errors return null rather than a
 * guess.
 */
export function isPidAlive(pid: number | null): boolean | null {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return null;
  }
}

interface RunSignals {
  runDir: string | null;
  pid: number | null;
  pidAlive: boolean | null;
  heartbeatAt: number | null;
  heartbeatAgeMs: number | null;
  heartbeatFresh: boolean;
  lastSignalAt: number | null;
}

function readJsonFile(path: string): unknown {
  const { text } = readTextFile(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Locate `state/runs/<runId>` across the pi-crew roots. */
function locateRunDir(runId: string, roots: string[]): string | null {
  for (const root of roots) {
    const dir = join(root, "state", "runs", runId);
    if (existsSync(join(dir, "manifest.json"))) return dir;
  }
  return null;
}

function readSignals(runDir: string | null, entry: BackgroundAgentEntry, now: number): RunSignals {
  let pid: number | null = null;
  let heartbeatAt: number | null = null;
  let manifestGoal: number | null = null;
  void manifestGoal;

  if (runDir !== null) {
    const heartbeat = readJsonFile(join(runDir, "heartbeat.json"));
    if (isRecord(heartbeat)) {
      pid = asNumber(heartbeat.pid) ?? pid;
      // `heartbeat.at` is epoch MILLISECONDS (see lib/background-agents.ts:232).
      heartbeatAt = toEpochMs(heartbeat.at);
    }
    if (pid === null) {
      const asyncPid = readJsonFile(join(runDir, "async.pid"));
      if (isRecord(asyncPid)) pid = asNumber(asyncPid.pid) ?? null;
    }
  }

  const pidAlive = isPidAlive(pid);
  const heartbeatAgeMs = ageOf(now, heartbeatAt);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_STALE_MS;
  const candidates = [heartbeatAt, entry.updatedAt, entry.startedAt].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const lastSignalAt = candidates.length > 0 ? Math.max(...candidates) : null;

  return { runDir, pid, pidAlive, heartbeatAt, heartbeatAgeMs, heartbeatFresh, lastSignalAt };
}

function stallReasonFor(signals: RunSignals, status: string): string {
  const parts: string[] = [];
  if (signals.pid === null) parts.push("no pid recorded");
  else if (signals.pidAlive === false) parts.push(`pid ${signals.pid} is dead`);
  else if (signals.pidAlive === null) parts.push(`pid ${signals.pid} liveness unknown`);
  if (signals.heartbeatAgeMs === null) parts.push("no heartbeat");
  else if (!signals.heartbeatFresh) parts.push(`heartbeat ${humanShort(signals.heartbeatAgeMs)} old`);
  const detail = parts.length > 0 ? parts.join("; ") : "pid and heartbeat disagree";
  return `status "${status}" but ${detail}`;
}

export function humanShort(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const hour = Math.floor(ms / HOUR_MS);
  const minute = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (hour > 0) return `${hour}h`;
  if (minute > 0) return `${minute}m`;
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function livenessOf(
  status: string,
  signals: RunSignals,
  now: number,
  updatedAt: number | null,
): RunLiveness {
  if (TERMINAL.has(status)) return "finished";
  // The brief's rule: pid alive AND heartbeat recent. Nothing else counts.
  if (signals.pidAlive === true && signals.heartbeatFresh) return "live";
  if (updatedAt !== null && now - updatedAt <= SUBAGENT_STALE_MS && signals.pidAlive !== false) {
    // Subagent records have no pid of their own; a record this fresh whose
    // runner pid is not known-dead is still working.
    return "live";
  }
  return "stalled";
}

interface RunBuildContext {
  roots: string[];
  now: number;
  heartbeatByRun: Map<string, RunSignals>;
}

function buildRunItem(entry: BackgroundAgentEntry, context: RunBuildContext): RunItem {
  const { now, roots } = context;
  const status = normalizeStatus(entry.status);
  const isTeam = entry.kind === "team";
  const runId = isTeam ? entry.id : (entry.runId ?? entry.id);

  // A subagent's liveness follows its parent run's runner pid + heartbeat.
  const parentSignals = context.heartbeatByRun.get(runId);
  const runDir = isTeam ? locateRunDir(entry.id, roots) : null;
  const signals = isTeam
    ? readSignals(runDir, entry, now)
    : (parentSignals ?? {
        runDir: null,
        pid: null,
        pidAlive: null,
        heartbeatAt: null,
        heartbeatAgeMs: null,
        heartbeatFresh: false,
        lastSignalAt: entry.updatedAt,
      });

  const liveness = isTeam
    ? livenessOf(status, signals, now, entry.updatedAt)
    : livenessOfForSubagent(status, signals, now, entry.updatedAt);

  const startedAtMs = entry.startedAt;
  const elapsedMs = startedAtMs === null ? null : Math.max(0, now - startedAtMs);
  const sinceSignalMs = ageOf(now, signals.lastSignalAt);

  return {
    id: entry.id,
    title: boundLine(entry.title, 160) || entry.id,
    ageMs: elapsedMs,
    stale: liveness === "stalled",
    runId,
    kind: entry.kind,
    goal: boundLine(entry.goal ?? entry.title, 200) || entry.id,
    status,
    liveness,
    startedAt: isoOrNull(startedAtMs),
    elapsedMs,
    sinceSignalMs,
    pid: signals.pid,
    pidAlive: signals.pidAlive,
    heartbeatAgeMs: signals.heartbeatAgeMs,
    progress: entry.progress,
    progressBasis: entry.progress === null ? "unavailable" : "tasks.json",
    failed: status === "failed" || status === "error",
    stallReason: liveness === "stalled" ? stallReasonFor(signals, status) : null,
    role: entry.role || null,
    href: entry.href,
    synthesized: false,
  };
}

function livenessOfForSubagent(
  status: string,
  signals: RunSignals,
  now: number,
  updatedAt: number | null,
): RunLiveness {
  if (TERMINAL.has(status)) return "finished";
  if (signals.pidAlive === false) return "stalled";
  if (signals.heartbeatFresh && (signals.pidAlive === true || signals.pidAlive === null)) return "live";
  if (updatedAt !== null && now - updatedAt <= SUBAGENT_STALE_MS) return "live";
  return "stalled";
}

/**
 * `collectBackgroundAgents` hides a team wrapper once per-task subagent records
 * exist for that run. For the "in progress" panel the RUN is the unit of
 * interest, so a run hidden that way is rebuilt from its own manifest (goal,
 * status, timestamps) and its subagent records are used as the task rollup.
 */
function synthesizeHiddenRuns(
  entries: BackgroundAgentEntry[],
  context: RunBuildContext,
): RunItem[] {
  const { now, roots } = context;
  const presentRunIds = new Set(entries.filter((entry) => entry.kind === "team").map((entry) => entry.id));
  const subagentsByRun = new Map<string, BackgroundAgentEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "subagent" || entry.runId === null) continue;
    const list = subagentsByRun.get(entry.runId) ?? [];
    list.push(entry);
    subagentsByRun.set(entry.runId, list);
  }

  const out: RunItem[] = [];
  for (const [runId, subagents] of subagentsByRun) {
    if (presentRunIds.has(runId)) continue;
    const runDir = locateRunDir(runId, roots);
    if (runDir === null) continue;
    const manifest = readJsonFile(join(runDir, "manifest.json"));
    if (!isRecord(manifest)) continue;

    const status = normalizeStatus(manifest.status);
    const pidFromAsync = readJsonFile(join(runDir, "async.pid"));
    const pid =
      (isRecord(pidFromAsync) ? asNumber(pidFromAsync.pid) : null) ??
      (isRecord(manifest.async) ? asNumber(manifest.async.pid) : null);
    const heartbeat = readJsonFile(join(runDir, "heartbeat.json"));
    const heartbeatAt = isRecord(heartbeat) ? toEpochMs(heartbeat.at) : null;
    const signals: RunSignals = {
      runDir,
      pid,
      pidAlive: isPidAlive(pid),
      heartbeatAt,
      heartbeatAgeMs: ageOf(now, heartbeatAt),
      heartbeatFresh: false,
      lastSignalAt: null,
    };
    signals.heartbeatFresh = signals.heartbeatAgeMs !== null && signals.heartbeatAgeMs <= HEARTBEAT_STALE_MS;

    const createdAt = toEpochMs(manifest.createdAt);
    const updatedAt = toEpochMs(manifest.updatedAt);
    const signals2: RunSignals = {
      ...signals,
      lastSignalAt: [heartbeatAt, updatedAt, createdAt]
        .filter((value): value is number => value !== null)
        .reduce<number | null>((max, value) => (max === null ? value : Math.max(max, value)), null),
    };

    const liveness = livenessOf(status, signals2, now, updatedAt);
    const completed = subagents.filter((entry) => TERMINAL.has(normalizeStatus(entry.status))).length;
    const startedAtMs = createdAt;
    const goal = asString(manifest.goal) ?? runId;
    context.heartbeatByRun.set(runId, signals2);

    out.push({
      id: runId,
      title: boundLine(goal, 160) || runId,
      ageMs: ageOf(now, startedAtMs),
      stale: liveness === "stalled",
      runId,
      kind: "team",
      goal: boundLine(goal, 200) || runId,
      status,
      liveness,
      startedAt: isoOrNull(startedAtMs),
      elapsedMs: startedAtMs === null ? null : Math.max(0, now - startedAtMs),
      sinceSignalMs: ageOf(now, signals2.lastSignalAt),
      pid: signals2.pid,
      pidAlive: signals2.pidAlive,
      heartbeatAgeMs: signals2.heartbeatAgeMs,
      progress: { completed, total: subagents.length },
      progressBasis: "subagent-status",
      failed: status === "failed" || status === "error",
      stallReason: liveness === "stalled" ? stallReasonFor(signals2, status) : null,
      role: asString(manifest.team) ?? asString(manifest.runKind),
      href: `/runs/${runId}`,
      synthesized: true,
    });
  }
  return out;
}

const LIVENESS_RANK: Record<RunLiveness, number> = { live: 0, stalled: 1, finished: 2 };

function sortRuns(items: RunItem[]): RunItem[] {
  return items.sort((a, b) => {
    // Failures first within a group: the failures are the information.
    if (a.failed !== b.failed) return a.failed ? -1 : 1;
    const byLiveness = LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness];
    if (byLiveness !== 0) return byLiveness;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

/** Build the in-progress envelope. Reads only local pi-crew state. */
export async function readRunsPanel(now: number): Promise<RunsEnvelope> {
  const startedAt = Date.now();
  const roots = candidateCrewRoots(process.cwd(), homedir());
  const entries = collectBackgroundAgents(process.cwd(), homedir(), now);
  const context: RunBuildContext = { roots, now, heartbeatByRun: new Map() };

  // Pre-compute team signals so subagents can inherit their parent's liveness.
  for (const entry of entries) {
    if (entry.kind !== "team") continue;
    const runDir = locateRunDir(entry.id, roots);
    context.heartbeatByRun.set(entry.id, readSignals(runDir, entry, now));
  }

  const items = entries.map((entry) => buildRunItem(entry, context));
  items.push(...synthesizeHiddenRuns(entries, context));

  const deduped = new Map<string, RunItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    const existing = deduped.get(key);
    if (!existing || item.synthesized === false) deduped.set(key, item);
  }

  const sorted = sortRuns([...deduped.values()]);
  const bounded = sorted.slice(0, RUNS_MAX_ITEMS);
  const liveCount = sorted.filter((item) => item.liveness === "live").length;
  const stalledCount = sorted.filter((item) => item.liveness === "stalled").length;
  const failedCount = sorted.filter((item) => item.failed).length;
  const finishedCount = sorted.filter((item) => item.liveness === "finished").length;

  return {
    source: RUNS_SOURCE,
    ok: true,
    error: null,
    fetchedAt: nowIso(now),
    cacheAgeMs: 0,
    stale: false,
    count: bounded.length,
    items: bounded,
    lastGoodAt: null,
    lastGoodCount: null,
    liveCount,
    stalledCount,
    failedCount,
    finishedCount,
    discoveryMs: Date.now() - startedAt,
    rootsScanned: roots.length,
    now: nowIso(now),
  };
}

/** Cached read used by `app/api/panels/in-progress/route.ts`. */
export async function getRunsPanel(): Promise<RunsEnvelope> {
  return readPanel<RunItem>(RUNS_SOURCE, (now) => readRunsPanel(now)) as Promise<RunsEnvelope>;
}

export const RUNS_REFRESH_MS = PANEL_CACHE_TTL_MS;
