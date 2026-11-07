import { NextResponse } from "next/server";

import { getDecisionsPanel } from "@silrod/pi-web-panels/server/panel-sources/decisions";
import { describeError } from "@silrod/pi-web-panels/server/panel-sources/cache";

/** Cache TTL of the underlying panel source; the UI polls slower than this. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Honest panel" endpoint: the payload's `source`, `ok`, `error`,
 * `fetchedAt`, `cacheAgeMs`, `stale`, `count` and `items` fields are the
 * contract; each panel adds source-specific metadata on top.
 *
 * Always answers 200 — even when the data source is down — so the client can
 * render "UNAVAILABLE: <exact error>" instead of an unexplained fetch failure.
 * A failure is never reported as an empty-but-fine list.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const envelope = await getDecisionsPanel();
    return NextResponse.json(envelope, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // getXPanel() already maps source failures to ok:false; this is the
    // last-resort guard so a route can never 500 because of a data source.
    return NextResponse.json(
      {
        source: "decisions",
        ok: false,
        error: describeError(error),
        fetchedAt: new Date().toISOString(),
        cacheAgeMs: 0,
        stale: false,
        count: 0,
        items: [],
        lastGoodAt: null,
        lastGoodCount: null,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
