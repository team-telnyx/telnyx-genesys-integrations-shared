import { NextResponse } from "next/server";
import { getGenesysAccessToken } from "@/lib/genesys/client";
import { downloadGenesysProfileImage } from "@/lib/genesys/profile-images";
import { getHandoffMessageProfileImage } from "@/lib/widgets/handoffs";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken } from "@/lib/widgets/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await getWidgetSessionByToken(bearerToken(request));
  if (!session || session.channel !== "messaging") {
    return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
  }
  const { messageId } = await params;
  const imageUri = await getHandoffMessageProfileImage({ sessionId: session.id, messageId });
  if (!imageUri) return NextResponse.json({ error: "Agent profile picture was not found" }, { status: 404 });

  try {
    const accessToken = await getGenesysAccessToken();
    const image = await downloadGenesysProfileImage({ imageUri, accessToken });
    return new NextResponse(image.body, {
      headers: {
        "content-type": image.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Agent profile picture could not be loaded" }, { status: 502 });
  }
}
