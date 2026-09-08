import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { createAdminDeploymentRun } from "@/lib/genesys/admin-console-store.mjs";
import { prepareAdminTtsDestroy } from "@/lib/genesys/admin-deployment-runner.mjs";

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    const prepared = await prepareAdminTtsDestroy(body);
    if (prepared.installerPlan.organization.id !== auth.actor.organizationId) {
      return NextResponse.json({ error: "Genesys organization mismatch" }, { status: 403 });
    }
    const run = await createAdminDeploymentRun({
      actor: auth.actor,
      component: "tts",
      config: prepared.config,
      plan: {
        operation: "destroy",
        installerPlanId: prepared.installerPlan.planId,
        createdAt: prepared.installerPlan.createdAt,
        summary: prepared.summary,
        installerPlan: prepared.installerPlan,
      },
      steps: prepared.steps,
      installerPlanPath: null,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
