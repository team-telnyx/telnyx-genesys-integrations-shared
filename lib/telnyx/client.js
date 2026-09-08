/**
 * Telnyx API Client
 * Using direct API calls for better compatibility
 */

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Send SMS/MMS message via Telnyx API
 * @param {Object} params - Message parameters
 * @param {string} params.from - Sender phone number or alphanumeric ID
 * @param {string} params.to - Recipient phone number
 * @param {string} params.text - Message text
 * @param {string} params.messaging_profile_id - Telnyx messaging profile ID
 * @param {Array<string>} params.tags - Optional tags (for tracking)
 * @param {Array<string>} params.media_urls - Optional media URLs for MMS
 */
export async function sendMessage({
  from,
  to,
  text,
  messaging_profile_id,
  tags = [],
  media_urls = [],
}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY not configured");
  }

  const payload = {
    from,
    to,
    text,
    messaging_profile_id: messaging_profile_id || process.env.TELNYX_MESSAGING_PROFILE_ID,
  };

  if (tags.length > 0) {
    payload.tags = tags;
  }

  if (media_urls.length > 0) {
    payload.media_urls = media_urls;
  }

  const response = await fetch(`${TELNYX_API_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    const errorMsg = result.errors?.[0]?.detail || result.error || "Failed to send message";
    console.error("Error sending SMS:", errorMsg);
    throw new Error(errorMsg);
  }

  console.log("✓ SMS sent:", result.data.id);
  return result;
}

/**
 * Perform number lookup via Telnyx API
 * @param {string} phoneNumber - Phone number to lookup (E.164 format)
 * @param {Object} options - Lookup options
 * @param {boolean} options.carrier - Include carrier data
 * @param {boolean} options.caller_name - Include caller name (CNAM)
 */
export async function numberLookup(phoneNumber, { carrier = true, caller_name = false } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY not configured");
  }

  const types = [];
  if (carrier) types.push("carrier");
  if (caller_name) types.push("caller-name");

  const params = new URLSearchParams({ type: types.join(",") });
  
  const response = await fetch(
    `${TELNYX_API_BASE}/number_lookup/${encodeURIComponent(phoneNumber)}?${params}`,
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    }
  );

  const result = await response.json();

  if (!response.ok) {
    const errorMsg = result.errors?.[0]?.detail || result.error || "Lookup failed";
    throw new Error(errorMsg);
  }

  return result;
}

/**
 * Verify a Telnyx Ed25519 webhook signature. Throws when verification fails.
 */
export async function verifyWebhookSignature(
  payload,
  signature,
  timestamp,
  publicKey = process.env.TELNYX_PUBLIC_KEY
) {
  const { verifyTelnyxWebhookSignature } = await import("./webhooks.mjs");
  return verifyTelnyxWebhookSignature({ payload, signature, timestamp, publicKey });
}
