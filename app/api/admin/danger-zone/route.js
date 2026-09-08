import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  buildIntegrationDestroyPlan,
  destroySelectedIntegrationResources,
} from "@/lib/genesys/integration-destroy.mjs";
import { installationResourceNames } from "@/lib/genesys/installation-scope.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const resources = await buildIntegrationDestroyPlan(auth.actor.organizationId);
    return NextResponse.json({
      installationName: installationResourceNames().installationName,
      resources,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    const installationName = installationResourceNames().installationName;
    if (String(body?.confirmation || "").trim() !== installationName) {
      return NextResponse.json({
        error: `Type ${installationName} exactly to confirm deletion`,
      }, { status: 400 });
    }
    if (!Array.isArray(body?.resourceIds) || body.resourceIds.length > 500) {
      return NextResponse.json({ error: "resourceIds must be an array with at most 500 entries" }, { status: 400 });
    }
    const result = await destroySelectedIntegrationResources({
      organizationId: auth.actor.organizationId,
      resourceIds: body.resourceIds,
    });
    return NextResponse.json(result, { status: (result.failed || result.skipped) ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
