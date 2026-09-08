import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decodeSecretsMasterKey } from "./encrypted-secret-store.mjs";

const VERSION = "goh1";
const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("telnyx-genesys-integrations:genesys-oauth-handoff:v1", "utf8");
const HANDOFF_TTL_SECONDS = 60;

export function createGenesysOauthHandoff({
  accessToken,
  refreshToken = null,
  accessTokenMaxAge,
  now = Date.now(),
} = {}) {
  if (!String(accessToken || "").trim()) throw new Error("Genesys access token is required");
  const payload = JSON.stringify({
    typ: "genesys-oauth-handoff",
    accessToken,
    refreshToken,
    accessTokenMaxAge: Math.max(1, Number(accessTokenMaxAge || 3600)),
    exp: Math.floor(now / 1000) + HANDOFF_TTL_SECONDS,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, decodeSecretsMasterKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function verifyGenesysOauthHandoff(value, { now = Date.now() } = {}) {
  const [version, encodedIv, encodedCiphertext, encodedTag, extra] = String(value || "").split(".");
  if (version !== VERSION || !encodedIv || !encodedCiphertext || !encodedTag || extra) {
    throw new Error("Invalid Genesys OAuth handoff");
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      decodeSecretsMasterKey(),
      Buffer.from(encodedIv, "base64url")
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    if (
      payload.typ !== "genesys-oauth-handoff" ||
      !String(payload.accessToken || "").trim() ||
      !Number.isInteger(payload.exp) ||
      payload.exp < Math.floor(now / 1000)
    ) {
      throw new Error("Expired Genesys OAuth handoff");
    }
    return payload;
  } catch (error) {
    if (/Expired Genesys OAuth handoff/.test(String(error?.message || ""))) throw error;
    throw new Error("Invalid Genesys OAuth handoff");
  }
}
