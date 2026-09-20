import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WIDGET_CONFIG } from "../lib/widgets/config.js";
import {
  assistantThinkingMessages,
  localizeWidgetConfig,
  resolveWidgetLocale,
  widgetDirection,
  widgetTranslations,
} from "../lib/widgets/locales.js";

test("widget locale resolution uses exact, base-language and English fallbacks", () => {
  assert.equal(resolveWidgetLocale("pl-PL").id, "pl-PL");
  assert.equal(resolveWidgetLocale("de-AT").id, "de-DE");
  assert.equal(resolveWidgetLocale("unknown").id, "en-US");
});

test("localizing a widget replaces every copy group without changing visual or routing settings", () => {
  const source = structuredClone(DEFAULT_WIDGET_CONFIG);
  source.content.privacyUrl = "https://example.com/privacy";
  source.theme.colors.primary = "#123456";
  source.channels.messaging.assistantId = "assistant-example";

  const localized = localizeWidgetConfig(source, "fr-FR");

  assert.equal(localized.locale, "fr-FR");
  assert.equal(localized.content.title, "Comment pouvons-nous vous aider ?");
  assert.equal(localized.components.messages.humanLabel, "Conseiller");
  assert.equal(localized.components.launcher.label, "Nous contacter");
  assert.equal(localized.engagement.headsUp.headline, "Bonjour ! 👋");
  assert.equal(localized.content.privacyUrl, "https://example.com/privacy");
  assert.equal(localized.theme.colors.primary, "#123456");
  assert.equal(localized.channels.messaging.assistantId, "assistant-example");
  assert.equal(source.locale, DEFAULT_WIDGET_CONFIG.locale);
});

test("RTL locale exposes translated runtime labels and RTL direction", () => {
  assert.equal(widgetDirection("ar-SA"), "rtl");
  assert.equal(widgetDirection("he-IL"), "rtl");
  assert.equal(widgetDirection("en-US"), "ltr");
  assert.equal(widgetTranslations("ar-SA").aria.send, "إرسال");
  assert.equal(widgetTranslations("he-IL").preview.delivered, "נמסר");
});

test("assistant thinking messages are predefined and localized", () => {
  assert.deepEqual(assistantThinkingMessages("en-US"), [
    "Thinking it through…",
    "Brewing a helpful answer…",
    "Connecting the dots…",
    "Almost there…",
  ]);
  assert.match(assistantThinkingMessages("pl-PL")[0], /Myślę/);
  assert.equal(assistantThinkingMessages("de-AT").length, 4);
  assert.equal(assistantThinkingMessages("unknown")[0], "Thinking it through…");
});
