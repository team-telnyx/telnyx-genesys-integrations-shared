import { NextResponse } from "next/server";
import {
  GENESYS_HANDOFF_CHANNELS,
  TELNYX_HANDOFF_MECHANISMS,
  GenesysHandoffValidationError,
  normalizeGenesysHandoffRequest,
  normalizeTelnyxConversationChannel,
  telnyxHandoffMechanism,
} from "./handoff-request.js";
import { authorizeGenesysHandoffRequest } from "./handoff-auth.js";
import { processGenesysMessagingHandoff } from "./widget-messaging-handoff-route.js";
import {
  GenesysQueueNotFoundError,
  findGenesysQueueByName,
} from "./queue-routing.js";
import { getAdminAudioQueuePolicy } from "./admin-console-store.mjs";

export async function handleGenesysHandoffRequest(request) {
  const auth = authorizeGenesysHandoffRequest(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    const body = await request.json();
    const telnyxChannel = normalizeTelnyxConversationChannel(
      body?.telnyx_conversation_channel
    );
    const mechanism = telnyxChannel
      ? telnyxHandoffMechanism(telnyxChannel)
      : body?.channel === "voice"
        ? TELNYX_HANDOFF_MECHANISMS.AUDIO_CONNECTOR
        : null;
    if (!mechanism) {
      throw new GenesysHandoffValidationError(
        "telnyx_conversation_channel is missing or unsupported",
        "telnyx_conversation_channel"
      );
    }
    if (mechanism === TELNYX_HANDOFF_MECHANISMS.SIP_TRANSFER) {
      return NextResponse.json(
        {
          ok: false,
          code: "GENESYS_SIP_TRANSFER_REQUIRED",
          telnyx_conversation_channel: telnyxChannel,
          error:
            "phone_call and web_call must use the Telnyx Transfer tool configured with the Genesys SIP URI; the Audio Connector handoff webhook is not valid for this transport.",
        },
        { status: 409 }
      );
    }
    if (mechanism === TELNYX_HANDOFF_MECHANISMS.OPEN_MESSAGING) {
      if (telnyxChannel !== "web_chat") {
        return NextResponse.json(
          {
            ok: false,
            code: "GENESYS_SMS_HANDOFF_UNAVAILABLE",
            telnyx_conversation_channel: telnyxChannel,
            error:
              "SMS handoff requires a channel-specific Genesys Open Messaging session and cannot use the web-widget handoff state.",
          },
          { status: 409 }
        );
      }
      return processGenesysMessagingHandoff(body);
    }
    const policy = await getAdminAudioQueuePolicy();
    const handoff = normalizeGenesysHandoffRequest(body, {
      defaultChannel: GENESYS_HANDOFF_CHANNELS.VOICE,
      defaultQueueName: policy?.defaultQueue?.name,
      allowedQueueNames: policy?.queues?.map(({ name }) => name),
    });
    const queue = await findGenesysQueueByName(handoff.queueName);
    return NextResponse.json({
      ok: true,
      channel: "voice",
      telnyx_conversation_channel: telnyxChannel || "legacy_voice",
      status: "accepted",
      queue_name: queue.name,
      queue_id: queue.id,
      assistant_instruction:
        "Briefly confirm the transfer. The Audio Connector runtime will return control to Genesys Architect after the confirmation finishes.",
    });
  } catch (error) {
    if (error instanceof GenesysHandoffValidationError) {
      return NextResponse.json(
        { ok: false, code: error.code, field: error.field, error: error.message },
        { status: error.status }
      );
    }
    if (error instanceof GenesysQueueNotFoundError) {
      return NextResponse.json(
        { ok: false, code: error.code, queue_name: error.queueName, error: error.message },
        { status: error.status }
      );
    }
    console.error("[genesys-handoff] Request failed:", error?.message || error);
    return NextResponse.json(
      { ok: false, error: error?.message || "Could not process handoff" },
      { status: 500 }
    );
  }
}

export const handleGenesysVoiceHandoffRequest = handleGenesysHandoffRequest;
