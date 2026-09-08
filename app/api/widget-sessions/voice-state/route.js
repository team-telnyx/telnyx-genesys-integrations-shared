import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerToken } from "@/lib/widgets/session-tokens";
import {
  getWidgetSessionByToken,
  getWidgetVoiceSessionByToken,
  updateVoiceSessionState,
} from "@/lib/widgets/sessions";
import {
  getVoiceHandoffBySession,
  serializeVoiceHandoff,
} from "@/lib/widgets/handoffs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    status: z.enum(["active", "completed", "failed"]),
    telnyxCallId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export async function GET(request) {
  try {
    const session = await getWidgetVoiceSessionByToken(bearerToken(request));
    if (!session) {
      return NextResponse.json({ error: "Invalid or expired voice session" }, { status: 401 });
    }
    const handoff = await getVoiceHandoffBySession(session.id);
    return NextResponse.json(
      { handoff: serializeVoiceHandoff(handoff) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[widget-voice-state]", error);
    return NextResponse.json({ error: "Unable to load voice session" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const session = await getWidgetSessionByToken(bearerToken(request));
    if (!session || session.channel !== "voice") {
      return NextResponse.json({ error: "Invalid or expired voice session" }, { status: 401 });
    }
    const input = requestSchema.parse(await request.json());
    const updated = await updateVoiceSessionState(session, input);
    return NextResponse.json(
      {
        session: {
          id: updated.id,
          channel: updated.channel,
          status: updated.status,
          telnyxCallId: updated.telnyx_call_id,
          expiresAt: updated.expires_at,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid voice session state" }, { status: 400 });
    }
    console.error("[widget-voice-state]", error);
    return NextResponse.json({ error: "Unable to update voice session" }, { status: 500 });
  }
}
