import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEW_DEVICES,
  getPreviewDevice,
  previewBackground,
  previewVariantKey,
  previewViewport,
} from "../lib/widgets/preview-devices.js";

test("device catalog covers desktop, iOS, Android and tablet previews", () => {
  assert.ok(PREVIEW_DEVICES.some(({ type }) => type === "desktop"));
  assert.ok(PREVIEW_DEVICES.some(({ type, platform }) => type === "phone" && platform === "ios"));
  assert.ok(PREVIEW_DEVICES.some(({ type, platform }) => type === "phone" && platform === "android"));
  assert.ok(PREVIEW_DEVICES.some(({ type, platform }) => type === "tablet" && platform === "ios"));
  assert.ok(PREVIEW_DEVICES.some(({ type, platform }) => type === "tablet" && platform === "android"));
});

test("orientation swaps CSS viewport dimensions while desktop remains landscape", () => {
  const iphone = getPreviewDevice("iphone-16-pro");
  assert.deepEqual(previewViewport(iphone, "portrait"), { width: 402, height: 874, orientation: "portrait" });
  assert.deepEqual(previewViewport(iphone, "landscape"), { width: 874, height: 402, orientation: "landscape" });
  const desktop = getPreviewDevice("desktop-responsive");
  assert.equal(previewViewport(desktop, "portrait").orientation, "landscape");
});

test("background settings are resolved independently for each preview variant", () => {
  const config = {
    preview: {
      backgrounds: {
        "iphone-16-pro__portrait": { backgroundMode: "image", backgroundImageUrl: "portrait.webp" },
        "iphone-16-pro__landscape": { backgroundMode: "image", backgroundImageUrl: "landscape.webp" },
      },
    },
  };
  assert.equal(previewVariantKey("iphone-16-pro", "portrait"), "iphone-16-pro__portrait");
  assert.equal(previewBackground(config, "iphone-16-pro", "portrait").backgroundImageUrl, "portrait.webp");
  assert.equal(previewBackground(config, "iphone-16-pro", "landscape").backgroundImageUrl, "landscape.webp");
  assert.equal(previewBackground(config, "pixel-9-pro", "portrait").backgroundImageUrl, "");
});
