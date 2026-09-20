import assert from "node:assert/strict";
import test from "node:test";
import { collectGenesysRoleIds } from "../lib/genesys/admin-role-utils.mjs";

test("Genesys widget admin authorization extracts roles from subject grants", () => {
  const ids = collectGenesysRoleIds({
    grants: [
      { role: { id: "role-from-object", name: "Widget Admin" } },
      { roleId: "role-from-field", division: { id: "home" } },
    ],
  });
  assert.deepEqual([...ids].sort(), ["role-from-field", "role-from-object"]);
});
