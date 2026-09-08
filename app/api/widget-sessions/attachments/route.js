import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken, touchWidgetSession } from "@/lib/widgets/sessions";
import {
  getMessagingHandoffBySession,
  serializeMessagingHandoff,
  storeHandoffMessage,
} from "@/lib/widgets/handoffs";
import { sendGenesysCustomerMessage } from "@/lib/genesys/widget-open-messaging";
import {
  attachmentDownloadPath,
  genesysMediaType,
  writeSessionAttachment,
} from "@/lib/widgets/session-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicBaseUrl(request) {
  const configured = String(process.env.GC_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  return configured || new URL(request.url).origin;
}

export async function POST(request) {
  try {
    const session = await getWidgetSessionByToken(bearerToken(request));
    if (!session || session.channel !== "messaging") {
      return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
    }
    const policy = session.config.features.attachmentPolicy;
    if (!session.config.features.attachmentsAfterHandoff) {
      return NextResponse.json({ error: "File upload is disabled for this widget" }, { status: 403 });
    }
    // Only the Genesys Open Messaging channel carries customer attachments, so
    // uploading is possible exactly while a human agent is on the conversation.
    const handoff = await getMessagingHandoffBySession(session.id);
    if (handoff && ["disconnected", "completed"].includes(handoff.status)) {
      return NextResponse.json({ error: "This conversation has ended" }, { status: 409 });
    }
    if (!handoff || !["waiting", "assigned", "connected"].includes(handoff.status)) {
      return NextResponse.json(
        { error: "Files can be shared once an agent has joined the conversation" },
        { status: 409 }
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "Attach one file to upload" }, { status: 400 });
    }
    const mimeType = String(file.type || "").toLowerCase();
    if (!policy.inboundMimeTypes.includes(mimeType)) {
      return NextResponse.json({ error: "This file type is not accepted" }, { status: 415 });
    }
    const maximumBytes = policy.maximumFileSizeMb * 1_048_576;
    if (!file.size || file.size > maximumBytes) {
      return NextResponse.json(
        { error: `Files must be between 1 byte and ${policy.maximumFileSizeMb} MB` },
        { status: 413 }
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > maximumBytes) {
      return NextResponse.json(
        { error: `Files must be between 1 byte and ${policy.maximumFileSizeMb} MB` },
        { status: 413 }
      );
    }

    const record = await writeSessionAttachment({
      sessionId: session.id,
      filename: file.name,
      mimeType,
      bytes,
    });
    const url = `${publicBaseUrl(request)}${attachmentDownloadPath(session.id, record.id)}`;
    const attachment = {
      id: record.id,
      filename: record.filename,
      mediaType: genesysMediaType(mimeType),
      mime: mimeType,
      contentType: mimeType,
      size: record.size,
      url,
    };
    const messageId = randomUUID();
    await sendGenesysCustomerMessage({
      handoff,
      messageId,
      text: record.filename,
      attachments: [attachment],
    });
    await storeHandoffMessage({
      handoffId: handoff.id,
      providerMessageId: messageId,
      direction: "inbound",
      sender: "customer",
      messageType: "Attachment",
      text: "",
      attachments: [attachment],
    });
    const expiresAt = await touchWidgetSession(session);
    return NextResponse.json(
      {
        message: {
          id: messageId,
          role: "user",
          content: "",
          attachments: [attachment],
          createdAt: new Date().toISOString(),
        },
        handoff: serializeMessagingHandoff(handoff),
        expiresAt,
      },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[widget-attachments]", error);
    return NextResponse.json({ error: "The file could not be uploaded" }, { status: 500 });
  }
}
