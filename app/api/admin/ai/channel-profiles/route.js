import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminInventoryCache } from "@/lib/genesys/admin-console-store.mjs";
import {
  listAdminWidgetChannelProfiles,
  saveAdminWidgetChannelProfiles,
} from "@/lib/genesys/admin-desired-state.mjs";

const sharedUpdateSchema = z.object({
  genesysTrunkId: z.string().trim().min(1).max(200),
  region: z.enum(["auto", "eu", "us-east", "us-central", "us-west", "ca-central", "apac", "south-asia"]),
  callerNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  keepAssistantOnCall: z.boolean().default(false),
}).strict();

const updateSchema = sharedUpdateSchema;

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      profiles: await listAdminWidgetChannelProfiles(auth.actor.organizationId),
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
    const profiles = [{
      channel: "voice",
      config: {
        genesysTrunkId: input.genesysTrunkId,
        region: input.region,
        callerNumber: input.callerNumber,
        keepAssistantOnCall: input.keepAssistantOnCall,
      },
    }];
    if (!inventory?.genesysSipTrunks?.length) {
      return NextResponse.json({ error: "Refresh the live Genesys trunk inventory before updating Web Calls" }, { status: 409 });
    }
    if (!inventory?.genesysDids?.length) {
      return NextResponse.json({ error: "Refresh the live Genesys number inventory before updating Web Calls" }, { status: 409 });
    }
    const result = await saveAdminWidgetChannelProfiles({
      actor: auth.actor,
      profiles,
      availableAssistants: inventory.telnyxAssistants,
      availableTrunks: inventory.genesysSipTrunks,
      availableDids: inventory.genesysDids,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error instanceof z.ZodError ? 400 : 400 });
  }
}
