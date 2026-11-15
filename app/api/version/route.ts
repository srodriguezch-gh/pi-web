import { NextResponse } from "next/server";
import { runtimeVersions } from "@/lib/runtime-versions";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(runtimeVersions(), { headers: { "Cache-Control": "no-store" } });
}
