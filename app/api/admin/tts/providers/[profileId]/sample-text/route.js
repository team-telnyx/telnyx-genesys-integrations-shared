import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { generateAdminTtsSampleText } from "@/lib/genesys/admin-tts-preview.mjs";

const requestSchema = z.object({
  language: z.string().trim().min(2).max(24),
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
    const sample = await generateAdminTtsSampleText({
      profileId,
      ...input,
      apiKey: process.env.TELNYX_API_KEY,
    });
    return NextResponse.json({ sample }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : Number(error.status) || 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
