import assert from "node:assert/strict";
import test from "node:test";

// parseSignatureInput is module-private, so it is exercised through the header
// parser's observable behaviour via the exported verifier's dependencies. The
// timing test below is the point of this file: the header is parsed before the
// signature is verified, on the process that also serves the AudioHook
// WebSocket, so a superlinear parse is a denial of service.

// Rebuilt here rather than imported, so the test states the shape it protects.
const attack = (segments) => `sig1=()${';k="v"'.repeat(segments)};`;

test("a hostile Signature-Input header is parsed in linear time", async () => {
  const { parseSignatureInputForTest } = await import("../lib/genesys/audiohook-auth.js");
  assert.equal(typeof parseSignatureInputForTest, "function", "export the parser for this test");

  // The regex this replaced needed 2.2s at 26 segments and quadrupled every
  // two after that. A budget this generous still fails by four orders of
  // magnitude if the exponential behaviour ever returns.
  const started = process.hrtime.bigint();
  for (const segments of [26, 40, 80, 200]) {
    assert.equal(parseSignatureInputForTest(attack(segments)), null, `${segments} segments`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 500, `parsing took ${elapsedMs.toFixed(1)}ms`);
});

test("well-formed headers still parse, and malformed ones are still refused", async () => {
  const { parseSignatureInputForTest } = await import("../lib/genesys/audiohook-auth.js");

  const parsed = parseSignatureInputForTest(
    'sig1=("@request-target" "@authority" "audiohook-session-id");created=1700000000;nonce="abc"'
  );
  assert.deepEqual(parsed.components, ["@request-target", "@authority", "audiohook-session-id"]);
  assert.equal(parsed.attributes.created, "1700000000");
  assert.equal(parsed.attributes.nonce, "abc");
  assert.equal(parsed.label, "sig1");
  // The raw parameter string is what the signature base is built from, so it
  // must survive parsing byte for byte.
  assert.equal(
    parsed.signatureParams,
    '("@request-target" "@authority" "audiohook-session-id");created=1700000000;nonce="abc"'
  );

  for (const malformed of [
    "",
    "sig1",
    "=()",
    "sig 1=()",
    'sig1=("a"',
    'sig1=("a");',
    'sig1=("a");novalue',
    'sig1=("a");=v',
    'sig1=("a") trailing',
    'sig1=("a");k="unterminated',
  ]) {
    assert.equal(parseSignatureInputForTest(malformed), null, JSON.stringify(malformed));
  }
});
