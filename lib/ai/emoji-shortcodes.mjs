import { nameToEmoji } from "gemoji";

const EMOJI_SHORTCODE_PATTERN = /:([+\-\w]+):/g;

export function renderEmojiShortcodes(value) {
  const text = String(value ?? "");
  if (!text.includes(":")) return text;
  return text.replace(
    EMOJI_SHORTCODE_PATTERN,
    (shortcode, name) => nameToEmoji[name] || shortcode
  );
}
