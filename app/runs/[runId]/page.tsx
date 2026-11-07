import type { Metadata } from "next";

import { AgentRunDetailView } from "@silrod/pi-web-panels/client/run-detail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "pi-crew run",
};

/**
 * A real (linkable) route for one pi-crew run, so the Background Agents panel
 * can link straight to it and the URL can be shared/bookmarked. The data comes
 * from GET /api/agents/runs/[runId] on a 4s poll inside the client view.
 *
 * Auth: `/runs/:path*` is added to the proxy matcher (proxy.ts) — without that
 * entry this page would bypass the PI_WEB_PASSWORD gate entirely.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <AgentRunDetailView runId={runId} />;
}
