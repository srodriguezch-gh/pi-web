import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { candidateCrewRoots, normalizeStatus } from "./background-agents";

/**
 * Read-only detail projection of ONE pi-crew team run, for the run detail view
 * (app/runs/[runId]/page.tsx -> components/AgentRunDetailView.tsx).
 *
 * Why this reads `<stateRoot>/agents/<taskId>/status.json` instead of inventing
 * a new `tasks.json.model` field: that per-agent status file is written by
 * pi-crew's single writer for agent records
 * (`apps/packages/cac-llc/src/runtime/crew-agent-records.ts`, `agentStatusPath`
 * + the dedup write at the record update site) and is refreshed live while the
 * agent runs. `tasks.json.model` exists as an optional field on
 * `TeamTaskState` but nothing in cac-llc ever assigns it — the real routing
 * outcome lives in `tasks.json` `modelRouting` / `modelAttempts` (written at
 * completion by `runtime/task-runner/child-executor.ts`) and mirrors into
 * `status.json`. Duplicating it into a second field would create a second
 * writer for the same fact, which is exactly what the single-writer invariant
 * in crew-agent-records.ts warns against.
 *
 * Everything is defensive: a missing dir/file, corrupt JSON or a partial body
 * degrades to nulls, never a throw. The view must render against a run that is
 * still being written.
 */

export interface RunTaskActivity {
  /** Tool name as emitted by the agent ("bash", "edit", ...). */
  tool: string;
  /** One-line, bounded summary of the tool's target. */
  target: string;
  /** epoch ms the tool call ended, or null. */
  at: number | null;
}

export interface RunTaskModel {
  /** The model actually in use / used (the resolved one when known). */
  model: string | null;
  /** What the dispatch asked for. */
  requested: string | null;
  /** What the router resolved to; null while a running task has not resolved yet. */
  resolved: string | null;
  /** True when requested is known and differs from resolved (a fallback). */
  drift: boolean;
  /** Number of model attempts recorded for this task. */
  attempts: number;
  /** 1-based index of the attempt that produced the result, when known. */
  usedAttempt: number | null;
  /** pi-crew's own explanation for a fallback (often the upstream error text). */
  fallbackReason: string | null;
  /** Attempts that failed, with their error text (bounded). */
  failedAttempts: Array<{ model: string; error: string }>;
}

export interface RunTaskDetail {
  id: string;
  role: string;
  agent: string;
  title: string;
  /** normalized: running | completed | failed | queued | waiting | unknown | raw */
  status: string;
  /** the on-disk status spelling. */
  rawStatus: string;
  model: RunTaskModel;
  toolUses: number | null;
  /** the tool currently executing (running tasks only). */
  currentTool: string | null;
  /** activityState from agentProgress ("active", "idle", ...). */
  activityState: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** last agent activity (tool end / heartbeat); null when unknown. */
  lastActivityAt: number | null;
  /** finishedAt - startedAt, or now - startedAt for a live task. */
  elapsedMs: number | null;
  /** failure text (task error, failure cause, or the last failed attempt). */
  error: string | null;
  /** newest-first, bounded. */
  recentTools: RunTaskActivity[];
  /** last lines of tool output the agent printed, bounded. */
  recentOutput: string[];
  dependsOn: string[];
  /** result artifact path, when recorded. */
  resultPath: string | null;
  /** status.json existed for this task. */
  hasAgentStatus: boolean;
}

export interface RunArtifact {
  name: string;
  path: string;
  sizeBytes?: number;
}

export interface RunDetail {
  runId: string;
  team: string;
  workflow: string | null;
  /** normalized run status. */
  status: string;
  rawStatus: string;
  /** true when the run claims "running" and still looks alive. */
  live: boolean;
  goal: string | null;
  summary: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  stateRoot: string;
  artifactsRoot: string | null;
  tasks: RunTaskDetail[];
  counts: Record<string, number>;
  artifacts: RunArtifact[];
}

const MAX_RUN_ID_LENGTH = 200;
const MAX_TOOLS_PER_TASK = 20;
const MAX_OUTPUT_LINES = 8;
const MAX_TARGET_LENGTH = 110;
const MAX_ERROR_LENGTH = 400;
const MAX_MODEL_ATTEMPTS_LISTED = 4;
const MAX_ARTIFACTS = 25;
/** A run whose heartbeat/manifest is older than this and shows no live pid is stale. */
const RUN_STALE_MS = 15 * 60 * 1000;

/** Arg keys, in priority order, that name a tool's target. */
const TARGET_KEYS = [
  "command",
  "cmd",
  "script",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
  "name",
  "id",
  "text",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Collapse to a single bounded line (tool args and error bodies are multi-line). */
export function oneLine(value: string, max = MAX_TARGET_LENGTH): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function unescapeJsonFragment(value: string): string {
  return value
    .replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape: string) => {
      if (escape.length === 5) {
        const code = Number.parseInt(escape.slice(1), 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : match;
      }
      return JSON_ESCAPES[escape] ?? escape;
    });
}

/**
 * pi-crew truncates the `args` string it records in `agentProgress.recentTools`
 * (it ends mid-JSON with an ellipsis), so a truncated payload cannot be parsed.
 * Pull the first target-naming field out of the fragment instead so the panel
 * still shows "grep -rn foo" rather than a wall of escaped JSON.
 */
function extractJsonishField(text: string): string | null {
  for (const key of TARGET_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
    if (match && match[1].trim()) return unescapeJsonFragment(match[1]).replace(/\s*…\s*$/, "");
  }
  return null;
}

/**
 * A one-line summary of a tool call's target. Accepts the raw `args` shape
 * pi-crew records (a JSON string, or already-parsed object), so `<TAB>`-heavy
 * edit payloads and multi-line bash scripts stay on one readable line.
 */
export function summarizeToolArgs(args: unknown): string {
  let parsed: unknown = args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Truncated (pi-crew caps the recorded args) — read the fragment.
        return oneLine(extractJsonishField(trimmed) ?? trimmed);
      }
    } else {
      return oneLine(trimmed);
    }
  }
  if (typeof parsed === "string") return oneLine(parsed);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === "string" && item.trim()) return oneLine(item);
    }
    return `${parsed.length} item${parsed.length === 1 ? "" : "s"}`;
  }
  if (isRecord(parsed)) {
    for (const key of TARGET_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return oneLine(value);
    }
    const values = Object.values(parsed);
    const first = values.find((value) => typeof value === "string" && value.trim());
    if (typeof first === "string") return oneLine(first);
    const list = values.find((value) => Array.isArray(value));
    if (Array.isArray(list) && list.length > 0) return `${list.length} item${list.length === 1 ? "" : "s"}`;
    return "";
  }
  return "";
}

/** Bounded, de-duplicated recent tool calls out of an `agentProgress` body. */
function readRecentTools(progress: Record<string, unknown> | null): RunTaskActivity[] {
  if (!progress) return [];
  const raw = progress.recentTools;
  if (!Array.isArray(raw)) return [];
  const out: RunTaskActivity[] = [];
  for (let index = raw.length - 1; index >= 0 && out.length < MAX_TOOLS_PER_TASK; index -= 1) {
    const item = raw[index];
    if (!isRecord(item)) continue;
    const tool = asString(item.tool) ?? asString(item.toolName) ?? "tool";
    out.push({
      tool,
      target: summarizeToolArgs(item.args ?? item.argsText),
      at: toEpochMs(item.endedAt) ?? toEpochMs(item.startedAt),
    });
  }
  return out;
}

/** Tail lines of the agent's most recent tool output. */
function readRecentOutput(progress: Record<string, unknown> | null): string[] {
  if (!progress) return [];
  const raw = progress.recentOutput;
  const lines: string[] = [];
  if (typeof raw === "string") {
    lines.push(...raw.split("\n"));
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") lines.push(...item.split("\n"));
    }
  }
  const cleaned = lines
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_OUTPUT_LINES)
    .map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
  return cleaned;
}

function readModel(task: Record<string, unknown>, status: Record<string, unknown> | null): RunTaskModel {
  const statusRouting = status && isRecord(status.routing) ? status.routing : null;
  const taskRouting = isRecord(task.modelRouting) ? task.modelRouting : null;

  const rawAttempts = Array.isArray(task.modelAttempts) ? task.modelAttempts : [];
  const attempts = rawAttempts.filter(isRecord);
  const failedAttempts = attempts
    .map((attempt) => {
      const success = attempt.success === true;
      if (success) return null;
      const model = asString(attempt.model) ?? "unknown";
      const error = asString(attempt.error);
      return { model, error: error ? oneLine(error, MAX_ERROR_LENGTH) : "no error text" };
    })
    .filter((entry): entry is { model: string; error: string } => entry !== null)
    .slice(0, MAX_MODEL_ATTEMPTS_LISTED);

  const requested =
    asString(statusRouting?.requested) ??
    asString(taskRouting?.requested) ??
    asString(attempts[0]?.model) ??
    null;

  const resolved =
    asString(statusRouting?.resolved) ??
    asString(taskRouting?.resolved) ??
    asString(attempts.find((attempt) => attempt.success === true)?.model) ??
    null;

  // `status.json.model` is present from the first dispatch, so a running task
  // shows the model it is actually on even before routing resolves.
  const model = asString(status?.model) ?? resolved ?? asString(attempts.at(-1)?.model) ?? null;

  const usedAttemptRaw = asNumber(statusRouting?.usedAttempt) ?? asNumber(taskRouting?.usedAttempt);
  const drift = requested !== null && resolved !== null && requested !== resolved;
  const fallbackReason =
    asString(taskRouting?.reason) ?? asString(statusRouting?.reason) ?? (drift ? failedAttempts[0]?.error ?? null : null);

  return {
    model,
    requested,
    resolved,
    drift,
    attempts: attempts.length,
    usedAttempt: usedAttemptRaw === null ? null : usedAttemptRaw + 1,
    fallbackReason,
    failedAttempts,
  };
}

/** Newest-first list of tasks from a tasks.json body (array or { tasks: [] }). */
function readTaskList(raw: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  return list.filter(isRecord);
}

function readOneTask(
  runDir: string,
  task: Record<string, unknown>,
  now: number,
): RunTaskDetail | null {
  const id = asString(task.id);
  if (!id) return null;

  const statusPath = join(runDir, "agents", id, "status.json");
  const statusRaw = existsSync(statusPath) ? readJson(statusPath) : undefined;
  const status = isRecord(statusRaw) ? statusRaw : null;

  const statusProgress = status && isRecord(status.progress) ? status.progress : null;
  const taskProgress = isRecord(task.agentProgress) ? task.agentProgress : null;
  const progress = statusProgress ?? taskProgress;

  const rawStatus = asString(status?.status) ?? asString(task.status) ?? "unknown";
  const normalized = normalizeStatus(rawStatus);
  const startedAt = toEpochMs(status?.startedAt) ?? toEpochMs(task.startedAt) ?? null;
  const finishedAt =
    toEpochMs(status?.completedAt) ?? toEpochMs(task.finishedAt) ?? toEpochMs(task.completedAt) ?? null;
  const lastActivityAt =
    toEpochMs(task.heartbeat) ??
    toEpochMs(progress?.lastActivityAt) ??
    fileMtimeMs(statusPath);

  const model = readModel(task, status);

  const rawError =
    asString(task.error) ??
    asString(status?.error) ??
    asString(task.failureCause) ??
    (normalized === "failed" ? model.failedAttempts.at(-1)?.error ?? null : null);

  const elapsedEnd = finishedAt ?? (normalized === "running" ? now : lastActivityAt);
  const elapsedMs =
    startedAt !== null && elapsedEnd !== null && elapsedEnd >= startedAt ? elapsedEnd - startedAt : null;

  const recentTools = statusProgress ? readRecentTools(statusProgress) : [];
  const taskRecentTools = taskProgress ? readRecentTools(taskProgress) : [];
  // status.json's progress block does not always carry recentTools, so fall
  // back to the tasks.json mirror (same writer, same shape, slightly older).
  const activity = recentTools.length > 0 ? recentTools : taskRecentTools;
  const currentTool = asString(statusProgress?.currentTool) ?? asString(taskProgress?.currentTool);
  if (currentTool) {
    // The executing call is not in recentTools yet; show it as the head item.
    const currentTarget =
      summarizeToolArgs(statusProgress?.currentToolArgs) || summarizeToolArgs(taskProgress?.currentToolArgs);
    activity.unshift({ tool: currentTool, target: currentTarget, at: null });
  }

  const recentOutput = readRecentOutput(statusProgress);
  const outputTail = recentOutput.length > 0 ? recentOutput : readRecentOutput(taskProgress);

  const taskToolCount = asNumber(progress?.toolCount) ?? asNumber(task.toolCount);
  const toolUses = asNumber(status?.toolUses) ?? taskToolCount;
  return {
    id,
    role: asString(task.role) ?? asString(status?.role) ?? "task",
    agent: asString(task.agent) ?? asString(status?.agent) ?? "agent",
    title: oneLine(asString(task.title) ?? asString(task.prompt) ?? id, 240),
    status: normalized,
    rawStatus,
    model,
    toolUses,
    currentTool,
    activityState: asString(progress?.activityState),
    startedAt,
    finishedAt,
    lastActivityAt,
    elapsedMs,
    error: rawError ? oneLine(rawError, MAX_ERROR_LENGTH) : null,
    recentTools: activity.slice(0, MAX_TOOLS_PER_TASK),
    recentOutput: outputTail,
    dependsOn: Array.isArray(task.dependsOn)
      ? task.dependsOn.filter((value): value is string => typeof value === "string")
      : [],
    resultPath: isRecord(task.resultArtifact) ? asString(task.resultArtifact.path) : null,
    hasAgentStatus: status !== null,
  };
}

function readArtifacts(manifest: Record<string, unknown>): RunArtifact[] {
  const raw = manifest.artifacts;
  if (!Array.isArray(raw)) return [];
  const out: RunArtifact[] = [];
  for (const item of raw) {
    if (out.length >= MAX_ARTIFACTS) break;
    if (!isRecord(item)) continue;
    const path = asString(item.path);
    if (!path) continue;
    const sizeBytes = asNumber(item.sizeBytes);
    out.push({
      name: path.split("/").pop() ?? path,
      path,
      ...(sizeBytes !== null ? { sizeBytes } : {}),
    });
  }
  return out;
}

function runLooksLive(runDir: string, manifest: Record<string, unknown>, now: number): boolean {
  const heartbeat = readJson(join(runDir, "heartbeat.json"));
  if (isRecord(heartbeat)) {
    if (isPidAlive(asNumber(heartbeat.pid) ?? 0)) return true;
    const at = toEpochMs(heartbeat.at);
    if (at !== null && now - at <= 3 * 60 * 1000) return true;
  }
  const updated = toEpochMs(manifest.updatedAt) ?? fileMtimeMs(join(runDir, "manifest.json"));
  return updated !== null && now - updated <= RUN_STALE_MS;
}

/** True when `runId` is a plausible run identifier (and cannot escape the runs dir). */
export function isSafeRunId(runId: string): boolean {
  if (!runId || runId.length > MAX_RUN_ID_LENGTH) return false;
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) return false;
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

/** Locate `<crewRoot>/state/runs/<runId>` across every candidate crew root. */
export function findRunDir(runId: string, cwd = process.cwd(), home = homedirSafe()): string | null {
  if (!isSafeRunId(runId)) return null;
  for (const root of candidateCrewRoots(cwd, home)) {
    const runDir = join(root, "state", "runs", runId);
    try {
      if (existsSync(join(runDir, "manifest.json"))) return runDir;
    } catch {
      // unreadable root: keep looking
    }
  }
  return null;
}

function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME?.trim() || ".";
  }
}

/**
 * Build the full detail projection for one run. Returns null when the run is
 * unknown (bad id or no run directory anywhere).
 */
export function collectRunDetail(
  runId: string,
  now = Date.now(),
  cwd = process.cwd(),
  home = homedirSafe(),
): RunDetail | null {
  const runDir = findRunDir(runId, cwd, home);
  if (!runDir) return null;
  const manifestRaw = readJson(join(runDir, "manifest.json"));
  if (!isRecord(manifestRaw)) return null;
  const manifest = manifestRaw;

  const rawStatus = asString(manifest.status) ?? "unknown";
  const status = normalizeStatus(rawStatus);
  const live = status === "running" ? runLooksLive(runDir, manifest, now) : false;

  const tasks: RunTaskDetail[] = [];
  for (const task of readTaskList(readJson(join(runDir, "tasks.json")))) {
    const detail = readOneTask(runDir, task, now);
    if (detail) tasks.push(detail);
  }

  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;

  return {
    runId: asString(manifest.runId) ?? runId,
    team: asString(manifest.team) ?? asString(manifest.runKind) ?? "team",
    workflow: asString(manifest.workflow),
    status: status === "running" && !live ? "stale" : status,
    rawStatus,
    live,
    goal: asString(manifest.goal),
    summary: asString(manifest.summary),
    createdAt: toEpochMs(manifest.createdAt),
    updatedAt: toEpochMs(manifest.updatedAt) ?? fileMtimeMs(join(runDir, "manifest.json")),
    stateRoot: asString(manifest.stateRoot) ?? runDir,
    artifactsRoot: asString(manifest.artifactsRoot),
    tasks,
    counts,
    artifacts: readArtifacts(manifest),
  };
}
