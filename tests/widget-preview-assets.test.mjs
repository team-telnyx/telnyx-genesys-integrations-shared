import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyWidgetPreviewAssets,
  deleteWidgetPreviewAsset,
  readWidgetPreviewAsset,
  writeWidgetPreviewAsset,
} from "../lib/widgets/preview-assets.js";

test("widget preview screenshot is stored under its widget ID and survives config reloads by URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "widget-assets-"));
  const previous = process.env.WIDGET_ASSET_DIR;
  process.env.WIDGET_ASSET_DIR = root;
  const widgetId = "2ae5c8cb-5713-4bce-8f31-c393525f5146";
  const variant = "iphone-16-pro__portrait";
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
  try {
    const url = await writeWidgetPreviewAsset(widgetId, variant, image);
    assert.match(url, new RegExp(`^/api/admin/widgets/${widgetId}/preview-background\\?variant=${variant}&v=\\d+$`));
    assert.deepEqual(await readWidgetPreviewAsset(widgetId, variant), image);
    assert.deepEqual(await readFile(path.join(root, widgetId, `preview-background-${variant}.webp`)), image);
    await deleteWidgetPreviewAsset(widgetId, variant);
    await assert.rejects(readWidgetPreviewAsset(widgetId, variant), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.WIDGET_ASSET_DIR;
    else process.env.WIDGET_ASSET_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("widget preview storage rejects invalid IDs and non-WebP payloads", async () => {
  const widgetId = "2ae5c8cb-5713-4bce-8f31-c393525f5146";
  await assert.rejects(writeWidgetPreviewAsset("../escape", "desktop-responsive__landscape", Buffer.from("RIFFxxxxWEBP")), /Invalid widget ID/);
  await assert.rejects(writeWidgetPreviewAsset(widgetId, "../escape", Buffer.from("RIFFxxxxWEBP")), /Invalid preview variant/);
  await assert.rejects(writeWidgetPreviewAsset(widgetId, "desktop-responsive__landscape", Buffer.from("not an image")), /valid WebP/);
});

test("cloning a widget copies every device-specific preview image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "widget-assets-clone-"));
  const previous = process.env.WIDGET_ASSET_DIR;
  process.env.WIDGET_ASSET_DIR = root;
  const sourceId = "2ae5c8cb-5713-4bce-8f31-c393525f5146";
  const targetId = "52d75c62-05f1-4a8f-a7b2-e8b0dfe83d38";
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
  try {
    await writeWidgetPreviewAsset(sourceId, "iphone-16-pro__portrait", image);
    await writeWidgetPreviewAsset(sourceId, "ipad-air-11__landscape", image);
    const variants = await copyWidgetPreviewAssets(sourceId, targetId);
    assert.deepEqual(variants.sort(), ["ipad-air-11__landscape", "iphone-16-pro__portrait"]);
    assert.deepEqual(await readWidgetPreviewAsset(targetId, "iphone-16-pro__portrait"), image);
    assert.deepEqual(await readWidgetPreviewAsset(targetId, "ipad-air-11__landscape"), image);
  } finally {
    if (previous === undefined) delete process.env.WIDGET_ASSET_DIR;
    else process.env.WIDGET_ASSET_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
