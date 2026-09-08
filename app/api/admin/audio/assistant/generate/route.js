import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { generateDefaultAudioAssistantContent } from "@/lib/genesys/admin-assistant-generator.mjs";

const schema = z.object({ description: z.string().trim().min(10).max(2000) }).strict();

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const input = schema.parse(await request.json());
    const assistant = await generateDefaultAudioAssistantContent({
      ...input,
      apiKey: process.env.TELNYX_API_KEY,
    });
    return NextResponse.json({ assistant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : Number(error.status) || 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
