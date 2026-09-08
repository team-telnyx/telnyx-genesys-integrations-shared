import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getAdminInventoryCache } from "@/lib/genesys/admin-console-store.mjs";
import {
  getAdminAudioRoutingProfile,
  saveAdminAudioRoutingProfile,
} from "@/lib/genesys/admin-desired-state.mjs";

const takeoverOwnerSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(100),
}).strict();

const updateSchema = z.object({
  routes: z.array(z.object({
    dnis: z.string().trim().min(1).max(40),
    assistantId: z.string().trim().min(1).max(200),
    assistantName: z.string().trim().max(200).optional(),
    takeover: z.boolean().optional(),
    takeoverOwner: takeoverOwnerSchema.optional(),
  }).strict()).min(1).max(500),
}).strict();

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      profile: await getAdminAudioRoutingProfile(auth.actor.organizationId),
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
    if (!inventory?.telnyxAssistants?.length || !inventory?.genesysDids?.length) {
      return NextResponse.json({ error: "Refresh the live inventory before saving Audio DNIS routing" }, { status: 409 });
    }
    const result = await saveAdminAudioRoutingProfile({
      actor: auth.actor,
      profile: input,
      availableAssistants: inventory.telnyxAssistants,
      availableDids: inventory.genesysDids,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error instanceof z.ZodError ? 400 : 400 });
  }
}
