import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetVideoSessionByToken } from "@/lib/widgets/sessions";
import { createVideoService } from "@/lib/video/service.mjs";

export async function POST(request, { params }) {
  try {
    const { action } = await params;
    if (!["join", "token", "leave"].includes(action)) return NextResponse.json({ error: "Unknown video action" }, { status: 404 });
    const session = await getWidgetVideoSessionByToken(bearerToken(request));
    if (!session) return NextResponse.json({ error: "Video session expired" }, { status: 401 });
    const service = createVideoService();
    const result = action === "leave" ? await service.end(session.id, "customer_left")
      : await service.join(session.id, action === "token" ? z.object({ refreshToken: z.string().min(1).max(4096) }).strict().parse(await request.json()) : {});
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : Number(error.status || 500);
    if (status >= 500) console.error("[video-action]", error.message);
    return NextResponse.json({ error: status >= 500 ? "Video service unavailable" : error.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
