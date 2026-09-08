import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminDeploymentRun } from "@/lib/genesys/admin-console-store.mjs";
import { startPreparedAdminDeployment } from "@/lib/genesys/admin-deployment-runner.mjs";

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const run = await getAdminDeploymentRun(id, auth.actor.organizationId);
  if (!run) return NextResponse.json({ error: "Deployment run not found" }, { status: 404 });
  if (run.status !== "planned") {
    return NextResponse.json({ error: `Deployment is already ${run.status}` }, { status: 409 });
  }
  try {
    const started = await startPreparedAdminDeployment(run);
    if (!started) {
      return NextResponse.json(
        { error: "Deployment is already running or is no longer planned" },
        { status: 409 }
      );
    }
    return NextResponse.json({ run: { ...run, status: "running" } }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
}
