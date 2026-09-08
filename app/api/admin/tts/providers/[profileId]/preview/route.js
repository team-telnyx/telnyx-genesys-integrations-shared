import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH,
  synthesizeAdminTtsPreview,
} from "@/lib/genesys/admin-tts-preview.mjs";

const requestSchema = z.object({
  voiceId: z.string().trim().min(1).max(240),
  language: z.string().trim().min(2).max(24),
  text: z.string().trim().min(1).max(ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH),
  useExpressiveMode: z.boolean().default(false),
}).strict();

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const { profileId } = await params;
    const input = requestSchema.parse(await request.json());
    const audio = await synthesizeAdminTtsPreview({
      profileId,
      ...input,
      apiKey: process.env.TELNYX_API_KEY,
    });
    return new Response(audio.buffer, {
      status: 200,
      headers: {
        "Content-Type": audio.contentType,
        "Content-Length": String(audio.buffer.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : Number(error.status) || 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
