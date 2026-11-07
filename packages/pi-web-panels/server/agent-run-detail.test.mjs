import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectRunDetail, isSafeRunId, summarizeToolArgs, oneLine } = await jiti.import("./agent-run-detail.ts");
const { collectBackgroundAgents } = await jiti.import("./background-agents.ts");

const NOW = Date.parse("2026-10-27T20:50:00.000Z");
const RUN_ID = "team_20261027204049_5d9fe6c3f784c2e2";

/** Build a team run fixture mirroring pi-crew's real on-disk shape. */
function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-run-detail-"));
  const home = join(dir, "home");
  const cwd = join(dir, "work");
  const crewRoot = join(home, ".pi", "agent", "extensions", "pi-crew");
  const runDir = join(crewRoot, "state", "runs", RUN_ID);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      runId: RUN_ID,
      team: "fast-fix",
      workflow: "fast-fix",
      status: "running",
      goal: "Surface the model per agent",
      createdAt: "2026-10-27T20:40:51.000Z",
      updatedAt: "2026-10-27T20:49:50.000Z",
      stateRoot: runDir,
      artifactsRoot: join(dir, "artifacts"),
      artifacts: [{ path: join(dir, "artifacts", "goal.md"), sizeBytes: 2048 }],
    }),
  );

  writeFileSync(
    join(runDir, "tasks.json"),
    JSON.stringify([
      {
        id: "01_explore",
        role: "explorer",
        agent: "explorer",
        title: "Trace the read path",
        status: "completed",
        startedAt: "2026-10-27T20:40:51.787Z",
        finishedAt: "2026-10-27T20:43:04.064Z",
        modelAttempts: [{ model: "deepseek/deepseek-flash", success: true, exitCode: 0 }],
        modelRouting: {
          requested: "deepseek/deepseek-flash",
          resolved: "deepseek/deepseek-flash",
          usedAttempt: 0,
          reason: "configured Pi fallback chain",
          fallbackChain: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
        },
        agentProgress: {
          toolCount: 41,
          recentTools: [
            { tool: "read", args: '{"path":"/tmp/a.ts"}', endedAt: "2026-10-27T20:41:00.000Z" },
            { tool: "bash", args: '{"command":"grep -rn model .\\n  | head"}', endedAt: "2026-10-27T20:41:05.000Z" },
          ],
          recentOutput: ["line one", "line two"],
        },
      },
      {
        id: "01_01-agent",
        role: "agent",
        agent: "agent",
        title: "Fix the routing fallback",
        status: "completed",
        startedAt: "2026-10-27T20:44:00.000Z",
        finishedAt: "2026-10-27T20:46:00.000Z",
        modelAttempts: [
          {
            model: "xiaomi-token-plan-sgp/mimo-v2.5",
            success: false,
            exitCode: 0,
            error: 'Model returned only retryable errors and no output: 400: {"code":"400","message":"Unsupported model mimo-v2.5"}',
          },
          { model: "kilo/kilo-auto/free", success: true, exitCode: 0 },
        ],
        modelRouting: {
          requested: "xiaomi-token-plan-sgp/mimo-v2.5",
          resolved: "kilo/kilo-auto/free",
          usedAttempt: 1,
          reason: 'Model returned only retryable errors and no output: 400: {"message":"Unsupported model mimo-v2.5"}',
        },
        agentProgress: { toolCount: 12, recentTools: [] },
      },
      {
        id: "02_execute",
        role: "executor",
        agent: "executor",
        title: "Render it in the UI",
        status: "running",
        startedAt: "2026-10-27T20:43:04.160Z",
        modelAttempts: [{ model: "deepseek/deepseek-flash", success: false }],
        agentProgress: {
          toolCount: 84,
          activityState: "active",
          currentTool: "bash",
          currentToolArgs: '{"command":"sleep 90; node verify.js"}',
          recentTools: [
            { tool: "edit", args: '{"edits":[{"oldText":"a","newText":"b"}]}', endedAt: "2026-10-27T20:48:00.000Z" },
          ],
        },
      },
      {
        id: "03_verify",
        role: "verifier",
        agent: "verifier",
        title: "Verify",
        status: "queued",
        dependsOn: ["02_execute"],
      },
    ]),
  );

  writeFileSync(join(runDir, "heartbeat.json"), JSON.stringify({ pid: process.pid, at: "2026-10-27T20:49:55.000Z" }));

  // Per-agent live status files (the source of model + toolUses while running).
  const writeAgentStatus = (taskId, body) => {
    const statusDir = join(runDir, "agents", taskId);
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "status.json"), JSON.stringify(body));
  };
  writeAgentStatus("01_explore", {
    taskId: "01_explore",
    role: "explorer",
    status: "completed",
    startedAt: "2026-10-27T20:40:51.787Z",
    completedAt: "2026-10-27T20:43:04.064Z",
    toolUses: 41,
    model: "deepseek/deepseek-flash",
    routing: { requested: "deepseek/deepseek-flash", resolved: "deepseek/deepseek-flash", usedAttempt: 0 },
    progress: { toolCount: 41, currentTool: null },
  });
  writeAgentStatus("02_execute", {
    taskId: "02_execute",
    role: "executor",
    status: "running",
    startedAt: "2026-10-27T20:43:04.160Z",
    toolUses: 85,
    model: "deepseek/deepseek-flash",
    progress: { toolCount: 85, currentTool: "bash", activityState: "active" },
  });

  const previous = { crew: process.env.PI_CREW_HOME, teams: process.env.PI_TEAMS_HOME };
  delete process.env.PI_CREW_HOME;
  delete process.env.PI_TEAMS_HOME;
  try {
    return run({ dir, home, cwd, crewRoot, runDir });
  } finally {
    if (previous.crew === undefined) delete process.env.PI_CREW_HOME;
    else process.env.PI_CREW_HOME = previous.crew;
    if (previous.teams === undefined) delete process.env.PI_TEAMS_HOME;
    else process.env.PI_TEAMS_HOME = previous.teams;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("summarizeToolArgs reduces bash/edit payloads to one bounded line", () => {
  assert.equal(summarizeToolArgs('{"path":"/tmp/a.ts"}'), "/tmp/a.ts");
  assert.equal(summarizeToolArgs('{"command":"grep -rn model .\\n  | head"}'), "grep -rn model . | head");
  assert.equal(summarizeToolArgs('{"edits":[{"oldText":"a","newText":"b"}]}'), "1 item");
  assert.equal(summarizeToolArgs("plain text"), "plain text");
  assert.equal(summarizeToolArgs(null), "");
  // pi-crew truncates the recorded args mid-JSON; the fragment still yields a target.
  assert.equal(
    summarizeToolArgs('{"command":"cd /home/silvio && grep -rln \\"isRetryable\\" --include=*.ts .\n\t…'),
    'cd /home/silvio && grep -rln "isRetryable" --include=*.ts .',
  );
  assert.equal(summarizeToolArgs('{"path":"/tmp/a.ts","offset":1,"li…'), "/tmp/a.ts");
  assert.ok(oneLine("x".repeat(300), 110).endsWith("…"));
});

test("isSafeRunId refuses traversal and separators", () => {
  assert.equal(isSafeRunId(RUN_ID), true);
  assert.equal(isSafeRunId("../../etc/passwd"), false);
  assert.equal(isSafeRunId("a/b"), false);
  assert.equal(isSafeRunId(""), false);
  assert.equal(isSafeRunId("a b"), false);
});

test("collectRunDetail carries model, requested->resolved, tools, elapsed and activity per task", () => {
  withFixture(({ cwd, home }) => {
    const run = collectRunDetail(RUN_ID, NOW, cwd, home);
    assert.ok(run, "run resolves from the crew root");
    assert.equal(run.team, "fast-fix");
    assert.equal(run.status, "running");
    assert.equal(run.live, true, "fresh heartbeat keeps the run live");
    assert.deepEqual(run.counts, { completed: 2, running: 1, queued: 1 });
    assert.equal(run.tasks.length, 4);

    const explore = run.tasks.find((task) => task.id === "01_explore");
    assert.equal(explore.model.model, "deepseek/deepseek-flash");
    assert.equal(explore.model.requested, "deepseek/deepseek-flash");
    assert.equal(explore.model.resolved, "deepseek/deepseek-flash");
    assert.equal(explore.model.drift, false, "no fallback badge on a clean run");
    assert.equal(explore.toolUses, 41);
    assert.equal(explore.elapsedMs, (2 * 60 + 12) * 1000 + 277, "finishedAt - startedAt");
    assert.deepEqual(
      explore.recentTools.map((tool) => [tool.tool, tool.target]),
      [
        ["bash", "grep -rn model . | head"],
        ["read", "/tmp/a.ts"],
      ],
      "newest first, args reduced to the target",
    );
    assert.deepEqual(explore.recentOutput, ["line one", "line two"]);

    const fallback = run.tasks.find((task) => task.id === "01_01-agent");
    assert.equal(fallback.model.requested, "xiaomi-token-plan-sgp/mimo-v2.5");
    assert.equal(fallback.model.resolved, "kilo/kilo-auto/free");
    assert.equal(fallback.model.drift, true, "a fallback is detectable");
    assert.equal(fallback.model.usedAttempt, 2, "usedAttempt is 1-based for display");
    assert.equal(fallback.model.attempts, 2);
    assert.match(fallback.model.fallbackReason, /Unsupported model mimo-v2\.5/);
    assert.deepEqual(
      fallback.model.failedAttempts.map((attempt) => attempt.model),
      ["xiaomi-token-plan-sgp/mimo-v2.5"],
    );
    assert.match(fallback.model.failedAttempts[0].error, /Unsupported model mimo-v2\.5/);

    const running = run.tasks.find((task) => task.id === "02_execute");
    assert.equal(running.model.model, "deepseek/deepseek-flash", "model shows while routing is still pending");
    assert.equal(running.model.resolved, null);
    assert.equal(running.model.drift, false, "unresolved is not a fallback");
    assert.equal(running.toolUses, 85, "per-agent status.json wins over tasks.json toolCount");
    assert.equal(running.currentTool, "bash");
    assert.equal(running.recentTools[0].tool, "bash", "the in-flight call heads the activity list");
    assert.equal(running.recentTools[0].target, "sleep 90; node verify.js");
    assert.equal(running.elapsedMs, NOW - Date.parse("2026-10-27T20:43:04.160Z"), "elapsed ticks against now");

    const queued = run.tasks.find((task) => task.id === "03_verify");
    assert.equal(queued.status, "queued");
    assert.equal(queued.model.model, null);
    assert.equal(queued.elapsedMs, null);
    assert.deepEqual(queued.dependsOn, ["02_execute"]);
  });
});

test("collectRunDetail returns null for an unknown run id", () => {
  withFixture(({ cwd, home }) => {
    assert.equal(collectRunDetail("team_does_not_exist", NOW, cwd, home), null);
    assert.equal(collectRunDetail("../../etc", NOW, cwd, home), null);
  });
});

test("the panel entry carries the per-agent model rollup from status.json", () => {
  withFixture(({ cwd, home }) => {
    const entries = collectBackgroundAgents(cwd, home, NOW);
    const entry = entries.find((item) => item.id === RUN_ID);
    assert.ok(entry, "the run appears in the panel list");
    assert.equal(entry.agents.length, 4, "every task is represented (status.json + tasks.json fallback)");
    const running = entry.agents.filter((agent) => agent.status === "running");
    assert.deepEqual(running.map((agent) => agent.taskId), ["02_execute"], "running agents sort first");
    assert.equal(running[0].model, "deepseek/deepseek-flash");
    assert.equal(running[0].toolUses, 85);
    assert.equal(running[0].currentTool, "bash");

    const failedOver = entry.agents.find((agent) => agent.taskId === "01_01-agent");
    assert.equal(failedOver.model, "kilo/kilo-auto/free", "the successful attempt is the model in use");
    assert.equal(failedOver.requested, "xiaomi-token-plan-sgp/mimo-v2.5");
    assert.equal(failedOver.drift, true);
  });
});
