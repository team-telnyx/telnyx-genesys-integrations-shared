import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  ADMIN_HANDOFF_POLICY_CONTEXTS,
  listAdminHandoffPolicies,
  saveAdminHandoffPolicies,
} from "@/lib/genesys/admin-desired-state.mjs";
import { getAdminInventoryCache } from "@/lib/genesys/admin-console-store.mjs";

const policySchema = z.object({
  context: z.enum(ADMIN_HANDOFF_POLICY_CONTEXTS),
  queueIds: z.array(z.string().trim().min(1)).max(500),
  defaultQueueId: z.string().trim(),
}).strict();

const updateSchema = z.object({
  policies: z.array(policySchema).min(1).max(ADMIN_HANDOFF_POLICY_CONTEXTS.length),
}).strict();

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      policies: await listAdminHandoffPolicies(auth.actor.organizationId),
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
    if (!inventory?.queues?.length) {
      return NextResponse.json({ error: "Refresh the Genesys inventory before saving queue policies" }, { status: 409 });
    }
    const result = await saveAdminHandoffPolicies({
      actor: auth.actor,
      policies: input.policies,
      availableQueues: inventory.queues,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
}
