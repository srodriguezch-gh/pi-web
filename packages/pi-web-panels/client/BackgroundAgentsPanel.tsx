"use client";

import React, { useEffect, useState } from "react";

/**
 * Sidebar "Background Agents" panel.
 *
 * Reads GET /api/agents/runs on the panel's existing 4s poll (no second loop)
 * and shows, per entry: model in use, a requested→resolved fallback flag, and
 * live progress (tools + elapsed) so a long-running agent is visibly working.
 * Clicking an entry opens /runs/<runId> for the per-task detail view.
 */

interface AgentTask {
  taskId: string;
  role: string;
  status: string;
  model: string | null;
  requested: string | null;
  resolved: string | null;
  drift: boolean;
  toolUses: number | null;
  startedAt: number | null;
  completedAt: number | null;
  currentTool: string | null;
  error: string | null;
}

interface AgentRun {
  id: string;
  kind: "team" | "subagent";
  role: string;
  title: string;
  status: string;
  startedAt: number | null;
  updatedAt: number | null;
  progress: { completed: number; total: number } | null;
  /** Detail route the server already computed for this entry (may be absent on older payloads). */
  href?: string | null;
  /** The owning team run id (a subagent only carries its own record id in `id`). */
  runId?: string | null;
  taskId?: string | null;
  agents?: AgentTask[];
}

/**
 * Where a card drills down to.
 *
 * Only TEAM run ids resolve at `/runs/<id>`; a subagent's own record id 404s
 * ("run not found"), so a subagent card must open the run that owns it — that
 * page renders the subagent's task row. Cards without either id stay plain
 * (non-clickable) rather than linking to a dead route.
 */
export function resolveRunHref(agent: AgentRun): string | null {
  if (typeof agent.href === "string" && agent.href.length > 0) return agent.href;
  const runId = agent.kind === "team" ? agent.id : agent.runId ?? null;
  return runId ? `/runs/${encodeURIComponent(runId)}` : null;
}

/** Elapsed time as a compact, fixed-width-ish label ("41s", "2m 05s", "3h 04m"). */
export function formatElapsed(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface AgentRollup {
  /** Distinct models across the run's agents, in first-seen order. */
  models: string[];
  /** True when any agent had requested != resolved. */
  drift: boolean;
  /** "req → res" pairs for the agents that fell back. */
  driftPairs: string[];
  /** Sum of the agents' tool counts. */
  tools: number | null;
  /** The tool currently executing on the first in-flight agent. */
  currentTool: string | null;
  runningAgents: number;
  totalAgents: number;
}

/** Collapse the per-agent records into the one line the compact panel shows. */
export function rollupAgents(agents: AgentTask[] | undefined): AgentRollup {
  const list = Array.isArray(agents) ? agents : [];
  const models: string[] = [];
  const driftPairs: string[] = [];
  let tools: number | null = null;
  let currentTool: string | null = null;
  let runningAgents = 0;
  for (const agent of list) {
    if (agent.model && !models.includes(agent.model)) models.push(agent.model);
    if (agent.drift) driftPairs.push(`${agent.requested} → ${agent.resolved}`);
    if (typeof agent.toolUses === "number") tools = (tools ?? 0) + agent.toolUses;
    if (agent.status === "running") {
      runningAgents += 1;
      if (!currentTool && agent.currentTool) currentTool = agent.currentTool;
    }
  }
  return { models, drift: driftPairs.length > 0, driftPairs, tools, currentTool, runningAgents, totalAgents: list.length };
}

const META_CLASS = "text-text-dim font-mono text-[10px] truncate";
const CHIP_CLASS = "rounded px-1 py-0.5 text-[9px] font-mono";

/** One card of the list. Pure so it can be rendered/tested without the poll. */
export function AgentRunCard({
  agent,
  now,
  href,
}: {
  agent: AgentRun;
  now: number;
  href: string | null;
}) {
  const rollup = rollupAgents(agent.agents);
  const running = agent.status === "running";
  const startedAt = typeof agent.startedAt === "number" ? agent.startedAt : null;
  const endAt = running ? now : agent.updatedAt;
  const elapsed = startedAt !== null && endAt !== null ? endAt - startedAt : null;
  const modelLabel =
    rollup.models.length === 0
      ? null
      : rollup.models.length === 1
        ? rollup.models[0]
        : `${rollup.models.length} models`;

  const body = (
    <>
      <div className="flex items-center justify-between font-medium">
        <span className="text-accent font-mono text-[11px] flex items-center gap-1 min-w-0">
          <span>{getFriendlyIdentity(agent.role).emoji}</span>
          <span className="truncate">{getFriendlyIdentity(agent.role).name}</span>
        </span>
        <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded font-bold tracking-wide ${getStatusBadgeClass(agent.status)}`}>
          {agent.status}
        </span>
      </div>
      <div className="text-text text-[11px] leading-snug line-clamp-2" title={agent.title}>
        {cleanTitle(agent.title)}
      </div>
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        {modelLabel && (
          <span
            className={`${CHIP_CLASS} bg-bg-panel text-text-muted border border-border`}
            title={rollup.models.join("\n")}
            data-testid="agent-model"
          >
            {modelLabel}
          </span>
        )}
        {rollup.drift && (
          <span
            className={`${CHIP_CLASS} bg-amber-500/15 text-amber-500 border border-amber-500/40`}
            title={`Model fallback:\n${rollup.driftPairs.join("\n")}`}
            data-testid="agent-model-drift"
          >
            ⚠ {rollup.driftPairs[0]}
          </span>
        )}
        {rollup.tools !== null && <span className={META_CLASS}>{rollup.tools} tools</span>}
        {elapsed !== null && (
          <span className={`${META_CLASS} tabular-nums`} data-testid="agent-elapsed">
            {formatElapsed(elapsed)}
          </span>
        )}
        {running && rollup.currentTool && <span className={META_CLASS}>now: {rollup.currentTool}</span>}
        {running && rollup.runningAgents > 0 && (
          <span className={META_CLASS}>
            {rollup.runningAgents}/{rollup.totalAgents} active
          </span>
        )}
      </div>
    </>
  );

  const cardClass = "block bg-bg-panel/60 border border-border/40 rounded p-2 flex flex-col gap-1 shadow-sm";
  if (!href) {
    return <div className={cardClass}>{body}</div>;
  }
  return (
    <a
      href={href}
      className={`${cardClass} hover:border-accent/50 hover:bg-bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
      title="Open run detail"
    >
      {body}
    </a>
  );
}

export function BackgroundAgentsPanel() {
  const [agents, setAgents] = useState<AgentRun[]>([]);
  // Badge counts only live (running) agents. The list itself also shows recent
  // completed/failed runs and is capped for display, so agents.length would
  // peg at the cap (15) and never reflect finished work.
  const [runningCount, setRunningCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  // Refreshed on the poll tick so elapsed time advances without a second timer.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch("/api/agents/runs");
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            const seenIds = new Set<string>();
            const unique = data.filter((item) => {
              if (seenIds.has(item.id)) return false;
              seenIds.add(item.id);
              return true;
            });

            // Filter out generic team wrappers if specific subagents exist
            const hasSubagents = unique.some((item) => item.kind === "subagent" || (item.role && item.role !== "team"));
            const filtered = unique.filter((item) => {
              if (hasSubagents && item.role === "team") return false;
              return true;
            });

            setRunningCount(filtered.filter((item) => item.status === "running").length);
            setAgents(filtered.slice(0, 15));
            setNow(Date.now());
          }
        }
      } catch {
        setAgents([]);
        setRunningCount(0);
      }
    };

    fetchAgents();
    const interval = setInterval(fetchAgents, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="border-b border-border/40 py-2 px-3 text-xs">
      <div 
        className="flex items-center justify-between cursor-pointer font-semibold text-text-muted hover:text-text mb-1"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-1.5">
          <span>⚡ Background Agents</span>
          {runningCount > 0 && (
            <span
              className="bg-accent/20 text-accent px-1.5 py-0.2 rounded-full text-[10px]"
              title={`${runningCount} running`}
            >
              {runningCount}
            </span>
          )}
        </div>
        <span>{collapsed ? "▶" : "▼"}</span>
      </div>

      {!collapsed && (
        <div className="space-y-1.5 mt-2 max-h-56 overflow-y-auto pr-1">
          {agents.length === 0 ? (
            <div className="text-text-dim italic text-[11px] py-1">No active background agents</div>
          ) : (
            agents.map((agent) => (
              <AgentRunCard
                key={agent.id}
                agent={agent}
                now={now}
                href={resolveRunHref(agent)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function getStatusBadgeClass(status: string) {
  const s = (status || "").toLowerCase();
  if (s.includes("run") || s.includes("active") || s.includes("progress")) {
    return "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 animate-pulse";
  }
  if (s.includes("complet") || s.includes("success") || s.includes("pass")) {
    return "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
  }
  if (s.includes("fail") || s.includes("error") || s.includes("stale") || s.includes("dead")) {
    return "bg-rose-500/20 text-rose-400 border border-rose-500/30";
  }
  return "bg-slate-500/20 text-slate-400 border border-slate-500/30";
}

function getFriendlyIdentity(rawRole: string) {
  if (!rawRole) return { name: "Agent Task", emoji: "⚡" };
  const clean = rawRole.toLowerCase().replace(/^(direct-|team-|crew-)/, "").trim();

  const mapping: Record<string, { name: string; emoji: string }> = {
    cos: { name: "Traka", emoji: "🐈‍⬛" },
    cfo: { name: "Minty", emoji: "💰" },
    cto: { name: "Sprocket", emoji: "🛠️" },
    cio: { name: "Cora", emoji: "⚙️" },
    coo: { name: "Scribe", emoji: "📋" },
    cro: { name: "Argus", emoji: "🛡️" },
    cmo: { name: "Muse", emoji: "🎨" },
    aura: { name: "Aura", emoji: "👁️" },
    designer: { name: "Aura", emoji: "👁️" },
    executor: { name: "Forge", emoji: "⚡" },
    verifier: { name: "Sentinel", emoji: "⚖️" },
    explorer: { name: "Pip", emoji: "🦊" },
    scout: { name: "Pip", emoji: "🦊" },
    researcher: { name: "Pip", emoji: "🦊" },
    reviewer: { name: "Ollie", emoji: "🦉" },
    "security-reviewer": { name: "Ollie", emoji: "🦉" },
    writer: { name: "Quill", emoji: "📝" },
    assistant: { name: "Juno", emoji: "🌟" },
    sysadmin: { name: "Sprocket", emoji: "🤖" },
    dbadmin: { name: "Sprocket", emoji: "💾" },
    netadmin: { name: "Sprocket", emoji: "🌐" },
    planner: { name: "Scribe", emoji: "📋" },
    analyst: { name: "Minty", emoji: "📊" },
    critic: { name: "Argus", emoji: "🛡️" }
  };

  if (mapping[clean]) {
    return mapping[clean];
  }

  // Capitalize fallback slug nicely
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  return { name: capitalized, emoji: "🤖" };
}

function cleanTitle(raw: string) {
  if (!raw) return "Agent Task";
  const firstLine = raw.split("\n")[0].trim();
  if (firstLine.length > 55) {
    return firstLine.substring(0, 52) + "...";
  }
  return firstLine;
}
