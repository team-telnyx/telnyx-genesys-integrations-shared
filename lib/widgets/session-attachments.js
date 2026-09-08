import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Genesys fetches an inbound attachment from the URL we hand it, so the link has
// to work without the widget session token. It is signed and short-lived instead.
const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

function signingSecret() {
  const value = String(process.env.WIDGET_SESSION_SIGNING_SECRET || "").trim();
  if (value.length < 32) {
    throw new Error("WIDGET_SESSION_SIGNING_SECRET must contain at least 32 characters");
  }
  return value;
}

function assetRoot() {
  return process.env.WIDGET_ASSET_DIR || path.join(process.cwd(), ".widget-assets");
}

function assertSessionId(sessionId) {
  if (!SESSION_ID.test(String(sessionId || ""))) throw new Error("Invalid widget session ID");
  return String(sessionId);
}

function assertAttachmentId(attachmentId) {
  if (!ATTACHMENT_ID.test(String(attachmentId || ""))) throw new Error("Invalid attachment ID");
  return String(attachmentId);
}

function sessionDirectory(sessionId) {
  return path.join(assetRoot(), "sessions", assertSessionId(sessionId));
}

function attachmentPaths(sessionId, attachmentId) {
  const directory = sessionDirectory(sessionId);
  const id = assertAttachmentId(attachmentId);
  return {
    directory,
    binary: path.join(directory, `${id}.bin`),
    metadata: path.join(directory, `${id}.json`),
  };
}

export function attachmentDownloadToken(sessionId, attachmentId, expiresAt) {
  const value = `${assertSessionId(sessionId)}.${assertAttachmentId(attachmentId)}.${expiresAt}`;
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

export function attachmentDownloadPath(sessionId, attachmentId, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + DOWNLOAD_TTL_SECONDS;
  const token = attachmentDownloadToken(sessionId, attachmentId, expiresAt);
  const query = new URLSearchParams({ session: sessionId, expires: String(expiresAt), token });
  return `/api/widget-attachments/${attachmentId}?${query}`;
}

export function verifyAttachmentDownload({ sessionId, attachmentId, expires, token }, now = Date.now()) {
  const expiresAt = Number(expires);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(now / 1000)) return false;
  let expected;
  try {
    expected = attachmentDownloadToken(sessionId, attachmentId, expiresAt);
  } catch {
    return false;
  }
  const supplied = Buffer.from(String(token || ""));
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

// Agent attachments live on Genesys and are proxied. Signing their link the same
// way lets <img>, <audio> and <video> load them directly, which a session token in
// an Authorization header could never do.
export function agentAttachmentDownloadPath(sessionId, messageId, index, expiry = Date.now()) {
  const explicitExpiry = expiry && typeof expiry === "object" ? expiry.expiresAt : null;
  const parsedExpiry = explicitExpiry ? new Date(explicitExpiry).getTime() : NaN;
  const expiresAt = Number.isFinite(parsedExpiry)
    ? Math.floor(parsedExpiry / 1000)
    : Math.floor((Number.isFinite(Number(expiry)) ? Number(expiry) : Date.now()) / 1000)
      + DOWNLOAD_TTL_SECONDS;
  const query = new URLSearchParams({
    session: assertSessionId(sessionId),
    expires: String(expiresAt),
    token: agentAttachmentToken(sessionId, messageId, index, expiresAt),
  });
  return `/api/widget-sessions/agent-attachment/${encodeURIComponent(messageId)}/${index}?${query}`;
}

function agentAttachmentToken(sessionId, messageId, index, expiresAt) {
  const value = `agent.${assertSessionId(sessionId)}.${messageId}.${index}.${expiresAt}`;
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

export function verifyAgentAttachmentDownload(
  { sessionId, messageId, index, expires, token },
  now = Date.now()
) {
  const expiresAt = Number(expires);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(now / 1000)) return false;
  let expected;
  try {
    expected = agentAttachmentToken(sessionId, messageId, index, expiresAt);
  } catch {
    return false;
  }
  const supplied = Buffer.from(String(token || ""));
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

// Genesys classifies every inbound attachment, and only these four values are
// accepted; anything else has to travel as a generic File.
export function genesysMediaType(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value.startsWith("image/")) return "Image";
  if (value.startsWith("video/")) return "Video";
  if (value.startsWith("audio/")) return "Audio";
  return "File";
}

export async function writeSessionAttachment({ sessionId, filename, mimeType, bytes }) {
  const attachmentId = randomUUID();
  const { directory, binary, metadata } = attachmentPaths(sessionId, attachmentId);
  const record = {
    id: attachmentId,
    sessionId: assertSessionId(sessionId),
    filename: String(filename || "attachment").slice(0, 255),
    mimeType: String(mimeType || "application/octet-stream").slice(0, 255),
    size: bytes.length,
    createdAt: new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${attachmentId}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, binary);
    await writeFile(metadata, JSON.stringify(record), { mode: 0o600 });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return record;
}

export async function readSessionAttachment(sessionId, attachmentId) {
  const { binary, metadata } = attachmentPaths(sessionId, attachmentId);
  const [bytes, record] = await Promise.all([
    readFile(binary),
    readFile(metadata, "utf8").then((value) => JSON.parse(value)),
  ]);
  return { bytes, record };
}

export async function deleteSessionAttachments(sessionId) {
  await rm(sessionDirectory(sessionId), { recursive: true, force: true });
}

// Sessions are deleted from PostgreSQL when they expire, which would otherwise
// leave their uploads behind on disk forever.
export async function deleteOrphanedSessionAttachments(activeSessionIds, olderThanMs = 60 * 60 * 1000) {
  const root = path.join(assetRoot(), "sessions");
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const active = new Set(activeSessionIds.map((value) => String(value)));
  const threshold = Date.now() - olderThanMs;
  let removed = 0;
  for (const entry of entries) {
    if (active.has(entry) || !SESSION_ID.test(entry)) continue;
    const directory = path.join(root, entry);
    const stats = await stat(directory).catch(() => null);
    if (!stats || stats.mtimeMs > threshold) continue;
    await rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
