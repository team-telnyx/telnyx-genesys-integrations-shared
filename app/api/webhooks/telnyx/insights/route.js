import { NextResponse } from "next/server";

import { recordInsightGroupWebhookEvent } from "@/lib/telnyx/insight-events.mjs";
import {
  TelnyxWebhookConfigurationError,
  TelnyxWebhookPayloadError,
  TelnyxWebhookSignatureError,
  verifyAndParseTelnyxWebhookRequest,
} from "@/lib/telnyx/webhooks.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const { rawBody, event } = await verifyAndParseTelnyxWebhookRequest(request);
    const recorded = await recordInsightGroupWebhookEvent({ rawBody, event });
    if (!recorded.accepted) {
      console.warn("[telnyx-insights-webhook] ignored insight event", {
        eventType: recorded.eventType,
        status: recorded.status,
        reason: recorded.reason,
      });
      return NextResponse.json({ ok: true, ignored: true });
    }
    console.info("[telnyx-insights-webhook] accepted", {
      eventId: recorded.eventId,
      eventType: recorded.eventType,
      status: recorded.status,
      conversationId: recorded.conversationId,
      insightGroupId: recorded.insightGroupId,
      duplicate: recorded.duplicate,
    });
    return NextResponse.json({ ok: true, duplicate: recorded.duplicate });
  } catch (error) {
    if (error instanceof TelnyxWebhookSignatureError) {
      console.warn("[telnyx-insights-webhook] rejected invalid signature");
      return NextResponse.json({ ok: false, error: "Invalid webhook signature" }, { status: 403 });
    }
    if (error instanceof TelnyxWebhookPayloadError) {
      return NextResponse.json({ ok: false, error: "Invalid webhook payload" }, { status: 400 });
    }
    if (error instanceof TelnyxWebhookConfigurationError) {
      console.error("[telnyx-insights-webhook] webhook verification is not configured");
      return NextResponse.json(
        { ok: false, error: "Webhook verification is not configured" },
        { status: 503 }
      );
    }
    console.error("[telnyx-insights-webhook] processing failed", error);
    return NextResponse.json({ ok: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
