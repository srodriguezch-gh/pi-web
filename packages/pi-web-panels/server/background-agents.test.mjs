import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  collectBackgroundAgents,
  collectBackgroundAgentsCached,
  candidateCrewRoots,
  normalizeStatus,
  resetBackgroundAgentsCache,
  sortEntries,
  toSidebarEntry,
} = await jiti.import("./background-agents.ts");

const NOW = Date.parse("2026-10-16T00:20:00.000Z");

function withIsolatedHome(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-bg-agents-"));
  const home = join(dir, "home");
  const cwd = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previous = { crew: process.env.PI_CREW_HOME, teams: process.env.PI_TEAMS_HOME };
  delete process.env.PI_CREW_HOME;
  delete process.env.PI_TEAMS_HOME;
  try {
    return run({ dir, home, cwd });
  } finally {
    if (previous.crew === undefined) delete process.env.PI_CREW_HOME;
    else process.env.PI_CREW_HOME = previous.crew;
    if (previous.teams === undefined) delete process.env.PI_TEAMS_HOME;
    else process.env.PI_TEAMS_HOME = previous.teams;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a team run at <root>/state/runs/<runId>/manifest.json (+ tasks.json). */
function writeTeamRun(root, runId, manifest, tasks) {
  const runDir = join(root, "state", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest));
  if (tasks) writeFileSync(join(runDir, "tasks.json"), JSON.stringify(tasks));
  return runDir;
}

function writeActiveRunIndex(root, runIds) {
  const runsDir = join(root, "state", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, "active-run-index.json"),
    JSON.stringify(runIds.map((runId) => ({ runId, cwd: "/x", stateRoot: `/x/${runId}`, manifestPath: `/x/${runId}/manifest.json`, updatedAt: "2026-10-16T00:00:00.000Z" }))),
  );
}

test("normalizeStatus collapses the on-disk spellings to the panel's states", () => {
  assert.equal(normalizeStatus("running"), "running");
  assert.equal(normalizeStatus("ACTIVE"), "running");
  assert.equal(normalizeStatus("in_progress"), "running");
  assert.equal(normalizeStatus("completed"), "completed");
  assert.equal(normalizeStatus("done"), "completed");
  assert.equal(normalizeStatus("failed"), "failed");
  assert.equal(normalizeStatus("cancelled"), "failed");
  assert.equal(normalizeStatus("timed_out"), "failed");
  assert.equal(normalizeStatus("stopped"), "failed");
  assert.equal(normalizeStatus("weird"), "weird");
  assert.equal(normalizeStatus(""), "unknown");
  assert.equal(normalizeStatus(undefined), "unknown");
});

test("sortEntries puts running first, then most-recently-updated", () => {
  const sorted = sortEntries([
    { id: "b", status: "completed", updatedAt: 100 },
    { id: "a", status: "running", updatedAt: 1 },
    { id: "c", status: "completed", updatedAt: 200 },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["a", "c", "b"]);
});

test("collectBackgroundAgents reads team runs and subagents, filtering out team wrapper when subagent is present", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    const runId = "team_20261016001347_25ad259c730e3658";
    writeActiveRunIndex(userRoot, [runId]);
    writeTeamRun(
      userRoot,
      runId,
      {
        runId,
        team: "direct-executor",
        workflow: "direct-agent",
        goal: "Build the Background Agents panel\nsecond line ignored",
        status: "running",
        runKind: "team-run",
        createdAt: "2026-10-16T00:13:47.557Z",
        updatedAt: "2026-10-16T00:20:00.000Z",
        artifactsRoot: `${userRoot}/artifacts/${runId}`,
        artifacts: [
          { kind: "prompt", path: `${userRoot}/artifacts/${runId}/goal.md`, sizeBytes: 10 },
          { kind: "log", path: `${userRoot}/artifacts/${runId}/events.jsonl` },
        ],
      },
      [
        { id: "01", status: "completed" },
        { id: "02", status: "completed" },
        { id: "03", status: "running" },
      ],
    );

    // Same root also carries a subagent registry.
    const saDir = join(userRoot, "state", "subagents");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(
      join(saDir, "agent_abc_executor_1.json"),
      JSON.stringify({
        id: "agent_abc_executor_1",
        type: "executor",
        description: "Refactor the watcher",
        status: "completed",
        startedAt: Date.parse("2026-10-16T00:14:00.000Z"),
        runId,
        taskId: "01_01-agent",
      }),
    );

    // A partial/corrupt run must be skipped, never thrown on.
    const badDir = join(userRoot, "state", "runs", "team_corrupt");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "manifest.json"), "{ not json");

    const agents = collectBackgroundAgents(cwd, home, NOW);
    assert.equal(agents.length, 1, "team wrapper filtered out when subagent is present, corrupt run skipped");

    const sub = agents.find((entry) => entry.kind === "subagent");
    assert.ok(sub, "subagent present");
    assert.equal(sub.id, "agent_abc_executor_1");
    assert.equal(sub.role, "executor");
    assert.equal(sub.status, "completed");
    assert.equal(sub.title, "Refactor the watcher");
    assert.equal(sub.runId, runId);
    assert.equal(sub.taskId, "01_01-agent");
    assert.equal(typeof sub.updatedAt, "number", "updatedAt falls back to the file mtime");
  });
});

test("collectBackgroundAgents keeps team run when no subagent is present", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    const runId = "team_standalone";
    writeTeamRun(userRoot, runId, {
      runId,
      team: "standalone-team",
      goal: "Standalone team run",
      status: "running",
      createdAt: "2026-10-16T00:10:00.000Z",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    const agents = collectBackgroundAgents(cwd, home, NOW);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].kind, "team");
    assert.equal(agents[0].id, runId);
  });
});

test("every entry carries the detail route that can actually render it", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");

    // A team run without subagents: it links to its own /runs/<runId>.
    writeTeamRun(userRoot, "team_linked", {
      runId: "team_linked",
      team: "worker",
      goal: "Linked run",
      status: "completed",
      createdAt: "2026-10-16T00:10:00.000Z",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });

    // A subagent links to the run that OWNS it: a subagent record id is not a
    // run id, so /runs/<record id> answers 404 "run not found".
    const parentRunId = "team_parent_of_subagent";
    const saDir = join(userRoot, "state", "subagents");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(
      join(saDir, "agent_linked_executor_1.json"),
      JSON.stringify({
        id: "agent_linked_executor_1",
        type: "executor",
        description: "Linked subagent",
        status: "completed",
        startedAt: Date.parse("2026-10-16T00:14:00.000Z"),
        runId: parentRunId,
        taskId: "01_01-agent",
      }),
    );
    // A subagent record that never recorded its run has no detail view at all —
    // better a plain card than a link to a 404.
    writeFileSync(
      join(saDir, "agent_orphan_executor_2.json"),
      JSON.stringify({
        id: "agent_orphan_executor_2",
        type: "executor",
        description: "Orphan subagent",
        status: "completed",
        startedAt: Date.parse("2026-10-16T00:15:00.000Z"),
      }),
    );

    const agents = collectBackgroundAgents(cwd, home, NOW);
    const byId = new Map(agents.map((entry) => [entry.id, entry]));

    assert.equal(byId.get("team_linked").href, "/runs/team_linked", "a team run links to its own detail page");
    assert.equal(
      byId.get("agent_linked_executor_1").href,
      `/runs/${parentRunId}`,
      "a subagent links to the run that owns it, not to its own unresolvable record id",
    );
    assert.equal(byId.get("agent_orphan_executor_2").href, null, "no run id, no dead link");

    // The route survives the wire projection — the panel reads it there.
    for (const entry of agents) {
      assert.equal(toSidebarEntry(entry).href, entry.href, `${entry.id}: href must reach the list client`);
    }
  });
});

test("a running record with no live runner or recent update is reported stale", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    // No active-run-index entry, and the manifest was last updated long ago.
    writeTeamRun(userRoot, "team_dead", {
      runId: "team_dead",
      team: "ghost",
      goal: "Crashed run",
      status: "running",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:05:00.000Z",
    });
    const agents = collectBackgroundAgents(cwd, home, NOW);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].status, "stale", "a crashed run must not count as running");
  });
});

test("a running record updated just now is live even without a registry entry", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    writeTeamRun(userRoot, "team_fresh", {
      runId: "team_fresh",
      team: "worker",
      goal: "Fresh run",
      status: "running",
      createdAt: "2026-10-16T00:10:00.000Z",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    const agents = collectBackgroundAgents(cwd, home, NOW);
    assert.equal(agents[0].status, "running");
  });
});

test("collectBackgroundAgents returns [] (never throws) when there is no pi-crew state", () => {
  withIsolatedHome(({ home, cwd }) => {
    const agents = collectBackgroundAgents(cwd, home, NOW);
    assert.deepEqual(agents, []);
    assert.deepEqual(candidateCrewRoots(cwd, home), [], "no crew roots exist for a bare temp home");
  });
});

/** One team run with the fields the list endpoint used to send but never uses. */
function writeRichTeamRun(root, runId) {
  const runDir = writeTeamRun(
    root,
    runId,
    {
      runId,
      team: "standalone-team",
      goal: "Long goal line\n" + "x".repeat(4000),
      summary: "y".repeat(2000),
      status: "completed",
      createdAt: "2026-10-16T00:10:00.000Z",
      updatedAt: new Date(NOW - 60_000).toISOString(),
      artifactsRoot: `${root}/artifacts/${runId}`,
      artifacts: Array.from({ length: 25 }, (_, index) => ({
        kind: "artifact",
        path: `${root}/artifacts/${runId}/a-very-long-artifact-name-${index}.md`,
        sizeBytes: 1234,
      })),
    },
    [
      { id: "01", status: "completed" },
      { id: "02", status: "running" },
    ],
  );
  // The status.json taskId matches tasks.json's id, so the fallback pass does not
  // duplicate the task (that is the id pi-crew itself writes).
  const agentDir = join(runDir, "agents", "01");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "status.json"),
    JSON.stringify({
      taskId: "01",
      role: "executor",
      status: "completed",
      model: "litellm/deepseek-chat",
      routing: { requested: "litellm/deepseek-chat", resolved: "litellm/qwen3-coder" },
      toolUses: 12,
      progress: { currentTool: null },
    }),
  );
  return runDir;
}

test("one scan reads tasks.json once and still fills both progress and per-agent rows", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    writeRichTeamRun(userRoot, "team_onepass");

    const [entry] = collectBackgroundAgents(cwd, home, NOW);
    assert.equal(entry.id, "team_onepass");
    // progress comes from tasks.json …
    assert.deepEqual(entry.progress, { completed: 1, total: 2 });
    // … and the same parse feeds the per-task fallback: the agents/ dir holds only
    // task 01, so task 02 must be recovered from that same tasks.json.
    const byTask = new Map(entry.agents.map((agent) => [agent.taskId, agent]));
    assert.equal(byTask.size, 2);
    assert.equal(byTask.get("01").model, "litellm/deepseek-chat", "status.json wins for task 01");
    assert.equal(byTask.get("01").resolved, "litellm/qwen3-coder");
    assert.equal(byTask.get("01").drift, true, "requested != resolved is surfaced as drift");
    assert.equal(byTask.get("01").toolUses, 12);
    assert.equal(byTask.get("02").status, "running", "task 02 falls back to tasks.json");
  });
});

test("the list projection drops the fields no list client reads", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
    writeRichTeamRun(userRoot, "team_payload");
    const [entry] = collectBackgroundAgents(cwd, home, NOW);

    const wire = toSidebarEntry(entry);
    for (const dropped of ["goal", "summary", "artifactsRoot", "artifacts"]) {
      assert.equal(dropped in wire, false, `${dropped} must not be sent to the list client`);
    }
    // Everything the panel renders survives.
    assert.equal(wire.id, entry.id);
    assert.equal(wire.title, entry.title);
    assert.equal(wire.status, entry.status);
    assert.deepEqual(wire.progress, entry.progress);
    assert.deepEqual(wire.agents, entry.agents);

    const before = JSON.stringify([entry]).length;
    const after = JSON.stringify([wire]).length;
    assert.ok(after < before / 2, `projection must at least halve the payload (${before} -> ${after})`);
  });
});

test("collectBackgroundAgentsCached reuses one scan inside the TTL and re-scans after a reset", () => {
  withIsolatedHome(({ home, cwd }) => {
    resetBackgroundAgentsCache();
    try {
      const userRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
      writeTeamRun(userRoot, "team_first", {
        runId: "team_first",
        team: "worker",
        goal: "First run",
        status: "completed",
        createdAt: "2026-10-16T00:10:00.000Z",
        updatedAt: new Date(NOW - 120_000).toISOString(),
      });

      const first = collectBackgroundAgentsCached({ cwd, home, now: NOW, ttlMs: 2_000 });
      assert.equal(first.length, 1);

      // A run that appears right after the first poll is not seen until the TTL
      // expires — that is the documented cost (<= 1 poll interval of lag).
      writeTeamRun(userRoot, "team_second", {
        runId: "team_second",
        team: "worker",
        goal: "Second run",
        status: "completed",
        createdAt: "2026-10-16T00:16:00.000Z",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      });
      const cached = collectBackgroundAgentsCached({ cwd, home, now: NOW + 1_000, ttlMs: 2_000 });
      assert.equal(cached, first, "a cache hit returns the memoized array, not a new scan");
      assert.equal(cached.length, 1);

      const expired = collectBackgroundAgentsCached({ cwd, home, now: NOW + 2_500, ttlMs: 2_000 });
      assert.equal(expired.length, 2, "a poll past the TTL re-scans");

      assert.equal(
        collectBackgroundAgentsCached({ cwd, home, now: NOW + 2_500, ttlMs: 0 }).length,
        2,
        "ttlMs: 0 bypasses the cache (callers that just changed state)",
      );
    } finally {
      resetBackgroundAgentsCache();
    }
  });
});
