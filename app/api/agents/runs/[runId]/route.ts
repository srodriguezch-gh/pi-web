import { NextResponse } from "next/server";

import { collectRunDetail } from "@silrod/pi-web-panels/server/run-detail";

export const dynamic = "force-dynamic";

/**
 * Read-only detail for ONE pi-crew team run, for app/runs/[runId]/page.tsx.
 *
 * Contract: 200 -> RunDetail (see lib/agent-run-detail.ts):
 *   { runId, team, workflow, status, live, goal, createdAt, updatedAt,
 *     tasks: [{ id, role, status, model: { model, requested, resolved,
 *               drift, attempts, usedAttempt, fallbackReason, failedAttempts },
 *               toolUses, currentTool, elapsedMs, error, recentTools,
 *               recentOutput, ... }],
 *     counts, artifacts }
 * 404 -> { error: "run not found" } for an unknown or unsafe run id.
 *
 * Never throws: a partially written run degrades to nulls, not a 500.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params;
    const detail = collectRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
}
