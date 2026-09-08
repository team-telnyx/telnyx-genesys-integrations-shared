import { NextResponse } from "next/server";
import {
  attachmentResponseHeaders,
  resolveAttachmentResponseMimeType,
} from "@/lib/widgets/attachment-headers";
import { parseAttachmentByteRange } from "@/lib/widgets/attachment-ranges";
import { getHandoffMessageAttachment } from "@/lib/widgets/handoffs";
import { verifyAgentAttachmentDownload } from "@/lib/widgets/session-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Genesys serves agent attachments as `content-disposition: attachment` from its
// own host, so they can never preview inline. Streaming them back through this
// route also keeps the signed Genesys URL out of the customer's browser. The link
// is signed rather than bearer-authenticated so <img>, <audio> and <video> can
// load it directly.
export async function GET(request, { params }) {
  const { messageId, index } = await params;
  const query = new URL(request.url).searchParams;
  const sessionId = query.get("session") || "";
  const position = Number(index);
  const authorized = verifyAgentAttachmentDownload({
    sessionId,
    messageId,
    index,
    expires: query.get("expires"),
    token: query.get("token"),
  });
  if (!authorized) {
    return NextResponse.json({ error: "This attachment link is invalid or expired" }, { status: 403 });
  }

  const attachment = await getHandoffMessageAttachment({ sessionId, messageId, index: position });
  if (!attachment?.url) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  try {
    // Forwarding Range keeps seeking usable for audio and video playback.
    const range = request.headers.get("range");
    const response = await fetch(attachment.url, {
      redirect: "follow",
      cache: "no-store",
      ...(range ? { headers: { range } } : {}),
    });
    if (!response.ok && response.status !== 206) {
      return NextResponse.json({ error: "Attachment could not be loaded" }, { status: 502 });
    }
    const headers = attachmentResponseHeaders({
      mimeType: resolveAttachmentResponseMimeType(
        attachment,
        response.headers.get("content-type")
      ),
      filename: attachment.filename,
    });
    // Some Genesys media URLs ignore Range and return the entire file with 200.
    // Browsers then repeatedly restart MP3/WAV playback. Convert that response
    // into a standards-compliant partial response ourselves.
    if (range && response.status === 200) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const selected = parseAttachmentByteRange(range, bytes.length);
      if (!selected) {
        return new NextResponse(null, {
          status: 416,
          headers: { ...headers, "content-range": `bytes */${bytes.length}` },
        });
      }
      const chunk = bytes.subarray(selected.start, selected.end + 1);
      return new NextResponse(chunk, {
        status: 206,
        headers: {
          ...headers,
          "accept-ranges": "bytes",
          "content-range": `bytes ${selected.start}-${selected.end}/${bytes.length}`,
          "content-length": String(chunk.length),
        },
      });
    }
    const contentRange = response.headers.get("content-range");
    const contentLength = response.headers.get("content-length");
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        ...headers,
        "accept-ranges": "bytes",
        ...(contentRange ? { "content-range": contentRange } : {}),
        ...(contentLength ? { "content-length": contentLength } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "Attachment could not be loaded" }, { status: 502 });
  }
}
