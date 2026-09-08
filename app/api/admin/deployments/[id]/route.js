import { NextResponse } from "next/server";

import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminDeploymentRun } from "@/lib/genesys/admin-console-store.mjs";

export async function GET(request, { params }) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const run = await getAdminDeploymentRun(id, auth.actor.organizationId);
  if (!run) return NextResponse.json({ error: "Deployment run not found" }, { status: 404 });
  return NextResponse.json({ run });
}
