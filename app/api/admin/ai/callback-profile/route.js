import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminInventoryCache } from "@/lib/genesys/admin-console-store.mjs";
import {
  getAdminCallbackCampaignProfile,
  saveAdminCallbackCampaignProfile,
} from "@/lib/genesys/admin-desired-state.mjs";

const updateSchema = z.object({
  assistantId: z.string().trim().min(1).max(200),
  callerAddress: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
  callerName: z.string().trim().min(1).max(100),
  siteId: z.string().trim().min(1).max(200),
  wrapupCodeId: z.string().trim().min(1).max(200),
}).strict();

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      profile: await getAdminCallbackCampaignProfile(auth.actor.organizationId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const input = updateSchema.parse(await request.json());
    const inventory = await getAdminInventoryCache(auth.actor.organizationId);
    if (!inventory?.telnyxAssistants?.length || !inventory?.genesysDids?.length ||
        !inventory?.genesysSites?.length || !inventory?.wrapupCodes?.length) {
      return NextResponse.json({ error: "Refresh the live inventory before saving the callback campaign profile" }, { status: 409 });
    }
    const result = await saveAdminCallbackCampaignProfile({
      actor: auth.actor,
      profile: input,
      availableAssistants: inventory.telnyxAssistants,
      availableDids: inventory.genesysDids,
      availableSites: inventory.genesysSites,
      availableWrapupCodes: inventory.wrapupCodes,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error instanceof z.ZodError ? 400 : 400 });
  }
}
