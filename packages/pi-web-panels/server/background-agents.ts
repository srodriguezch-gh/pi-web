import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Read-only discovery of pi-crew background activity for the sidebar's
 * "Background Agents" panel (components/BackgroundAgentsPanel.tsx).
 *
 * Two kinds of local state are surfaced, both persisted on disk by the
 * pi-crew extension (package `cac-llc`):
 *
 *  - team runs:     <crewRoot>/state/runs/<runId>/manifest.json (+ tasks.json,
 *                   and agents/<taskId>/status.json for per-agent model/progress)
 *  - subagents:     <crewRoot>/state/subagents/<id>.json
 *
 * `crewRoot` mirrors pi-crew's own resolvers (src/utils/paths.ts):
 *   userCrewRoot()    = <PI_CREW_HOME|~>/.pi/agent/extensions/pi-crew
 *   projectCrewRoot() = <repoRoot>/.crew   (repoRoot found by walking up)
 *
 * Everything here is defensive: a missing directory, an unreadable file or a
 * partial/corrupt JSON body is skipped, never thrown. The panel must render
 * even when pi-crew has never run.
 *
 * A record whose status still reads "running" is only reported as running when
 * it looks live (its runner pid is alive, its run is in the active-run
 * registry, or it was updated recently); a crashed run leaves "running" on
 * disk forever, and a panel that counts those would be worse than none. Such
 * entries are reported as "stale".
 *
 * Cost: one pass costs a few thousand synchronous fs calls on a mature host
 * (367 run dirs + 657 subagent records → ~57ms of blocked event loop), so the
 * sidebar's 4s poll must not trigger it every time:
 *  - `collectBackgroundAgents()` stays the uncached reader (in-process callers
 *    such as lib/panel-sources/runs.ts and the tests);
 *  - `collectBackgroundAgentsCached()` memoizes the scan per (cwd, home) for
 *    `AGENTS_LIST_CACHE_TTL_MS` so overlapping polls collapse into one scan;
 *  - `toSidebarEntry()` is the wire projection of the list endpoint: it drops
 *    the fields no list client reads (`goal`, `summary`, `artifactsRoot`,
 *    `artifacts`, ~85% of the JSON) while the in-process entries keep them.
 */

export type BackgroundAgentKind = "team" | "subagent";

export interface BackgroundAgentArtifact {
  name: string;
  path: string;
  sizeBytes?: number;
}

/**
 * One task/agent of a team run, as the panel needs it: which model it is
 * actually on, whether the router had to fall back, and how much work it has
 * done so a long grind is distinguishable from a hang.
 *
 * Source: `<runDir>/agents/<taskId>/status.json` — pi-crew's single writer for
 * agent records (src/runtime/crew-agent-records.ts), refreshed live while the
 * agent runs. `tasks.json` is only a fallback for runs that predate the per
 * agent status files. `tasks.json.model` is never populated by pi-crew, so the
 * model is derived from `model`/`routing`/`modelAttempts` on those sources.
 */
export interface BackgroundAgentTask {
  taskId: string;
  role: string;
  /** normalized: running | completed | failed | queued | waiting | unknown | raw */
  status: string;
  /** the model actually in use / used. */
  model: string | null;
  /** what the dispatch asked for. */
  requested: string | null;
  /** what the router resolved to; null while unresolved (still running). */
  resolved: string | null;
  /** requested is known and differs from resolved: a fallback happened. */
  drift: boolean;
  toolUses: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** the tool currently executing (in-flight agents only). */
  currentTool: string | null;
  /** failure text, when recorded. */
  error: string | null;
}

export interface BackgroundAgentEntry {
  /** team: the runId. subagent: the record id. */
  id: string;
  kind: BackgroundAgentKind;
  /** team: team name / runKind. subagent: agent type ("executor", ...). */
  role: string;
  /** team: first line of the goal. subagent: the description. */
  title: string;
  /** normalized: "running" | "completed" | "failed" | "stale" | other. */
  status: string;
  /** epoch ms, or null when unknown. */
  startedAt: number | null;
  /** epoch ms (the record's own update time, else the file mtime). */
  updatedAt: number | null;
  /** team only: task completion counters; null otherwise (or unknown). */
  progress: { completed: number; total: number } | null;
  /** A detail view for the entry in pi-web; null when none exists yet. */
  href: string | null;
  /** team only: full goal text (may be multi-line). */
  goal: string | null;
  /** team only: the run summary. */
  summary: string | null;
  /** The owning run id (for a subagent), if recorded. */
  runId: string | null;
  /** The owning pi-crew task id (for a subagent), if recorded. */
  taskId: string | null;
  /** The run's artifacts directory, if recorded. */
  artifactsRoot: string | null;
  /** A bounded list of the run's artifacts (team only). */
  artifacts: BackgroundAgentArtifact[];
  /** team only: its tasks/agents (bounded, running first). Empty otherwise. */
  agents: BackgroundAgentTask[];
}

const MAX_TITLE_LENGTH = 240;
const MAX_ARTIFACTS = 25;
/** Newest-first list: running entries first, then the most recently updated. */
const MAX_ENTRIES = 40;
/** A team run with no update for this long and no live runner is "stale". */
const RUN_STALE_MS = 15 * 60 * 1000;
/** A subagent record with no update for this long (and no live run) is "stale". */
const SUBAGENT_STALE_MS = 10 * 60 * 1000;
/** A heartbeat newer than this counts as a live runner (see heartbeat.json). */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim to a single, bounded line so one long goal cannot bloat the list. */
function firstLine(value: unknown, max = MAX_TITLE_LENGTH): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\r/g, "").split("\n").find((part) => part.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse an ISO timestamp or an epoch-ms number into epoch ms, else null. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Collapse the many on-disk status spellings to the panel's states. */
export function normalizeStatus(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (["running", "active", "in_progress", "in-progress", "started", "in-flight", "inflight"].includes(value)) {
    return "running";
  }
  if (["completed", "complete", "done", "success", "succeeded", "closed", "finished"].includes(value)) {
    return "completed";
  }
  if (["failed", "error", "failure", "cancelled", "canceled", "aborted", "killed", "timeout", "timed_out", "timedout", "stopped"].includes(value)) {
    return "failed";
  }
  return value;
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when a process with this pid exists (EPERM still means it exists). */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Candidate pi-crew crew roots that may hold `state/runs` and `state/subagents`. */
export function candidateCrewRoots(cwd = process.cwd(), home = homedir()): string[] {
  const roots = new Set<string>();
  const configured = process.env.PI_CREW_HOME?.trim() || process.env.PI_TEAMS_HOME?.trim();
  const piRoot = configured && configured !== "undefined" ? configured : join(home, ".pi", "agent");
  roots.add(join(piRoot, "extensions", "pi-crew"));
  roots.add(join(home, ".crew"));
  roots.add(join(home, "apps", "packages", "cac-llc", ".crew"));
  roots.add(join(home, "apps", "packages", "traka-orchestrator", ".crew"));
  // pi-crew also keeps per-project crew state in `<repoRoot>/.crew`; walk up
  // from the caller's cwd (and home) to catch those.
  for (const start of [cwd, home]) {
    let dir = resolve(start);
    for (let i = 0; i < 12; i += 1) {
      roots.add(join(dir, ".crew"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...roots].filter((root) => {
    try {
      return existsSync(root);
    } catch {
      return false;
    }
  });
}

/** The run ids pi-crew's active-run registry lists as live for one crew root. */
function readActiveRunIds(root: string): string[] {
  const index = readJson(join(root, "state", "runs", "active-run-index.json"));
  if (!Array.isArray(index)) return [];
  const ids: string[] = [];
  for (const item of index) {
    if (!isRecord(item)) continue;
    const runId = asString(item.runId);
    if (runId) ids.push(runId);
  }
  return ids;
}

function heartbeatLooksLive(runDir: string, now: number): boolean {
  const heartbeat = readJson(join(runDir, "heartbeat.json"));
  if (!isRecord(heartbeat)) return false;
  if (isPidAlive(asNumber(heartbeat.pid) ?? 0)) return true;
  const at = toEpochMs(heartbeat.at);
  return at !== null && now - at <= HEARTBEAT_STALE_MS;
}

const MAX_AGENTS_PER_RUN = 30;

/** Skill-free model/routing derivation shared by the status.json and tasks.json shapes. */
function modelFacts(source: Record<string, unknown> | null): {
  model: string | null;
  requested: string | null;
  resolved: string | null;
  drift: boolean;
} {
  const routing = source && isRecord(source.routing) ? source.routing : isRecord(source?.modelRouting) ? source.modelRouting : null;
  const attempts = Array.isArray(source?.modelAttempts) ? source.modelAttempts.filter(isRecord) : [];
  const requested = asString(routing?.requested) ?? asString(attempts[0]?.model) ?? null;
  const resolved =
    asString(routing?.resolved) ?? asString(attempts.find((attempt) => attempt.success === true)?.model) ?? null;
  const model = asString(source?.model) ?? resolved ?? asString(attempts.at(-1)?.model) ?? null;
  return { model, requested, resolved, drift: requested !== null && resolved !== null && requested !== resolved };
}

/**
 * The per-agent view of one run: `agents/<taskId>/status.json` (live, single
 * writer) with a `tasks.json` fallback for older runs. Bounded and defensive;
 * an unreadable record is skipped rather than failing the whole panel.
 *
 * `tasks` is the already-parsed `tasks.json` of this run: the caller reads that
 * file once and shares it with the progress rollup, so a poll does not parse
 * the same (often large) task list twice per run.
 */
function readRunAgents(runDir: string, tasks: unknown): BackgroundAgentTask[] {
  const agentsDir = join(runDir, "agents");
  const taskList = Array.isArray(tasks) ? tasks.filter(isRecord) : [];
  const taskById = new Map<string, Record<string, unknown>>();
  for (const task of taskList) {
    const taskId = asString(task.id);
    if (taskId) taskById.set(taskId, task);
  }

  const out: BackgroundAgentTask[] = [];
  const seen = new Set<string>();
  for (const name of listDir(agentsDir)) {
    if (name.startsWith(".")) continue;
    const statusPath = join(agentsDir, name, "status.json");
    const record = readJson(statusPath);
    if (!isRecord(record)) continue;
    const taskId = asString(record.taskId) ?? name;
    seen.add(taskId);
    const facts = modelFacts(record);
    out.push({
      taskId,
      role: asString(record.role) ?? asString(record.agent) ?? "task",
      status: normalizeStatus(record.status),
      ...facts,
      toolUses: asNumber(record.toolUses),
      startedAt: toEpochMs(record.startedAt),
      completedAt: toEpochMs(record.completedAt),
      currentTool: isRecord(record.progress) ? asString(record.progress.currentTool) : null,
      error: asString(record.error),
    });
  }

  // Fallback: runs written before per-agent status files existed.
  for (const [taskId, task] of taskById) {
    if (seen.has(taskId)) continue;
    const facts = modelFacts(task);
    const progress = isRecord(task.agentProgress) ? task.agentProgress : null;
    out.push({
      taskId,
      role: asString(task.role) ?? asString(task.agent) ?? "task",
      status: normalizeStatus(task.status),
      ...facts,
      toolUses: asNumber(progress?.toolCount) ?? asNumber(task.toolUses),
      startedAt: toEpochMs(task.startedAt),
      completedAt: toEpochMs(task.finishedAt) ?? toEpochMs(task.completedAt),
      currentTool: asString(progress?.currentTool),
      error: asString(task.error) ?? asString(task.failureCause),
    });
  }

  const rank = (status: string): number => (status === "running" ? 0 : status === "queued" || status === "waiting" ? 2 : 1);
  return out.sort((a, b) => rank(a.status) - rank(b.status)).slice(0, MAX_AGENTS_PER_RUN);
}

/** Completed/total rollup over the run's already-parsed `tasks.json`. */
function readTeamProgress(tasks: unknown): { completed: number; total: number } | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  let completed = 0;
  for (const task of tasks) {
    if (!isRecord(task)) continue;
    if (normalizeStatus(task.status) === "completed") completed += 1;
  }
  return { completed, total: tasks.length };
}

function readArtifacts(manifest: Record<string, unknown>): BackgroundAgentArtifact[] {
  const raw = manifest.artifacts;
  if (!Array.isArray(raw)) return [];
  const out: BackgroundAgentArtifact[] = [];
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

/**
 * The pi-web route that can actually render a run: `app/runs/[runId]` ->
 * `AgentRunDetailView` -> `GET /api/agents/runs/[runId]`.
 *
 * Only TEAM run ids resolve there (`collectRunDetail()` scans
 * `<crewRoot>/state/runs/<runId>/`). A subagent record id does not: it 404s
 * ("run not found") — so a subagent entry links to the run that owns it, where
 * its own task row is rendered.
 */
function runDetailHref(runId: string | null): string | null {
  if (!runId) return null;
  return `/runs/${encodeURIComponent(runId)}`;
}

function readTeamEntry(runDir: string, manifestPath: string): BackgroundAgentEntry | null {
  const manifest = readJson(manifestPath);
  if (!isRecord(manifest)) return null;
  const id = asString(manifest.runId) ?? runDir.split("/").pop() ?? "";
  if (!id) return null;
  const goal = asString(manifest.goal);
  const role = asString(manifest.team) ?? asString(manifest.runKind) ?? "team";
  // Read once: both the progress rollup and the per-agent fallback need it.
  const tasks = readJson(join(runDir, "tasks.json"));
  return {
    id,
    kind: "team",
    role,
    title: firstLine(goal) || id,
    status: normalizeStatus(manifest.status),
    startedAt: toEpochMs(manifest.createdAt),
    updatedAt: toEpochMs(manifest.updatedAt) ?? fileMtimeMs(manifestPath),
    progress: readTeamProgress(tasks),
    href: runDetailHref(id),
    goal: goal ?? null,
    summary: asString(manifest.summary),
    runId: id,
    taskId: null,
    artifactsRoot: asString(manifest.artifactsRoot),
    artifacts: readArtifacts(manifest),
    agents: readRunAgents(runDir, tasks),
  };
}

function readSubagentEntry(filePath: string): BackgroundAgentEntry | null {
  const record = readJson(filePath);
  if (!isRecord(record)) return null;
  const id = asString(record.id) ?? filePath.split("/").pop()?.replace(/\.json$/, "") ?? "";
  if (!id) return null;
  const description = asString(record.description);
  return {
    id,
    kind: "subagent",
    role: asString(record.type) ?? "subagent",
    title: firstLine(description) || id,
    status: normalizeStatus(record.status),
    startedAt: toEpochMs(record.startedAt),
    updatedAt: fileMtimeMs(filePath),
    progress: null,
    href: runDetailHref(asString(record.runId)),
    goal: null,
    summary: null,
    runId: asString(record.runId),
    taskId: asString(record.taskId),
    artifactsRoot: null,
    artifacts: [],
    agents: [],
  };
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface Liveness {
  liveRunIds: Set<string>;
  now: number;
}

function collectTeamRuns(root: string, liveness: Liveness, out: BackgroundAgentEntry[]): void {
  const runsDir = join(root, "state", "runs");
  for (const name of listDir(runsDir)) {
    if (name.startsWith(".")) continue;
    const runDir = join(runsDir, name);
    if (!isDirectory(runDir)) continue;
    // No separate existsSync for manifest.json: readJson() already degrades a
    // missing/unreadable file to `undefined` → readTeamEntry() returns null, so
    // the gate would only cost one syscall per run dir per poll.
    const manifestPath = join(runDir, "manifest.json");
    try {
      const entry = readTeamEntry(runDir, manifestPath);
      if (!entry) continue;
      if (entry.status === "running") {
        const live =
          liveness.liveRunIds.has(entry.id) ||
          heartbeatLooksLive(runDir, liveness.now) ||
          (entry.updatedAt !== null && liveness.now - entry.updatedAt <= RUN_STALE_MS);
        if (!live) entry.status = "stale";
      }
      out.push(entry);
    } catch {
      // skip unreadable/partial run
    }
  }
}

function collectSubagents(root: string, liveness: Liveness, out: BackgroundAgentEntry[]): void {
  const subagentsDir = join(root, "state", "subagents");
  for (const name of listDir(subagentsDir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const filePath = join(subagentsDir, name);
    try {
      const entry = readSubagentEntry(filePath);
      if (!entry) continue;
      if (entry.status === "running") {
        const live =
          (entry.runId !== null && liveness.liveRunIds.has(entry.runId)) ||
          (entry.updatedAt !== null && liveness.now - entry.updatedAt <= SUBAGENT_STALE_MS);
        if (!live) entry.status = "stale";
      }
      out.push(entry);
    } catch {
      // skip unreadable/partial record
    }
  }
}

function statusRank(status: string): number {
  if (status === "running") return 0;
  if (status === "unknown") return 2;
  return 1;
}

/** Recent-first, running-first. Exported for tests. */
export function sortEntries(entries: BackgroundAgentEntry[]): BackgroundAgentEntry[] {
  return [...entries].sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

/**
 * Discover every running/recent pi-crew agent, running first then most recently
 * updated. Never throws; an unreadable root or record is skipped.
 */
export function collectBackgroundAgents(
  cwd = process.cwd(),
  home = homedir(),
  now = Date.now(),
): BackgroundAgentEntry[] {
  const roots = candidateCrewRoots(cwd, home);
  // Live runner ids are collected across every root first: a subagent lives in
  // the project crew root (<cwd>/.crew) while its run's registry entry lives in
  // the user root (~/.pi/agent/extensions/pi-crew).
  const liveRunIds = new Set<string>();
  for (const root of roots) {
    for (const runId of readActiveRunIds(root)) liveRunIds.add(runId);
  }
  const liveness: Liveness = { liveRunIds, now };

  const teamEntries: BackgroundAgentEntry[] = [];
  const subagentEntries: BackgroundAgentEntry[] = [];
  const seenTeam = new Set<string>();
  const seenSubagent = new Set<string>();

  for (const root of roots) {
    const localTeams: BackgroundAgentEntry[] = [];
    const localSubagents: BackgroundAgentEntry[] = [];
    try {
      collectTeamRuns(root, liveness, localTeams);
      collectSubagents(root, liveness, localSubagents);
    } catch {
      continue;
    }
    for (const entry of localTeams) {
      const key = entry.id;
      if (seenTeam.has(key)) continue;
      seenTeam.add(key);
      teamEntries.push(entry);
    }
    for (const entry of localSubagents) {
      const key = entry.id;
      if (seenSubagent.has(key)) continue;
      seenSubagent.add(key);
      subagentEntries.push(entry);
    }
  }

  // Deduplicate subagents by runId + taskId (or id) if duplicates exist, keeping the most recently updated.
  const subagentMap = new Map<string, BackgroundAgentEntry>();
  for (const sub of subagentEntries) {
    const uniqueKey = sub.runId && sub.taskId ? `${sub.runId}:${sub.taskId}` : sub.id;
    const existing = subagentMap.get(uniqueKey);
    if (!existing || (sub.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      subagentMap.set(uniqueKey, sub);
    }
  }
  const uniqueSubagents = [...subagentMap.values()];

  // Track run IDs that have individual task worker cards (subagents) present
  const runIdsWithSubagents = new Set<string>();
  for (const sub of uniqueSubagents) {
    if (sub.runId) {
      runIdsWithSubagents.add(sub.runId);
    }
  }

  // Filter out raw team execution wrappers if individual task worker cards are present
  const filteredTeams = teamEntries.filter((team) => {
    if (runIdsWithSubagents.has(team.id)) {
      return false;
    }
    return true;
  });

  const combined = [...filteredTeams, ...uniqueSubagents];
  return sortEntries(combined).slice(0, MAX_ENTRIES);
}

/**
 * How long one full scan of pi-crew state is reused for `GET /api/agents/runs`.
 *
 * The sidebar polls every 4s and the scan is synchronous (it blocks this
 * Node process), so a short memo turns overlapping polls — the sidebar, a
 * second tab, a page reload — into one scan. 2s keeps the worst-case age of a
 * run's status well inside the panel's own 4s tick: the UI can never be older
 * than one poll interval plus this TTL.
 */
export const AGENTS_LIST_CACHE_TTL_MS = 2_000;

interface AgentsListCacheSlot {
  storedAt: number;
  entries: BackgroundAgentEntry[];
}

/** Process-local memo, keyed per (cwd, home); tests reset it explicitly. */
const agentsListCache = new Map<string, AgentsListCacheSlot>();

function agentsListCacheKey(cwd: string, home: string): string {
  return `${cwd}\u0000${home}`;
}

/**
 * The list endpoint's reader: `collectBackgroundAgents()` memoized for
 * `ttlMs` (default `AGENTS_LIST_CACHE_TTL_MS`, `0` disables the cache).
 *
 * The returned array is shared with every caller inside the TTL window, so it
 * is frozen to make an accidental in-place mutation fail loudly instead of
 * corrupting the next poll's answer. Entry objects themselves stay plain: the
 * list endpoint projects them (`toSidebarEntry`) and never writes to them.
 */
export function collectBackgroundAgentsCached(options: {
  cwd?: string;
  home?: string;
  now?: number;
  ttlMs?: number;
} = {}): BackgroundAgentEntry[] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const ttlMs = options.ttlMs ?? AGENTS_LIST_CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  const key = agentsListCacheKey(cwd, home);
  if (ttlMs > 0) {
    const slot = agentsListCache.get(key);
    if (slot && now - slot.storedAt >= 0 && now - slot.storedAt < ttlMs) return slot.entries;
  }
  const entries = collectBackgroundAgents(cwd, home, now);
  // Freeze in place: every caller inside the TTL window shares this array.
  Object.freeze(entries);
  if (ttlMs > 0) {
    agentsListCache.set(key, { storedAt: now, entries });
    // Keep the memo from growing per test/tenant cwd; the panel only ever uses one.
    if (agentsListCache.size > 8) {
      const oldest = [...agentsListCache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0]?.[0];
      if (oldest !== undefined && oldest !== key) agentsListCache.delete(oldest);
    }
  }
  return entries;
}

/** Drop every memoized list (tests, and callers that just changed pi-crew state). */
export function resetBackgroundAgentsCache(): void {
  agentsListCache.clear();
}

/**
 * One entry as `GET /api/agents/runs` sends it to the browser.
 *
 * Measured on this host: the full entries are ~121KB per poll, of which
 * `artifacts` (lists of absolute artifact paths, 25/run) and `goal` (the
 * complete, multi-line goal text) are ~85% — and no list client reads either:
 * `components/BackgroundAgentsPanel.tsx` renders `title`, the per-agent model
 * chips, elapsed time and the running count, and the run detail view fetches
 * `GET /api/agents/runs/[runId]` for the rest. Server-side callers keep the
 * full entries; only the wire payload is projected.
 */
export type SidebarAgentEntry = Omit<
  BackgroundAgentEntry,
  "goal" | "summary" | "artifactsRoot" | "artifacts"
>;

export function toSidebarEntry(entry: BackgroundAgentEntry): SidebarAgentEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    role: entry.role,
    title: entry.title,
    status: entry.status,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    progress: entry.progress,
    href: entry.href,
    runId: entry.runId,
    taskId: entry.taskId,
    agents: entry.agents,
  };
}
