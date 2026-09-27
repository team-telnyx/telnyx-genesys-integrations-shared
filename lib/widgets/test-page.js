// Shared by the widget test page and the host page it frames.
export const WIDGET_TEST_CONTEXT_KEY = "genesys.widgetTest.context";

// Shown until the user stores a context of their own (an emptied field stays empty).
export const WIDGET_TEST_DEFAULT_CONTEXT = JSON.stringify({
  first_name: "Anna",
  last_name: "Kowalska",
  company: "Example Company",
  phone_number: "+12025550123",
  email: "anna.kowalska@example.com",
}, null, 2);

export function storedWidgetTestContext(storage) {
  try {
    const value = storage.getItem(WIDGET_TEST_CONTEXT_KEY);
    return value === null ? WIDGET_TEST_DEFAULT_CONTEXT : value;
  } catch {
    return WIDGET_TEST_DEFAULT_CONTEXT;
  }
}

// The host context accepts flat scalar values only, like window.TelnyxWidget.setContext.
export function parseWidgetTestContext(text) {
  const source = String(text || "").trim();
  if (!source) return { context: {}, error: null };
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { context: null, error: "Context is not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { context: null, error: "Context must be a JSON object" };
  const entries = Object.entries(value);
  if (entries.length > 100) return { context: null, error: "Context can contain at most 100 values" };
  if (entries.some(([key]) => key.length > 120 || ["__proto__", "constructor", "prototype"].includes(key)))
    return { context: null, error: "Context contains an unsupported key" };
  if (entries.some(([, item]) => typeof item === "string" && item.length > 1000))
    return { context: null, error: "Context text values must be at most 1000 characters" };
  const nested = Object.keys(value).find((key) => value[key] !== null && typeof value[key] === "object");
  if (nested) return { context: null, error: `"${nested}" must be a text, number or boolean value` };
  return { context: value, error: null };
}
