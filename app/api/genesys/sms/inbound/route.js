import { NextResponse } from "next/server";
import { getConversationsApi, getOutboundApi } from "@/lib/genesys/client";
import {
  TelnyxWebhookConfigurationError,
  TelnyxWebhookPayloadError,
  TelnyxWebhookSignatureError,
  verifyAndParseTelnyxWebhookRequest,
} from "@/lib/telnyx/webhooks.mjs";

/**
 * POST /api/genesys/sms/inbound
 * Webhook handler for Telnyx inbound messages
 * Sends messages to Genesys Cloud Open Messaging
 */
export async function POST(request) {
  try {
    const { event: body } = await verifyAndParseTelnyxWebhookRequest(request);
    const { payload, event_type } = body.data || body;

    console.log("📨 Telnyx webhook received:", event_type);

    if (event_type === "message.received") {
      // Handle inbound SMS - forward to Genesys Cloud
      const conversationsApi = await getConversationsApi();

      const currentTime = new Date();
      const openMessageBody = {
        id: payload.id,
        channel: {
          type: "Private",
          messageId: payload.id,
          to: {
            id: process.env.GC_MESSAGE_DEPLOYMENT_ID,
          },
          from: {
            id: payload.from.phone_number,
            idType: "Phone",
          },
          time: currentTime.toISOString(),
          metadata: {
            customAttributes: {
              telnyxMessageId: payload.id,
              telnyxFrom: payload.from.phone_number,
            },
          },
        },
        type: "Text",
        text: payload.text,
        status: "Sent",
        isFinalReceipt: true,
        direction: "Inbound",
      };

      const response =
        await conversationsApi.postConversationsMessagesInboundOpen(
          openMessageBody
        );

      console.log("✓ Message forwarded to Genesys Cloud:", response.id);

      return NextResponse.json({ success: true, messageId: response.id });
    } else if (
      event_type === "message.sent" ||
      event_type === "message.finalized"
    ) {
      // Handle delivery status updates
      const tags = payload.tags || [];

      // If message has campaign tracking (3 tags: number, listId, contactId)
      if (tags.length === 3) {
        const [, listId, contactId] = tags;
        const outboundApi = await getOutboundApi();

        // Get contact from GC
        const contacts =
          await outboundApi.postOutboundContactlistContactsBulk(listId, [
            contactId,
          ]);

        if (contacts && contacts[0]) {
          // Update contact with delivery status
          const data = contacts[0].data;
          data.TELNYX_STATUS = payload.to?.[0]?.status || "unknown";
          data.TELNYX_TIME = payload.completed_at || payload.sent_at;
          data.TELNYX_PRICE = payload.cost?.amount || "0";
          data.TELNYX_MESSAGE_ID = payload.id;
          data.TELNYX_MESSAGE = payload.text;

          await outboundApi.putOutboundContactlistContact(listId, contactId, {
            data,
          });

          console.log("✓ Contact list updated:", contactId);
        }
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: true, event: event_type });
  } catch (error) {
    if (error instanceof TelnyxWebhookSignatureError) {
      console.warn("Telnyx SMS webhook rejected: invalid signature");
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 403 });
    }
    if (error instanceof TelnyxWebhookPayloadError) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }
    if (error instanceof TelnyxWebhookConfigurationError) {
      console.error("Telnyx SMS webhook verification is not configured");
      return NextResponse.json(
        { error: "Webhook verification is not configured" },
        { status: 503 }
      );
    }
    console.error("Error handling Telnyx webhook:", error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
