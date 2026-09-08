import { NextResponse } from "next/server";
import {
  genesysOutboundAgentName,
  genesysOutboundAttachments,
  genesysOutboundRemoteAddress,
  genesysOutboundTypingDuration,
  openMessagingSecret,
  resolveGenesysConversationAgent,
  verifyGenesysOpenMessagingSignature,
} from "@/lib/genesys/widget-open-messaging";
import {
  clearMessagingHandoffAgentTyping,
  claimWidgetWebhookEvent,
  findMessagingHandoffByAddress,
  markMessagingHandoffAgentTyping,
  markMessagingHandoffConnected,
  storeHandoffMessage,
} from "@/lib/widgets/handoffs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { integrationId } = await params;
  let rawBody;
  try {
    rawBody = await request.text();
    const valid = verifyGenesysOpenMessagingSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256"),
      secret: openMessagingSecret(integrationId),
    });
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const body = JSON.parse(rawBody);
    const remoteAddress = genesysOutboundRemoteAddress(body);
    const eventId = String(body?.id || body?.channel?.messageId || "").trim();
    if (!remoteAddress || !eventId) {
      return NextResponse.json({ accepted: true, matched: false }, { status: 202 });
    }
    const handoff = await findMessagingHandoffByAddress({ integrationId, remoteAddress });
    if (!handoff) {
      return NextResponse.json({ accepted: true, matched: false }, { status: 202 });
    }
    const claimed = await claimWidgetWebhookEvent({
      source: `genesys-open:${integrationId}`,
      eventId,
      eventType: body?.type || "unknown",
    });
    if (!claimed) return NextResponse.json({ accepted: true, duplicate: true });

    const typingDuration = genesysOutboundTypingDuration(body);
    if (typingDuration) {
      // A typing event proves the agent has accepted the interaction, but it is
      // intentionally ephemeral and must never become a transcript message.
      await markMessagingHandoffConnected(handoff.id);
      await markMessagingHandoffAgentTyping(handoff.id, typingDuration);
      return NextResponse.json({ accepted: true, typing: true });
    }

    const text = typeof body?.text === "string" ? body.text.slice(0, 16_000) : null;
    const attachments = genesysOutboundAttachments(body);
    const outboundAgentName = genesysOutboundAgentName(body);
    let agent = {
      name: handoff.agent_name || outboundAgentName,
      userId: handoff.agent_user_id || null,
      imageUri: handoff.agent_image_uri || null,
    };
    if ((!agent.userId || !agent.imageUri) && handoff.genesys_conversation_id) {
      try {
        const resolvedAgent = await resolveGenesysConversationAgent({
          conversationId: handoff.genesys_conversation_id,
          fallbackName: outboundAgentName,
        });
        agent = {
          name: resolvedAgent.name || agent.name,
          userId: resolvedAgent.userId || agent.userId,
          imageUri: resolvedAgent.imageUri || agent.imageUri,
        };
      } catch (error) {
        console.warn("[genesys-open-messaging-webhook] agent profile lookup failed", {
          conversationId: handoff.genesys_conversation_id,
          message: error?.message,
        });
      }
    }
    const agentName = agent.name || outboundAgentName;
    if (text || attachments.length) {
      await clearMessagingHandoffAgentTyping(handoff.id);
      await storeHandoffMessage({
        handoffId: handoff.id,
        providerMessageId: eventId,
        direction: "outbound",
        sender: "agent",
        senderName: agentName,
        senderImageUri: agent.imageUri,
        messageType: body?.type || "Text",
        text,
        attachments,
        createdAt: body?.channel?.time ? new Date(body.channel.time) : new Date(),
      });
      await markMessagingHandoffConnected(handoff.id, agentName, {
        agentUserId: agent.userId,
        agentImageUri: agent.imageUri,
      });
    }
    return NextResponse.json({ accepted: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    console.error("[genesys-open-messaging-webhook]", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
