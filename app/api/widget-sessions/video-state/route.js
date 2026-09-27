import { NextResponse } from "next/server";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetVideoSessionByToken } from "@/lib/widgets/sessions";
import { createVideoService } from "@/lib/video/service.mjs";
export const dynamic = "force-dynamic";
export async function GET(request) {
  try {
    const session = await getWidgetVideoSessionByToken(bearerToken(request));
    if (!session) return NextResponse.json({ error: "Video session expired" }, { status: 401 });
    return NextResponse.json(await createVideoService().state(session.id, { touch: true }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[video-state]", error.message);
    return NextResponse.json({ error: "Unable to load video state" }, { status: Number(error.status || 500) });
  }
}
