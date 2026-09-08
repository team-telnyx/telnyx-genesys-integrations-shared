import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken, touchWidgetSession } from "@/lib/widgets/sessions";
import {
  listTelnyxConversationMessages,
  sendTelnyxAssistantMessage,
} from "@/lib/telnyx/widget-messaging";
import { sendGenesysCustomerMessage } from "@/lib/genesys/widget-open-messaging";
import {
  getMessagingHandoffBySession,
  serializeMessagingHandoff,
  storeHandoffMessage,
} from "@/lib/widgets/handoffs";

const messageSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    messageId: z.string().uuid().optional(),
  })
  .strict();

async function authorizedSession(request) {
  const session = await getWidgetSessionByToken(bearerToken(request));
  if (!session || session.channel !== "messaging" || !session.telnyx_conversation_id) return null;
  return session;
}

function errorResponse(error) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Message must contain between 1 and 8000 characters" }, { status: 400 });
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error("[widget-messages]", error);
  return NextResponse.json(
    { error: status >= 500 ? "Messaging service is temporarily unavailable" : error.message },
    { status }
  );
}

export async function GET(request) {
  try {
    const session = await authorizedSession(request);
    if (!session) return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
    const messages = await listTelnyxConversationMessages(session.telnyx_conversation_id);
    const expiresAt = await touchWidgetSession(session);
    return NextResponse.json({ messages, expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request) {
  try {
    const session = await authorizedSession(request);
    if (!session) return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
    const { content, messageId = randomUUID() } = messageSchema.parse(await request.json());
    const handoff = await getMessagingHandoffBySession(session.id);
    // Once the agent left, Genesys has torn the interaction down and the customer
    // cannot be routed back to the assistant either: the session is over.
    if (handoff && ["disconnected", "completed"].includes(handoff.status)) {
      return NextResponse.json(
        { error: "This conversation has ended", handoff: serializeMessagingHandoff(handoff) },
        { status: 409 }
      );
    }
    if (handoff && ["reserved", "waiting", "assigned", "connected"].includes(handoff.status)) {
      if (handoff.status === "reserved") {
        return NextResponse.json(
          { error: "Human handoff is being initialized", handoff: serializeMessagingHandoff(handoff) },
          { status: 409 }
        );
      }
      await sendGenesysCustomerMessage({ handoff, messageId, text: content });
      await storeHandoffMessage({
        handoffId: handoff.id,
        providerMessageId: messageId,
        direction: "inbound",
        sender: "customer",
        text: content,
      });
      const expiresAt = await touchWidgetSession(session);
      return NextResponse.json(
        { message: null, handoff: serializeMessagingHandoff(handoff), expiresAt },
        { headers: { "cache-control": "no-store" } }
      );
    }
    const assistantId = session.config.channels.messaging.assistantId;
    if (!assistantId) return NextResponse.json({ error: "Messaging assistant is not configured" }, { status: 503 });

    const message = await sendTelnyxAssistantMessage({
      assistantId,
      conversationId: session.telnyx_conversation_id,
      content,
    });
    const expiresAt = await touchWidgetSession(session);
    return NextResponse.json({ message, expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
