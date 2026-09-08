import { NextResponse } from "next/server";
import { z } from "zod";
import { getPublishedWidget } from "@/lib/widgets/store";
import { evaluateWidgetDecisions } from "@/lib/widgets/decisions";
import { interpolateDynamicVariables, widgetDynamicVariables } from "@/lib/widgets/dynamic-variables";
import {
  activateMessagingSession,
  activateVoiceSession,
  createWidgetSession,
  failWidgetSession,
  getWidgetSessionByToken,
  touchWidgetSession,
} from "@/lib/widgets/sessions";
import { bearerToken, verifyWidgetBootstrapToken } from "@/lib/widgets/session-tokens";
import { getMessagingHandoffBySession } from "@/lib/widgets/handoffs";
import {
  addTelnyxWidgetHandoffContext,
  createTelnyxWidgetConversation,
  getTelnyxAssistantGreeting,
  listTelnyxConversationMessages,
} from "@/lib/telnyx/widget-messaging";
import { refreshGenesysWidgetVoiceSubscriptions } from "@/lib/genesys/widget-voice-notifications.mjs";

const requestSchema = z
  .object({
    channel: z.enum(["messaging", "voice"]),
    sessionToken: z.string().startsWith("wss_").max(100).optional(),
    context: z.record(
      z.string().max(120),
      z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])
    ).refine((value) => Object.keys(value).length <= 100, "Too many context values").optional(),
  })
  .strict();

// The opening line belongs to the AI assistant, so it comes from its Telnyx
// greeting; the widget copy is only the fallback when no greeting is configured.
async function messagingGreeting(widget, dynamicVariables = {}) {
  try {
    const greeting = await getTelnyxAssistantGreeting(widget.config.channels.messaging.assistantId);
    if (greeting) return interpolateDynamicVariables(greeting, dynamicVariables);
  } catch (error) {
    console.error("[widget-session] Unable to read the assistant greeting:", error.message);
  }
  return widget.config.content.welcomeMessage;
}

function errorResponse(error) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid session request" }, { status: 400 });
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error("[widget-session]", error);
  return NextResponse.json(
    { error: status >= 500 ? "Unable to start the chat session" : error.message },
    { status }
  );
}

export async function POST(request, { params }) {
  let createdSession;
  try {
    const { publicId } = await params;
    const claims = verifyWidgetBootstrapToken(bearerToken(request), { publicId });
    const input = requestSchema.parse(await request.json());
    const storedWidget = await getPublishedWidget(publicId);
    if (!storedWidget || storedWidget.revision_id !== claims.rid) {
      return NextResponse.json({ error: "Widget configuration has changed" }, { status: 409 });
    }
    const decision = evaluateWidgetDecisions(storedWidget.config, input.context || {});
    if (!decision.visible) {
      return NextResponse.json({ error: "This widget is unavailable in the current context" }, { status: 403 });
    }
    const widget = { ...storedWidget, config: decision.config };
    if (!widget.config.channels[input.channel]?.enabled) {
      return NextResponse.json({ error: "This channel is disabled" }, { status: 403 });
    }

    if (input.channel === "messaging" && input.sessionToken) {
      const existing = await getWidgetSessionByToken(input.sessionToken);
      const matchesRequest = Boolean(
        existing &&
        existing.public_id === publicId &&
        existing.revision_id === claims.rid &&
        existing.origin === claims.org &&
        existing.channel === input.channel &&
        existing.telnyx_conversation_id
      );
      const existingHandoff = matchesRequest
        ? await getMessagingHandoffBySession(existing.id)
        : null;
      const conversationEnded = ["disconnected", "completed"].includes(existingHandoff?.status);
      if (matchesRequest && !conversationEnded) {
        const [messages, expiresAt, greeting] = await Promise.all([
          listTelnyxConversationMessages(existing.telnyx_conversation_id),
          touchWidgetSession(existing),
          messagingGreeting(widget, widgetDynamicVariables(input.context || {})),
        ]);
        return NextResponse.json(
          {
            sessionToken: input.sessionToken,
            session: {
              id: existing.id,
              channel: existing.channel,
              status: existing.status,
              expiresAt,
            },
            greeting,
            messages,
          },
          { headers: { "cache-control": "no-store" } }
        );
      }
    }

    createdSession = await createWidgetSession({ widget, channel: input.channel, origin: claims.org });
    if (input.channel === "voice") {
      const session = await activateVoiceSession(createdSession.id);
      void refreshGenesysWidgetVoiceSubscriptions().catch((error) => {
        console.warn("[widget-session] Unable to refresh Genesys voice topics:", error.message);
      });
      return NextResponse.json(
        {
          sessionToken: createdSession.sessionToken,
          session: {
            id: session.id,
            channel: session.channel,
            status: session.status,
            expiresAt: session.expires_at,
          },
        },
        { status: 201, headers: { "cache-control": "no-store" } }
      );
    }

    const telnyxConversationId = await createTelnyxWidgetConversation({
      widget,
      sessionId: createdSession.id,
      origin: claims.org,
      dynamicVariables: widgetDynamicVariables(input.context || {}),
    });
    await addTelnyxWidgetHandoffContext({
      conversationId: telnyxConversationId,
      sessionId: createdSession.id,
    });
    const session = await activateMessagingSession(createdSession.id, telnyxConversationId);
    return NextResponse.json(
      {
        sessionToken: createdSession.sessionToken,
        session: {
          id: session.id,
          channel: session.channel,
          status: session.status,
          expiresAt: session.expires_at,
        },
        greeting: await messagingGreeting(widget, widgetDynamicVariables(input.context || {})),
        messages: [],
      },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (createdSession?.id) await failWidgetSession(createdSession.id).catch(() => undefined);
    if (/bootstrap token/i.test(String(error?.message || ""))) {
      return NextResponse.json({ error: "Invalid or expired widget session request" }, { status: 401 });
    }
    return errorResponse(error);
  }
}
