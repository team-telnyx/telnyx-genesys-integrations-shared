import { NextResponse } from "next/server";

import { setGenesysTokenCookies } from "@/lib/genesys/auth-cookies.mjs";
import { hydrateRuntimeSecrets } from "@/lib/genesys/encrypted-secret-store.mjs";
import { genesysOauthBaseUrl } from "@/lib/genesys/oauth-public-origin.mjs";
import { verifyGenesysOauthHandoff } from "@/lib/genesys/oauth-handoff.mjs";

export async function POST(request) {
  await hydrateRuntimeSecrets({ required: false });
  const baseUrl = genesysOauthBaseUrl(request);
  if (request.headers.get("origin") !== baseUrl) {
    return NextResponse.json({ error: "Cross-origin authentication handoff rejected" }, { status: 403 });
  }
  try {
    const { handoff } = await request.json();
    const tokenData = verifyGenesysOauthHandoff(handoff);
    const secure = baseUrl.startsWith("https:");
    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "cache-control": "no-store" } }
    );
    return setGenesysTokenCookies(response, tokenData, { secure });
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired authentication handoff" },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }
}
