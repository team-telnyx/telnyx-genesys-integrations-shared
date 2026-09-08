export function collectGenesysRoleIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectGenesysRoleIds(item, result);
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["roleid", "role_id"].includes(key.toLowerCase())
    ) {
      result.add(child);
    }
    if (key.toLowerCase() === "role" && child && typeof child === "object") {
      if (typeof child.id === "string") result.add(child.id);
    }
    collectGenesysRoleIds(child, result);
  }
  return result;
}
