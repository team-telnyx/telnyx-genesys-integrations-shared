import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { setGenesysAuthCookie } from "@/lib/genesys/auth-cookies.mjs";
import { hydrateRuntimeSecrets } from "@/lib/genesys/encrypted-secret-store.mjs";
import {
  genesysOauthBaseUrl,
  genesysOauthCallbackUrl,
} from "@/lib/genesys/oauth-public-origin.mjs";

function safeReturnTo(value) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request) {
  await hydrateRuntimeSecrets({ required: false });
  const { searchParams } = new URL(request.url);
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const popup = searchParams.get("popup") === "1";
  const clientId = process.env.GC_CLIENT_ID;
  const region = process.env.GC_ENVIRONMENT || "mypurecloud.com";
  if (!clientId) {
    return NextResponse.json({ error: "GC_CLIENT_ID not configured" }, { status: 500 });
  }

  const baseUrl = genesysOauthBaseUrl(request);
  const callbackUrl = genesysOauthCallbackUrl(request);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const secure = baseUrl.startsWith("https:");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const response = NextResponse.redirect(
    `https://login.${region}/oauth/authorize?${params}`
  );
  const cookieOptions = { secure, maxAge: 600 };
  setGenesysAuthCookie(response, "genesys_oauth_state", state, cookieOptions);
  setGenesysAuthCookie(response, "genesys_pkce_verifier", verifier, cookieOptions);
  setGenesysAuthCookie(
    response,
    "genesys_oauth_return",
    Buffer.from(JSON.stringify({ returnTo, popup })).toString("base64url"),
    cookieOptions
  );
  return response;
}
