// Which URLs an avatar <img> may point at.
//
// lib/widgets/config.js already refuses a stored image avatar that is not
// https, but the Avatar components take a spec from whoever renders them — the
// runtime passes locally created blob: URLs, and a future caller need not be
// schema-validated at all. Checking at the point of use keeps the components
// safe on their own terms rather than on their callers'.
//
// An <img> cannot execute a javascript: URL, so this is not about script
// injection. It is about where the visitor's browser is made to send a request
// from inside an embedded widget on somebody else's page.
const RENDERABLE_SCHEMES = new Set(["https:", "blob:"]);

export function isRenderableAvatarImage(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return false;
  try {
    // Parsed with no base on purpose: a relative or protocol-relative value
    // would otherwise be resolved into an absolute https URL and wave through
    // things like "//evil.test/a.png". An avatar is an absolute URL or nothing.
    return RENDERABLE_SCHEMES.has(new URL(candidate).protocol);
  } catch {
    return false;
  }
}
