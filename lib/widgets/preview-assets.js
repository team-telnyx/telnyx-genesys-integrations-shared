import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_WIDGET_PREVIEW_BYTES = 8 * 1_048_576;
const WIDGET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_VARIANT = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

function assetRoot() {
  return process.env.WIDGET_ASSET_DIR || path.join(process.cwd(), ".widget-assets");
}

function assertWidgetId(widgetId) {
  if (!WIDGET_ID.test(widgetId)) throw new Error("Invalid widget ID");
}

function widgetDirectory(widgetId) {
  assertWidgetId(widgetId);
  return path.join(assetRoot(), widgetId);
}

function assertPreviewVariant(variant) {
  if (!PREVIEW_VARIANT.test(variant)) throw new Error("Invalid preview variant");
}

function widgetPreviewPath(widgetId, variant) {
  assertPreviewVariant(variant);
  return path.join(widgetDirectory(widgetId), `preview-background-${variant}.webp`);
}

export function widgetPreviewAssetUrl(widgetId, variant, timestamp = Date.now()) {
  assertWidgetId(widgetId);
  assertPreviewVariant(variant);
  return `/api/admin/widgets/${widgetId}/preview-background?variant=${encodeURIComponent(variant)}&v=${timestamp}`;
}

function isWebp(bytes) {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function writeWidgetPreviewAsset(widgetId, variant, bytes) {
  assertWidgetId(widgetId);
  assertPreviewVariant(variant);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_WIDGET_PREVIEW_BYTES) {
    throw new Error("Screenshot must be a non-empty WebP image up to 8 MB");
  }
  if (!isWebp(bytes)) throw new Error("Uploaded screenshot is not a valid WebP image");

  const directory = widgetDirectory(widgetId);
  const destination = widgetPreviewPath(widgetId, variant);
  const temporary = path.join(directory, `.preview-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return widgetPreviewAssetUrl(widgetId, variant);
}

export async function readWidgetPreviewAsset(widgetId, variant) {
  return readFile(widgetPreviewPath(widgetId, variant));
}

export async function deleteWidgetPreviewAsset(widgetId, variant) {
  await rm(widgetPreviewPath(widgetId, variant), { force: true });
}

export async function copyWidgetPreviewAssets(sourceWidgetId, targetWidgetId) {
  const sourceDirectory = widgetDirectory(sourceWidgetId);
  const targetDirectory = widgetDirectory(targetWidgetId);
  let entries;
  try {
    entries = await readdir(sourceDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const variants = entries.flatMap((entry) => {
    const match = entry.match(/^preview-background-([a-z0-9][a-z0-9_-]{0,80})\.webp$/i);
    return match ? [match[1]] : [];
  });
  if (!variants.length) return [];
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await Promise.all(variants.map((variant) => copyFile(
    widgetPreviewPath(sourceWidgetId, variant),
    widgetPreviewPath(targetWidgetId, variant)
  )));
  return variants;
}
