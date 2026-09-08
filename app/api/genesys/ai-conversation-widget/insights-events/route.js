import {
  authorizeGenesysAiConversationWidget,
  GenesysWidgetAccessError,
} from "@/lib/genesys/ai-conversation-widget";
import { NextResponse } from "next/server";
import {
  clearGenesysAccessTokenCookie,
  readGenesysAuthCookie,
} from "@/lib/genesys/auth-cookies.mjs";
import { latestInsightGroupWebhookEvent } from "@/lib/telnyx/insight-events.mjs";
import { subscribeToInsightNotifications } from "@/lib/telnyx/insight-notification-hub.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodedEvent(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  try {
    const { telnyxConversationId } = await authorizeGenesysAiConversationWidget({
      conversationId,
      accessToken: readGenesysAuthCookie(request.cookies, "genesys_access_token"),
    });
    let heartbeat = null;
    let released = false;
    let abortHandler = null;
    let streamController = null;
    let pendingNotification = null;
    const unsubscribe = await subscribeToInsightNotifications((event) => {
      if (event.conversationId !== telnyxConversationId) return;
      if (streamController) {
        streamController(event);
      } else {
        pendingNotification = event;
      }
    });
    const release = () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
      unsubscribe();
    };

    const stream = new ReadableStream({
      start(controller) {
        let readySent = false;
        const sendReady = (event) => {
          if (released || readySent) return;
          readySent = true;
          controller.enqueue(
            encodedEvent("insights-ready", {
              conversationId: telnyxConversationId,
              insightGroupId: event?.insight_group_id || event?.insightGroupId || null,
              receivedAt: event?.received_at || event?.receivedAt || new Date().toISOString(),
            })
          );
        };
        streamController = sendReady;
        abortHandler = () => release();
        request.signal.addEventListener("abort", abortHandler, { once: true });
        controller.enqueue(encodedEvent("connected", { conversationId: telnyxConversationId }));
        if (pendingNotification) sendReady(pendingNotification);
        heartbeat = setInterval(() => {
          if (!released) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
        void latestInsightGroupWebhookEvent(telnyxConversationId)
          .then((event) => {
            if (event) sendReady(event);
          })
          .catch((error) => {
            if (released) return;
            console.error("[insights-events] durable marker lookup failed", error);
            release();
            controller.error(error);
          });
      },
      cancel() {
        release();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const status = error instanceof GenesysWidgetAccessError ? error.status : 500;
    const response = NextResponse.json(
      { ok: false, error: error?.message || "Could not subscribe to insight events" },
      { status, headers: { "Cache-Control": "no-store" } }
    );
    return status === 401 ? clearGenesysAccessTokenCookie(response) : response;
  }
}
