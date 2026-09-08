import { NextResponse } from "next/server";
import { attachmentResponseHeaders } from "@/lib/widgets/attachment-headers";
import {
  readSessionAttachment,
  verifyAttachmentDownload,
} from "@/lib/widgets/session-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Genesys downloads customer attachments from this route, so it authenticates on
// the signed link rather than on the widget session token.
export async function GET(request, { params }) {
  const { attachmentId } = await params;
  const query = new URL(request.url).searchParams;
  const sessionId = query.get("session") || "";
  const authorized = verifyAttachmentDownload({
    sessionId,
    attachmentId,
    expires: query.get("expires"),
    token: query.get("token"),
  });
  if (!authorized) {
    return NextResponse.json({ error: "This attachment link is invalid or expired" }, { status: 403 });
  }

  let attachment;
  try {
    attachment = await readSessionAttachment(sessionId, attachmentId);
  } catch {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }
  const { bytes, record } = attachment;
  return new NextResponse(bytes, {
    headers: attachmentResponseHeaders(record, bytes.length),
  });
}
