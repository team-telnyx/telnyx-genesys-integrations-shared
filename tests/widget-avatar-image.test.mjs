import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isRenderableAvatarImage } from "../lib/widgets/avatar-image.js";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("an avatar image must be an absolute https or blob URL", () => {
  for (const allowed of [
    "https://cdn.example.test/agent.png",
    "blob:https://widget.example.test/8f2c",
  ]) {
    assert.equal(isRenderableAvatarImage(allowed), true, allowed);
  }

  for (const blocked of [
    "http://cdn.example.test/agent.png",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    // Would otherwise be resolved against a base into https://evil.test.
    "//evil.test/agent.png",
    "/agent.png",
    "agent.png",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(isRenderableAvatarImage(blocked), false, JSON.stringify(blocked));
  }
});

test("both widget avatars check the URL before rendering it", async () => {
  // lib/widgets/config.js refuses a stored non-https avatar, but these
  // components take their spec from whoever renders them, so the check belongs
  // at the point of use as well.
  for (const path of ["components/widget/WidgetFrame.jsx", "components/widget/VoiceWidgetRuntime.jsx"]) {
    const text = await source(path);
    assert.match(text, /isRenderableAvatarImage\(spec\.value\)/, path);
  }
});

test("the campaign template substitution compiles no caller-supplied pattern", async () => {
  const text = await source("app/api/campaign/start/route.js");
  // Comments are stripped first. A previous version of this assertion matched
  // the comment that explains what was replaced, which is a test reporting on
  // its own documentation rather than on the code.
  const code = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Column names arrive in the request body; a value like `(.*)*` must not
  // become a regular expression.
  assert.doesNotMatch(code, /new RegExp\(/, "campaign route builds a RegExp again");
  assert.match(code, /message\.split\(`\{\{\$\{column\}\}\}`\)\.join\(/);
  // And console.* must not take a caller value as its format string.
  assert.doesNotMatch(code, /console\.error\(`[^`]*\$\{campaignType\}/);
});
