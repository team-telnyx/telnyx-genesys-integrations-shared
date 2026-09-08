import { NextResponse } from "next/server";
import { getConversationsApi } from "@/lib/genesys/client";

/**
 * POST /api/genesys/sms/agentless
 * Send agentless SMS via Genesys Cloud Open Messaging
 */
export async function POST(request) {
  try {
    const { senderId, number, text } = await request.json();

    if (!number || !text) {
      return NextResponse.json(
        { error: "Missing required fields: number, text" },
        { status: 400 }
      );
    }

    console.log("📨 Sending agentless message to:", number);

    const conversationsApi = await getConversationsApi();

    const data = {
      fromAddress: process.env.GC_MESSAGE_DEPLOYMENT_ID,
      toAddress: number,
      toAddressMessengerType: "open",
      textBody: text,
      useExistingActiveConversation: true,
    };

    const response =
      await conversationsApi.postConversationsMessagesAgentless(data);

    console.log("✓ Agentless message sent:", response.id);

    return NextResponse.json({
      success: true,
      conversationId: response.id,
    });
  } catch (error) {
    console.error("Error sending agentless message:", error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
