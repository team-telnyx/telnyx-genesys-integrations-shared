import { NextResponse } from "next/server";

import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { loadAdminTtsPreviewCatalog } from "@/lib/genesys/admin-tts-preview.mjs";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const { profileId } = await params;
    const catalog = await loadAdminTtsPreviewCatalog(profileId, {
      apiKey: process.env.TELNYX_API_KEY,
    });
    return NextResponse.json({ catalog }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: Number(error.status) || 502 }
    );
  }
}
