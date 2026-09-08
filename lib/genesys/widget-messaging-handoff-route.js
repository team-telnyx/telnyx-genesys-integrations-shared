import { NextResponse } from "next/server";
import { z } from "zod";
import {
  activateMessagingHandoff,
  failMessagingHandoff,
  reserveMessagingHandoff,
  serializeMessagingHandoff,
} from "@/lib/widgets/handoffs";
import {
  startGenesysMessagingHandoff,
  validateGenesysHandoffQueue,
} from "@/lib/genesys/widget-open-messaging";
import { disableTelnyxConversationAi } from "@/lib/telnyx/widget-messaging";
import { authorizeGenesysHandoffRequest } from "./handoff-auth.js";

const inputSchema = z
  .object({
    telnyx_conversation_channel: z.string().trim().optional(),
    channel: z.string().trim().optional(),
    widget_session_id: z.string().uuid(),
    queue_id: z.string().trim().min(1).max(200).optional(),
    queue_name: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(4000),
    intent: z.string().trim().max(200).optional().default(""),
    sentiment: z
      .enum(["positive", "neutral", "negative", "mixed", "unknown"])
      .optional()
      .default("unknown"),
  })
  .strict();

export async function processGenesysMessagingHandoff(inputValue) {
  let reserved;
  try {
    const input = inputSchema.parse(inputValue);
    reserved = await reserveMessagingHandoff({
      sessionId: input.widget_session_id,
      queueId: input.queue_id,
      queueName: input.queue_name,
      reason: input.reason,
      summary: input.summary,
      intent: input.intent,
      sentiment: input.sentiment,
    });
    if (["waiting", "assigned", "connected", "completed"].includes(reserved.handoff.status)) {
      return NextResponse.json({ ok: true, handoff: serializeMessagingHandoff(reserved.handoff) });
    }

    const queue = await validateGenesysHandoffQueue({
      queueId: reserved.handoff.queue_id,
      queueName: reserved.handoff.queue_name,
    });
    const { conversationId } = await startGenesysMessagingHandoff({
      handoff: {
        ...reserved.handoff,
        queue_name: queue.name,
        telnyx_conversation_id: reserved.session.telnyx_conversation_id,
      },
    });
    const handoff = await activateMessagingHandoff({
      handoffId: reserved.handoff.id,
      genesysConversationId: conversationId,
      queueName: queue.name,
    });
    await disableTelnyxConversationAi(reserved.session.telnyx_conversation_id).catch((error) => {
      console.error("[widget-handoff] Could not disable Telnyx AI after handoff:", error);
    });
    return NextResponse.json({ ok: true, handoff: serializeMessagingHandoff(handoff) });
  } catch (error) {
    if (reserved?.handoff?.id) {
      await failMessagingHandoff(reserved.handoff.id, error.message).catch(() => undefined);
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "Invalid handoff request" }, { status: 400 });
    }
    console.error("[widget-handoff]", error);
    return NextResponse.json(
      { ok: false, error: "Could not start Genesys messaging handoff" },
      { status: 502 }
    );
  }
}

export async function handleGenesysMessagingHandoffRequest(request) {
  const auth = authorizeGenesysHandoffRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  try {
    return processGenesysMessagingHandoff(await request.json());
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid handoff request" }, { status: 400 });
  }
}
