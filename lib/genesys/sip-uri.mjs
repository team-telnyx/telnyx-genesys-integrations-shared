// Pure SIP URI helpers with no runtime dependencies, so the admin console can
// reuse the exact rule that publishing applies. Keeping them here rather than in
// sip-destination.mjs stops the PostgreSQL client from being pulled into the
// browser bundle through that module's transitive imports.

export function normalizeGenesysSipUri(value) {
  const uri = String(value ?? "").trim();
  if (!uri) throw new Error("Genesys SIP URI is required");
  if (!/^sips?:[^\s]+$/i.test(uri)) {
    throw new Error("Genesys SIP destination must be a valid sip: or sips: URI");
  }
  return uri;
}

export function normalizeGenesysDid(value) {
  const normalized = String(value || "").trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new Error(`Genesys destination DID must use E.164 format: ${value || "(missing)"}`);
  }
  return normalized;
}

export function genesysTrunkTransport(trunk) {
  const transport = String(trunk?.transport || "").trim().toLowerCase();
  return ["tls", "tcp", "udp"].includes(transport) ? transport : "";
}

// A BYOC trunk on TLS terminates media as SRTP, and the only way to ask Telnyx for
// that is the `;secure=srtp` URI parameter — the transfer tool's own
// media_encryption field is stored but never applied. Without it the Edge accepts
// the INVITE, assigns a conversation and then fails to join media, which Telnyx
// reports as SIP 488 Not Acceptable Here.
export function genesysTrunkRequiresSecureMedia(trunk) {
  return genesysTrunkTransport(trunk) === "tls";
}

export function buildGenesysSipUri({ did, fqdn, transport = "" }) {
  const phoneNumber = normalizeGenesysDid(did);
  const host = String(fqdn || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".")) {
    throw new Error(`Invalid Genesys SIP FQDN: ${fqdn || "(missing)"}`);
  }
  const secure = genesysTrunkRequiresSecureMedia({ transport }) ? ";secure=srtp" : "";
  return normalizeGenesysSipUri(`sip:${phoneNumber}@${host}${secure}`);
}
