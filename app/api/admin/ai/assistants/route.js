import { NextResponse } from "next/server";
import Telnyx from "telnyx";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { ADMIN_ASSISTANT_RECOMMENDED_MODEL } from "@/lib/genesys/admin-assistant-generator.mjs";
import {
  listAdminAssistantCatalog,
  removeAdminAssistantMissingFromProvider,
  registerAdminManagedAssistant,
} from "@/lib/genesys/admin-desired-state.mjs";
import {
  ensureAdminManagedInsightProfile,
  trackAdminAssistantInsightAssignment,
} from "@/lib/genesys/admin-managed-insights.mjs";

const createSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2000),
  instructions: z.string().trim().min(80).max(12_000),
  greeting: z.string().trim().min(1).max(500),
}).strict();

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({
      assistants: await listAdminAssistantCatalog(auth.actor.organizationId),
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
  let createdAssistant = null;
  let telnyx = null;
  try {
    const input = createSchema.parse(await request.json());
    const catalog = await listAdminAssistantCatalog(auth.actor.organizationId);
    if (catalog.some((assistant) => assistant.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) {
      return NextResponse.json({ error: `An AI assistant named ${input.name} already exists` }, { status: 409 });
    }
    telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
    const insightProfile = await ensureAdminManagedInsightProfile({
      telnyx,
      organizationId: auth.actor.organizationId,
    });
    const response = await telnyx.ai.assistants.create({
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      greeting: input.greeting,
      model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
      transcription: { model: "deepgram/flux", language: "en" },
      enabled_features: ["telephony"],
      privacy_settings: { data_retention: true, pii_redaction: "disabled" },
      insight_settings: { insight_group_id: insightProfile.group.id },
      tags: ["genesys", "admin-managed"],
    });
    createdAssistant = response?.data || response;
    const inventoryAssistant = await registerAdminManagedAssistant({
      actor: auth.actor,
      assistant: createdAssistant,
      desiredConfig: {
        ...input,
        model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
        transcription: { model: "deepgram/flux", language: "en" },
        enabledFeatures: ["telephony"],
        managedInsightGroupId: insightProfile.group.id,
        managedPrivacySettings: { dataRetention: true, piiRedaction: "disabled" },
      },
    });
    await trackAdminAssistantInsightAssignment({
      organizationId: auth.actor.organizationId,
      assistantId: createdAssistant.id,
      insightGroupId: insightProfile.group.id,
    });
    const assistants = await listAdminAssistantCatalog(auth.actor.organizationId);
    return NextResponse.json({
      assistant: assistants.find((assistant) => assistant.telnyxAssistantId === createdAssistant.id),
      inventoryAssistant,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (createdAssistant?.id && telnyx) {
      await telnyx.ai.assistants.delete(createdAssistant.id).catch(() => undefined);
      await removeAdminAssistantMissingFromProvider({
        organizationId: auth.actor.organizationId,
        telnyxAssistantId: createdAssistant.id,
      }).catch(() => undefined);
    }
    const status = error instanceof z.ZodError
      ? 400
      : remoteStatus(error) >= 400 && remoteStatus(error) < 500
        ? remoteStatus(error)
        : 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
