import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  clearGenesysAuthCookie,
  readGenesysAuthCookie,
  setGenesysTokenCookies,
} from "@/lib/genesys/auth-cookies.mjs";
import { hydrateRuntimeSecrets } from "@/lib/genesys/encrypted-secret-store.mjs";
import {
  genesysOauthBaseUrl,
  genesysOauthCallbackUrl,
} from "@/lib/genesys/oauth-public-origin.mjs";
import { createGenesysOauthHandoff } from "@/lib/genesys/oauth-handoff.mjs";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readReturnCookie(request) {
  try {
    const raw = readGenesysAuthCookie(request.cookies, "genesys_oauth_return") || "";
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return {
      returnTo:
        parsed.returnTo?.startsWith("/") && !parsed.returnTo.startsWith("//")
          ? parsed.returnTo
          : "/",
      popup: parsed.popup === true,
    };
  } catch {
    return { returnTo: "/", popup: false };
  }
}

function clearTransientCookies(response, secure) {
  for (const name of [
    "genesys_oauth_state",
    "genesys_pkce_verifier",
    "genesys_oauth_return",
  ]) {
    clearGenesysAuthCookie(response, name, { secure });
  }
}

export async function GET(request) {
  await hydrateRuntimeSecrets({ required: false });
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = readGenesysAuthCookie(request.cookies, "genesys_oauth_state");
  const verifier = readGenesysAuthCookie(request.cookies, "genesys_pkce_verifier");
  if (!code || !verifier || !safeEqual(state, expectedState)) {
    return NextResponse.json({ error: "Invalid OAuth callback state" }, { status: 400 });
  }

  const clientId = process.env.GC_CLIENT_ID;
  const clientSecret = process.env.GC_CLIENT_SECRET;
  const region = process.env.GC_ENVIRONMENT || "mypurecloud.com";
  const baseUrl = genesysOauthBaseUrl(request);
  const callbackUrl = genesysOauthCallbackUrl(request);
  const returnState = readReturnCookie(request);
  const secure = baseUrl.startsWith("https:");

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    });
    if (!clientSecret) params.set("client_id", clientId);

    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64"
      )}`;
    }
    const tokenResponse = await fetch(`https://login.${region}/oauth/token`, {
      method: "POST",
      headers,
      body: params,
    });
    if (!tokenResponse.ok) {
      console.error("[genesys-auth] token exchange failed:", await tokenResponse.text());
      return NextResponse.json({ error: "Failed to exchange Genesys token" }, { status: 400 });
    }
    const tokenData = await tokenResponse.json();

    let response;
    if (returnState.popup) {
      const targetOrigin = JSON.stringify(baseUrl).replaceAll("<", "\\u003c");
      const handoffMessage = JSON.stringify({
        type: "genesys-auth-complete",
        handoff: createGenesysOauthHandoff({
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          accessTokenMaxAge: tokenData.expires_in,
        }),
      }).replaceAll("<", "\\u003c");
      response = new NextResponse(
        `<!doctype html><meta charset="utf-8"><title>Genesys login</title>
         <p>Authentication completed. This window can be closed.</p>
         <script>window.opener?.postMessage(${handoffMessage},${targetOrigin});window.close();</script>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'",
          },
        }
      );
    } else {
      response = NextResponse.redirect(new URL(returnState.returnTo, baseUrl));
      setGenesysTokenCookies(response, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        accessTokenMaxAge: tokenData.expires_in,
      }, { secure });
    }
    clearTransientCookies(response, secure);
    return response;
  } catch (error) {
    console.error("[genesys-auth] callback failed:", error);
    return NextResponse.json({ error: "Internal authentication error" }, { status: 500 });
  }
}
