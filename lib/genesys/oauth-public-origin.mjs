function firstForwardedValue(value) {
  return String(value || "").split(",", 1)[0].trim();
}

export function genesysOauthBaseUrl(request, configuredBaseUrl = process.env.GC_PUBLIC_BASE_URL) {
  const configured = String(configuredBaseUrl || "").trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("GC_PUBLIC_BASE_URL must be a public HTTPS origin");
    }
    return url.origin;
  }

  const host = firstForwardedValue(
    request.headers.get("x-forwarded-host") || request.headers.get("host")
  );
  const proto = firstForwardedValue(request.headers.get("x-forwarded-proto")) || "https";
  if (!host) throw new Error("Unable to determine the OAuth callback origin");
  return new URL(`${proto}://${host}`).origin;
}

export function genesysOauthCallbackUrl(request, configuredBaseUrl = process.env.GC_PUBLIC_BASE_URL) {
  return `${genesysOauthBaseUrl(request, configuredBaseUrl)}/api/auth/callback`;
}
