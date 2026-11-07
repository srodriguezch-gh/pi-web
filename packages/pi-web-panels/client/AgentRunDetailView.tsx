"use client";

import React, { useEffect, useState } from "react";

import { formatElapsed } from "./BackgroundAgentsPanel";

/**
 * Run detail view (route: /runs/[runId]).
 *
 * Read-only "what is actually happening" for one pi-crew team run: per task the
 * model in use, requested→resolved when they differ, tool count, elapsed time,
 * the recent tool calls with their targets, the tail of the agent's output and
 * any failure text — refreshed on the same 4s cadence the sidebar panel uses
 * (one poll loop for this view, no extra timer).
 */

export interface ApiTaskModel {
  model: string | null;
  requested: string | null;
  resolved: string | null;
  drift: boolean;
  attempts: number;
  usedAttempt: number | null;
  fallbackReason: string | null;
  failedAttempts: Array<{ model: string; error: string }>;
}

export interface ApiTask {
  id: string;
  role: string;
  agent: string;
  title: string;
  status: string;
  rawStatus: string;
  model: ApiTaskModel;
  toolUses: number | null;
  currentTool: string | null;
  activityState: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt: number | null;
  elapsedMs: number | null;
  error: string | null;
  recentTools: Array<{ tool: string; target: string; at: number | null }>;
  recentOutput: string[];
  dependsOn: string[];
  resultPath: string | null;
  hasAgentStatus: boolean;
}

interface ApiRun {
  runId: string;
  team: string;
  workflow: string | null;
  status: string;
  rawStatus: string;
  live: boolean;
  goal: string | null;
  summary: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  stateRoot: string;
  artifactsRoot: string | null;
  tasks: ApiTask[];
  counts: Record<string, number>;
  artifacts: Array<{ name: string; path: string; sizeBytes?: number }>;
}

const MAX_RENDERED_TOOLS = 10;

function statusClass(status: string): string {
  const value = (status || "").toLowerCase();
  if (value.includes("run") || value.includes("active")) {
    return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30";
  }
  if (value.includes("complet") || value.includes("success")) {
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  }
  if (value.includes("fail") || value.includes("error") || value.includes("stale")) {
    return "bg-rose-500/15 text-rose-400 border-rose-500/30";
  }
  return "bg-slate-500/15 text-slate-400 border-slate-500/30";
}

function clockTime(ms: number | null): string {
  if (ms === null) return "—";
  try {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  } catch {
    return "—";
  }
}

/** Short model label: "provider/model" kept whole, long names still fit a chip. */
function modelLabel(model: string | null, status: string): string {
  if (model) return model;
  if (status === "queued" || status === "waiting") return "not dispatched yet";
  return "model unknown";
}

export function TaskRow({ task, now }: { task: ApiTask; now: number }) {
  const running = task.status === "running";
  const liveElapsed =
    running && task.startedAt !== null ? Math.max(0, now - task.startedAt) : task.elapsedMs;
  const fallback = task.model.drift;
  return (
    <li className="border border-border rounded bg-bg-panel/60 p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[11px] text-text">{task.id}</span>
        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded border font-bold tracking-wide text-text-muted bg-bg-subtle border-border">
          {task.role}
        </span>
        <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border font-bold tracking-wide ${statusClass(task.status)}`}>
          {task.status}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] font-mono text-text-dim">
          {task.toolUses !== null && <span data-testid="task-tools">{task.toolUses} tools</span>}
          {liveElapsed !== null && (
            <span className="tabular-nums" data-testid="task-elapsed">
              {formatElapsed(liveElapsed)}
            </span>
          )}
          {task.model.attempts > 0 && (
            <span data-testid="task-attempts">
              attempt {task.model.usedAttempt ?? task.model.attempts}/{task.model.attempts}
            </span>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
        <span
          className={`rounded px-1.5 py-0.5 border ${
            task.model.model ? "bg-bg-subtle text-text border-border" : "bg-bg-subtle text-text-dim border-border"
          }`}
          data-testid="task-model"
          title={task.model.model ?? "no model recorded yet"}
        >
          {modelLabel(task.model.model, task.status)}
        </span>
        {fallback && (
          <span
            className="rounded px-1.5 py-0.5 border bg-amber-500/15 text-amber-500 border-amber-500/40 font-bold"
            data-testid="task-model-fallback"
            title={task.model.fallbackReason ?? "requested model differs from the resolved model"}
          >
            ⚠ {task.model.requested} → {task.model.resolved}
          </span>
        )}
        {!fallback && task.model.requested && task.model.resolved === null && running && (
          <span className="text-text-dim" data-testid="task-model-pending">
            requested {task.model.requested} · pending
          </span>
        )}
        <span className="text-text-dim truncate" title={task.title}>
          {task.title.length > 90 ? `${task.title.slice(0, 89)}…` : task.title}
        </span>
      </div>

      {task.error && (
        <div className="text-[11px] text-rose-400 font-mono whitespace-pre-wrap break-words" data-testid="task-error">
          ✖ {task.error}
        </div>
      )}

      {fallback && task.model.fallbackReason && !task.error && (
        <div className="text-[11px] text-amber-500/90 font-mono whitespace-pre-wrap break-words" data-testid="task-fallback-reason">
          ⚠ {task.model.fallbackReason}
        </div>
      )}

      {running && task.currentTool && (
        <div className="text-[11px] text-accent font-mono flex items-center gap-1.5" data-testid="task-current-tool">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          running: {task.currentTool}
          {task.recentTools[0]?.at === null && task.recentTools[0]?.target ? ` — ${task.recentTools[0].target}` : ""}
        </div>
      )}

      {task.recentTools.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="text-[9px] uppercase tracking-wide text-text-dim">
            recent activity ({task.recentTools.length})
          </div>
          <ul className="font-mono text-[10px] text-text-muted leading-tight" data-testid="task-recent-tools">
            {task.recentTools.slice(0, MAX_RENDERED_TOOLS).map((tool, index) => (
              <li key={`${tool.tool}-${index}`} className="truncate">
                <span className="text-text-dim">{clockTime(tool.at)}</span>{" "}
                <span className="text-text">{tool.tool}</span>
                {tool.target ? <span className="text-text-dim"> · {tool.target}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.recentOutput.length > 0 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-text-dim uppercase tracking-wide text-[9px]">output tail</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg border border-border p-1.5 text-text-muted whitespace-pre-wrap break-words">
            {task.recentOutput.join("\n")}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Run-level header: identity, status, progress, goal, load error. Pure. */
export function RunDetailHeader({
  run,
  error,
  now,
  runId,
}: {
  run: ApiRun | null;
  error: string | null;
  now: number;
  runId: string;
}) {
  const counts = run?.counts ?? {};
  const total = run?.tasks.length ?? 0;
  const elapsed = run?.createdAt != null ? (run.live ? now : run.updatedAt ?? now) - run.createdAt : null;

  return (
    <header className="border border-border rounded bg-bg-panel/60 p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-sm font-semibold text-text" data-testid="run-team">
          {run?.team ?? "Run"} <span className="text-text-dim font-normal">· {run?.workflow ?? "no workflow"}</span>
        </h1>
        <span
          className={`text-[10px] uppercase px-1.5 py-0.5 rounded border font-bold tracking-wide ${statusClass(run?.status ?? "unknown")}`}
          data-testid="run-status"
        >
          {run?.status ?? (error ? "error" : "loading")}
        </span>
        <span className="ml-auto text-[10px] font-mono text-text-dim" data-testid="run-id">
          {runId}
        </span>
      </div>

      <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono text-text-muted">
        <span data-testid="run-progress">
          {counts.completed ?? 0}/{total} done
          {counts.running ? ` · ${counts.running} running` : ""}
          {counts.queued || counts.waiting ? ` · ${(counts.queued ?? 0) + (counts.waiting ?? 0)} queued` : ""}
          {counts.failed ? ` · ${counts.failed} failed` : ""}
        </span>
        {elapsed !== null && elapsed >= 0 && (
          <span data-testid="run-elapsed">elapsed {formatElapsed(elapsed)}</span>
        )}
        <span>started {clockTime(run?.createdAt ?? null)}</span>
      </div>

      {run?.goal && (
        <p className="text-[11px] text-text-muted whitespace-pre-wrap break-words" data-testid="run-goal">
          {run.goal.length > 600 ? `${run.goal.slice(0, 599)}…` : run.goal}
        </p>
      )}
      {run?.summary && (
        <p className="text-[11px] text-text-dim whitespace-pre-wrap break-words">{run.summary}</p>
      )}
      {error && (
        <p className="text-[11px] text-rose-400 font-mono" data-testid="run-error">
          Unable to load run: {error}
        </p>
      )}
    </header>
  );
}

export function AgentRunDetailView({ runId }: { runId: string }) {
  const [run, setRun] = useState<ApiRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const fetchRun = async () => {
      try {
        const res = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 404 ? "run not found" : `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as ApiRun;
        if (cancelled) return;
        setRun(data);
        setError(null);
        setNow(Date.now());
      } catch (fetchError) {
        if (!cancelled) setError(String(fetchError));
      }
    };
    fetchRun();
    const interval = setInterval(fetchRun, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId]);

  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-5xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <a href="/" className="text-accent text-xs hover:underline">
            ← Back to chat
          </a>
          <span className="ml-auto text-[10px] text-text-dim font-mono">
            auto-refresh 4s · updated {clockTime(run?.updatedAt ?? null)}
          </span>
        </div>

        <RunDetailHeader run={run} error={error} now={now} runId={runId} />

        {run && run.tasks.length === 0 && (
          <div className="text-xs text-text-dim italic">This run has no tasks recorded yet.</div>
        )}

        <ul className="flex flex-col gap-2" data-testid="run-tasks">
          {(run?.tasks ?? []).map((task) => (
            <TaskRow key={task.id} task={task} now={now} />
          ))}
        </ul>

        {run && run.artifacts.length > 0 && (
          <section className="border border-border rounded bg-bg-panel/60 p-2.5">
            <div className="text-[9px] uppercase tracking-wide text-text-dim mb-1">artifacts</div>
            <ul className="font-mono text-[10px] text-text-muted flex flex-col gap-0.5">
              {run.artifacts.map((artifact) => (
                <li key={artifact.path} className="truncate" title={artifact.path}>
                  {artifact.name}
                  {artifact.sizeBytes !== undefined ? (
                    <span className="text-text-dim"> · {Math.max(1, Math.round(artifact.sizeBytes / 1024))}KB</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}

        {run && (
          <div className="text-[10px] font-mono text-text-dim break-all">
            state: {run.stateRoot}
            {run.artifactsRoot ? ` · artifacts: ${run.artifactsRoot}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
