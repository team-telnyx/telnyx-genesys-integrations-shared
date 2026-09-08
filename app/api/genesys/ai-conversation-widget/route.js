import { NextResponse } from "next/server";
import {
  GenesysWidgetAccessError,
  loadGenesysAiConversationWidget,
} from "@/lib/genesys/ai-conversation-widget";
import {
  clearGenesysAccessTokenCookie,
  readGenesysAuthCookie,
} from "@/lib/genesys/auth-cookies.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  try {
    const data = await loadGenesysAiConversationWidget({
      conversationId,
      accessToken: readGenesysAuthCookie(request.cookies, "genesys_access_token"),
    });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof GenesysWidgetAccessError ? error.status : 500;
    const response = NextResponse.json(
      { ok: false, error: error?.message || "Could not load Telnyx AI context" },
      { status, headers: { "Cache-Control": "no-store" } }
    );
    return status === 401 ? clearGenesysAccessTokenCookie(response) : response;
  }
}
