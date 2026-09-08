import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  createAdminDeploymentRun,
  saveAdminComponentConfig,
} from "@/lib/genesys/admin-console-store.mjs";
import { prepareAdminDeployment } from "@/lib/genesys/admin-deployment-runner.mjs";
import { resolveAdminComponentDesiredState } from "@/lib/genesys/admin-desired-state.mjs";

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const { component } = await params;
    const body = await request.json();
    const desiredConfig = await resolveAdminComponentDesiredState({
      organizationId: auth.actor.organizationId,
      component,
      config: body.config || {},
    });
    const prepared = await prepareAdminDeployment(component, desiredConfig);
    await saveAdminComponentConfig({
      actor: auth.actor,
      component,
      enabled: true,
      config: prepared.config,
    });
    const run = await createAdminDeploymentRun({
      actor: auth.actor,
      component,
      config: prepared.config,
      plan: {
        operation: prepared.operation || "deploy",
        installerPlanId: prepared.installerPlan.planId,
        createdAt: prepared.installerPlan.createdAt,
        summary: prepared.summary,
        installerPlan: prepared.installerPlan,
      },
      steps: prepared.steps,
      installerPlanPath: prepared.installerPlanPath,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
