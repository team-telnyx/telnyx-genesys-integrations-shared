import { NextResponse } from "next/server";

import {
  clearGenesysAuthCookies,
  readGenesysAuthCookie,
  setGenesysTokenCookies,
} from "@/lib/genesys/auth-cookies.mjs";
import { hydrateRuntimeSecrets } from "@/lib/genesys/encrypted-secret-store.mjs";
import { genesysOauthBaseUrl } from "@/lib/genesys/oauth-public-origin.mjs";
import { refreshGenesysTokens } from "@/lib/genesys/oauth-refresh.mjs";

function safeReturnTo(value) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

async function refresh(request) {
  await hydrateRuntimeSecrets({ required: false });
  const baseUrl = genesysOauthBaseUrl(request);
  const refreshToken = readGenesysAuthCookie(request.cookies, "genesys_refresh_token");
  if (!refreshToken) {
    const error = new Error("Genesys refresh token is missing");
    error.status = 401;
    throw error;
  }
  const tokenData = await refreshGenesysTokens(refreshToken);
  return { baseUrl, tokenData };
}

export async function POST(request) {
  const baseUrl = genesysOauthBaseUrl(request);
  if (request.headers.get("origin") !== baseUrl) {
    return NextResponse.json(
      { error: "Cross-origin token refresh rejected", reauthRequired: true },
      { status: 403, headers: { "cache-control": "no-store" } }
    );
  }

  try {
    const result = await refresh(request);
    const response = NextResponse.json(
      { authenticated: true, expiresIn: result.tokenData.accessTokenMaxAge },
      { headers: { "cache-control": "no-store" } }
    );
    return setGenesysTokenCookies(response, result.tokenData, {
      secure: result.baseUrl.startsWith("https:"),
    });
  } catch (error) {
    console.warn("[genesys-auth] token refresh failed", {
      status: error.status,
      code: error.code,
    });
    return clearGenesysAuthCookies(NextResponse.json(
      { error: "Genesys session expired", reauthRequired: true },
      { status: 401, headers: { "cache-control": "no-store" } }
    ), { secure: baseUrl.startsWith("https:") });
  }
}

export async function GET(request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  try {
    const result = await refresh(request);
    const response = NextResponse.redirect(new URL(returnTo, result.baseUrl));
    response.headers.set("cache-control", "no-store");
    return setGenesysTokenCookies(response, result.tokenData, {
      secure: result.baseUrl.startsWith("https:"),
    });
  } catch (error) {
    console.warn("[genesys-auth] redirect token refresh failed", {
      status: error.status,
      code: error.code,
    });
    const loginUrl = new URL("/api/auth/login", genesysOauthBaseUrl(request));
    loginUrl.searchParams.set("returnTo", returnTo);
    return clearGenesysAuthCookies(NextResponse.redirect(loginUrl), {
      secure: loginUrl.protocol === "https:",
    });
  }
}
