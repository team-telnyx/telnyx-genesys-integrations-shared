import { NextResponse } from "next/server";
import { APP_BUILD } from "@/lib/app-version.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/version
 *
 * Public build metadata only — the package version, commit, build identifier,
 * UTC build time, matching release tag, channel and working-tree status. No
 * secrets and no deployment addresses.
 *
 * The handler touches no database, so it keeps answering while /api/health
 * reports degraded. That is not the same as surviving a database outage from
 * cold: server.mjs applies migrations before it serves anything, so a process
 * that cannot reach PostgreSQL never starts at all.
 *
 * `no-store` because the value is fixed for the life of a bundle but changes
 * the moment a new one is deployed; a cached copy would report the version that
 * used to be running.
 */
export async function GET() {
  return NextResponse.json(APP_BUILD || { error: "Version information unavailable" }, {
    status: APP_BUILD ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
