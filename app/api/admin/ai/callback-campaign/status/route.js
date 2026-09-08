import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { loadAdminConsoleGenesysContext } from "@/lib/genesys/admin-console-installer.mjs";
import { getLatestSuccessfulAdminDeploymentResult } from "@/lib/genesys/admin-console-store.mjs";
import {
  normalizeCallbackCampaignStatus,
  setCallbackCampaignEnabled,
} from "@/lib/genesys/callbacks-manager.mjs";

const updateSchema = z.object({ enabled: z.boolean() }).strict();

function campaignResponse(campaign) {
  const status = normalizeCallbackCampaignStatus(campaign?.campaignStatus);
  return {
    id: campaign.id,
    name: campaign.name,
    campaignStatus: status,
    status,
    enabled: status === "on",
  };
}

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;

  try {
    const input = updateSchema.parse(await request.json());
    const deployment = await getLatestSuccessfulAdminDeploymentResult(
      auth.actor.organizationId,
      "callbacks"
    );
    const campaignId = String(deployment?.result?.campaign?.id || "").trim();
    if (!campaignId) {
      return NextResponse.json(
        { error: "Deploy the callback campaign before changing its runtime status" },
        { status: 409 }
      );
    }

    const context = await loadAdminConsoleGenesysContext({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
    });
    if (context.organization.id !== auth.actor.organizationId) {
      return NextResponse.json({ error: "Genesys organization mismatch" }, { status: 403 });
    }

    const campaign = await setCallbackCampaignEnabled(
      context.outboundApi,
      campaignId,
      input.enabled
    );
    return NextResponse.json(
      { campaign: campaignResponse(campaign) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 502;
    return NextResponse.json({ error: error?.message || String(error) }, { status });
  }
}
