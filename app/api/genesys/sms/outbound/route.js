import { NextResponse } from "next/server";
import crypto from "crypto";
import { sendMessage } from "@/lib/telnyx/client";
import { getOutboundApi } from "@/lib/genesys/client";

/**
 * POST /api/genesys/sms/outbound
 * Webhook handler for Genesys Cloud Open Messaging outbound messages
 * Sends messages via Telnyx SMS API
 */
export async function POST(request) {
  try {
    const body = await request.json();

    console.log("📤 Genesys outbound message received");

    // Verify Genesys Cloud signature
    const gcSignature = request.headers.get("x-hub-signature-256");
    const hash = crypto
      .createHmac("sha256", process.env.GC_SECRET_TOKEN)
      .update(JSON.stringify(body))
      .digest("base64");

    if (`sha256=${hash}` !== gcSignature) {
      console.error("❌ Invalid Genesys Cloud signature");
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    if (body.type === "Text") {
      // Parse tags from channel.to.id (format: "+1234567890|listId|contactId")
      const tags = body.channel?.to?.id?.split("|") || [];
      const recipientNumber = tags[0];

      if (!recipientNumber) {
        console.error("❌ No recipient number in message");
        return NextResponse.json(
          { error: "Missing recipient number" },
          { status: 400 }
        );
      }

      // Send SMS via Telnyx
      const result = await sendMessage({
        from: process.env.TELNYX_FROM_NUMBER,
        to: recipientNumber,
        text: body.text,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID,
        tags: tags,
      });

      console.log("✓ SMS sent via Telnyx:", result.data.id);

      // If this is a campaign message (has 3 tags), update contact list
      if (tags.length === 3) {
        const [_, listId, contactId] = tags;
        const outboundApi = await getOutboundApi();

        const contacts =
          await outboundApi.postOutboundContactlistContactsBulk(listId, [
            contactId,
          ]);

        if (contacts && contacts[0]) {
          const data = contacts[0].data;
          data.TELNYX_STATUS = result.data.to[0].status;
          data.TELNYX_TIME = result.data.received_at;
          data.TELNYX_PRICE = result.data.cost?.amount || "0";
          data.TELNYX_MESSAGE_ID = result.data.id;
          data.TELNYX_MESSAGE = result.data.text;

          await outboundApi.putOutboundContactlistContact(listId, contactId, {
            data,
          });

          console.log("✓ Contact list updated:", contactId);
        }
      }

      return NextResponse.json({ success: true, messageId: result.data.id });
    } else {
      // Receipt or other message type
      console.log("📋 Genesys receipt received:", body.type);
      return NextResponse.json({ success: true });
    }
  } catch (error) {
    console.error("Error handling Genesys outbound:", error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
