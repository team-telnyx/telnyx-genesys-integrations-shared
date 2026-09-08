function normalizedHttpOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value) {
  return String(value || "").split(",")[0].trim();
}

export function isAllowedMutationOrigin(request, publicBaseUrl = process.env.GC_PUBLIC_BASE_URL) {
  const origin = normalizedHttpOrigin(request.headers.get("origin"));
  if (!origin) return false;

  const allowed = new Set();
  const requestOrigin = normalizedHttpOrigin(request.url);
  if (requestOrigin) allowed.add(requestOrigin);

  const host = firstForwardedValue(request.headers.get("host"));
  if (host) {
    const protocol = firstForwardedValue(request.headers.get("x-forwarded-proto")) ||
      new URL(request.url).protocol.replace(":", "");
    const hostOrigin = normalizedHttpOrigin(`${protocol}://${host}`);
    if (hostOrigin) allowed.add(hostOrigin);
  }

  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  if (forwardedHost) {
    const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto")) || "https";
    const forwardedOrigin = normalizedHttpOrigin(`${forwardedProto}://${forwardedHost}`);
    if (forwardedOrigin) allowed.add(forwardedOrigin);
  }

  const configuredOrigin = normalizedHttpOrigin(publicBaseUrl);
  if (configuredOrigin) allowed.add(configuredOrigin);
  return allowed.has(origin);
}
