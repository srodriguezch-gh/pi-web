import { NextResponse } from "next/server";
import { collectBackgroundAgentsCached, toSidebarEntry } from "@silrod/pi-web-panels/server/background-agents";

export const dynamic = "force-dynamic";

/**
 * Read-only listing of pi-crew background agents (team runs + subagents) for
 * the sidebar's "Background Agents" panel.
 *
 * Contract: 200 -> normalized JSON array of entries:
 *   [{ id, kind: "team"|"subagent", role, title, status,
 *      startedAt, updatedAt, progress, href, runId, taskId, agents }]
 * `startedAt`/`updatedAt` are epoch ms (or null); `status` is normalized to
 * "running" | "completed" | "failed" | "stale" (else the raw value, else
 * "unknown").
 *
 * This is the LIST payload, not the full entry: `goal`, `summary`,
 * `artifactsRoot` and `artifacts` are deliberately omitted (see
 * `toSidebarEntry` in lib/background-agents.ts — they were ~85% of a 121KB
 * poll and no list client reads them). Use `GET /api/agents/runs/[runId]` for
 * the detailed view.
 *
 * Cost: the underlying scan walks every run dir and subagent record (a few
 * thousand synchronous fs calls), so it is memoized for 2s — the panel's own
 * poll is 4s, and concurrent readers share one scan.
 *
 * Never throws: discovery is defensive and a missing pi-crew state simply
 * yields `[]`.
 */
export async function GET() {
  try {
    return NextResponse.json(collectBackgroundAgentsCached().map(toSidebarEntry));
  } catch {
    // Discovery already swallows per-root errors; this is a last-resort guard
    // so the panel degrades to its empty state instead of a 500.
    return NextResponse.json([]);
  }
}
