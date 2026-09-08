import { NextResponse } from "next/server";

import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminDashboardOverview } from "@/lib/genesys/admin-dashboard.mjs";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      overview: await getAdminDashboardOverview(auth.actor.organizationId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
