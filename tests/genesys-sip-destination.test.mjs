import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGenesysSipUri,
  genesysByocDomain,
  genesysPropertyValue,
  loadGenesysSipInventory,
  resolveGenesysSipDestination,
} from "../lib/genesys/sip-destination.mjs";

function property(instance) {
  return { value: { instance } };
}

function inventoryApis({ dnisReplacementEnabled = false } = {}) {
  return {
    telephonyApi: {
      async getTelephonyProvidersEdgesTrunkbasesettings() {
        return {
          entities: [
            {
              id: "trunk-byoc",
              name: "BYOC",
              trunkType: "EXTERNAL",
              managed: false,
              trunkMetabase: {
                id: "external_sip_pcv_byoc_carrier.json",
                name: "Generic BYOC Carrier",
              },
              properties: {
                trunk_enabled: property(true),
                trunk_sip_termination_uri: property("telnyx"),
                trunk_transport_protocolVariant: property("tls"),
                trunk_sip_routingAddress: property("Request-URI"),
                trunk_routing_inbound_dnis_enabled: property(dnisReplacementEnabled),
                trunk_routing_outbound_higher_capacity: property(false),
              },
            },
            {
              id: "phone-trunk",
              name: "WebRTC phones",
              trunkType: "PHONE",
              trunkMetabase: { id: "phone_connections_webrtc.json", name: "WebRTC" },
              properties: {},
            },
          ],
        };
      },
      async getTelephonyProvidersEdgesDids() {
        return {
          entities: [
            {
              id: "did-route",
              phoneNumber: "+48123123050",
              ownerType: "IVR_CONFIG",
              owner: { id: "ivr-sales", name: "Sales Queue" },
              didPool: { id: "pool-1", name: "Poland" },
            },
            {
              id: "did-user",
              phoneNumber: "+48123123020",
              ownerType: "USER",
              owner: { id: "user-1", name: "Example User" },
            },
          ],
        };
      },
    },
    architectApi: {
      async getArchitectIvrs() {
        return {
          entities: [
            {
              id: "ivr-sales",
              name: "Sales Queue",
              dnis: ["+48123123050"],
              openHoursFlow: { id: "flow-sales", name: "Transfer from AI Assistants" },
            },
          ],
        };
      },
    },
  };
}

test("Genesys BYOC destination builds the UI FQDN and complete SIP URI", async () => {
  const apis = inventoryApis();
  const inventory = await loadGenesysSipInventory({
    ...apis,
    environment: "usw2.pure.cloud",
  });
  assert.equal(inventory.trunks.length, 1);
  assert.equal(inventory.trunks[0].fqdn, "telnyx.byoc.usw2.pure.cloud");
  assert.equal(inventory.trunks[0].transport, "tls");
  assert.deepEqual(inventory.destinations.map(({ phoneNumber }) => phoneNumber), [
    "+48123123050",
  ]);
  const result = resolveGenesysSipDestination(inventory, {
    trunkId: "trunk-byoc",
    did: "+48123123050",
  });
  // This fixture's trunk terminates over TLS, so the published URI has to ask
  // Telnyx for SRTP media; without it the Genesys Edge answers SIP 488.
  assert.equal(
    result.genesysSipUri,
    "sip:+48123123050@telnyx.byoc.usw2.pure.cloud;secure=srtp"
  );
  assert.equal(result.destination.route.name, "Sales Queue");
  assert.equal(result.destination.route.flows[0].name, "Transfer from AI Assistants");
});

test("Genesys BYOC domain mapping distinguishes legacy and Dynamic Cloud Voice", () => {
  assert.equal(genesysByocDomain("api.usw2.pure.cloud"), "byoc.usw2.pure.cloud");
  assert.equal(
    genesysByocDomain("usw2.pure.cloud", { dynamicCloudVoice: true }),
    "byoc.usw2.genesys.cloud"
  );
  assert.equal(genesysByocDomain("mypurecloud.ie"), "byoc.mypurecloud.ie");
});

test("automatic SIP discovery refuses DNIS replacement routing", async () => {
  const inventory = await loadGenesysSipInventory({
    ...inventoryApis({ dnisReplacementEnabled: true }),
    environment: "usw2.pure.cloud",
  });
  assert.throws(
    () => resolveGenesysSipDestination(inventory, {
      trunkId: "trunk-byoc",
      did: "+48123123050",
    }),
    /DNIS Replacement Routing/
  );
});

test("SIP discovery primitives validate property shape, E.164 and FQDN", () => {
  assert.equal(genesysPropertyValue({ example: property("value") }, "example"), "value");
  assert.equal(
    buildGenesysSipUri({ did: "+48 12 312 30 50", fqdn: "Telnyx.BYOC.USW2.Pure.Cloud" }),
    "sip:+48123123050@telnyx.byoc.usw2.pure.cloud"
  );
  assert.throws(
    () => buildGenesysSipUri({ did: "2050", fqdn: "telnyx.byoc.usw2.pure.cloud" }),
    /E\.164/
  );
});
