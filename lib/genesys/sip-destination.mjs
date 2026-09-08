import { buildGenesysSipUri, normalizeGenesysDid } from "./sip-uri.mjs";

export {
  buildGenesysSipUri,
  genesysTrunkRequiresSecureMedia,
  genesysTrunkTransport,
  normalizeGenesysDid,
  normalizeGenesysSipUri,
} from "./sip-uri.mjs";

const LEGACY_BYOC_DOMAINS = Object.freeze({
  "mypurecloud.com": "byoc.use1.pure.cloud",
  "usw2.pure.cloud": "byoc.usw2.pure.cloud",
  "cac1.pure.cloud": "byoc.cac1.pure.cloud",
  "sae1.pure.cloud": "byoc.sae1.pure.cloud",
  "mypurecloud.ie": "byoc.mypurecloud.ie",
  "mypurecloud.de": "byoc.mypurecloud.de",
  "euw2.pure.cloud": "byoc.euw2.pure.cloud",
  "euc2.pure.cloud": "byoc.euc2.pure.cloud",
  "edee1.eusc-pure.cloud": "voice.edee1.eusc-genesys.cloud",
  "mypurecloud.jp": "byoc.mypurecloud.jp",
  "apne2.pure.cloud": "byoc.apne2.pure.cloud",
  "apne3.pure.cloud": "byoc.apne3.pure.cloud",
  "mypurecloud.com.au": "byoc.mypurecloud.com.au",
  "aps1.pure.cloud": "byoc.aps1.pure.cloud",
  "apse1.pure.cloud": "byoc.apse1.pure.cloud",
  "mec1.pure.cloud": "byoc.mec1.pure.cloud",
  "use2.us-gov-pure.cloud": "byoc.use2.us-gov-pure.cloud",
  "mxc1.pure.cloud": "byoc.mxc1.genesys.cloud",
});

const DYNAMIC_BYOC_DOMAINS = Object.freeze({
  "mypurecloud.com": "byoc.use1.genesys.cloud",
  "usw2.pure.cloud": "byoc.usw2.genesys.cloud",
  "cac1.pure.cloud": "byoc.cac1.genesys.cloud",
  "sae1.pure.cloud": "byoc.sae1.genesys.cloud",
  "mypurecloud.ie": "byoc.euw1.genesys.cloud",
  "mypurecloud.de": "byoc.euc1.genesys.cloud",
  "euw2.pure.cloud": "byoc.euw2.genesys.cloud",
  "euc2.pure.cloud": "byoc.euc2.genesys.cloud",
  "edee1.eusc-pure.cloud": "byoc.edee1.eusc-genesys.cloud",
  "mypurecloud.jp": "byoc.apne1.genesys.cloud",
  "apne2.pure.cloud": "byoc.apne2.genesys.cloud",
  "apne3.pure.cloud": "byoc.apne3.genesys.cloud",
  "mypurecloud.com.au": "byoc.apse2.genesys.cloud",
  "aps1.pure.cloud": "byoc.aps1.genesys.cloud",
  "apse1.pure.cloud": "byoc.apse1.genesys.cloud",
  "mec1.pure.cloud": "byoc.mec1.genesys.cloud",
  "use2.us-gov-pure.cloud": "byoc.use2.us-gov-genesys.cloud",
  "mxc1.pure.cloud": "byoc.mxc1.genesys.cloud",
});

function normalizedEnvironment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^api\./, "")
    .replace(/\/$/, "");
}

export function genesysPropertyValue(properties, name) {
  const property = properties?.[name];
  if (property == null) return undefined;
  if (property?.value && Object.hasOwn(property.value, "instance")) {
    return property.value.instance;
  }
  if (Object.hasOwn(property, "instance")) return property.instance;
  return property;
}

export function genesysByocDomain(environment, { dynamicCloudVoice = false } = {}) {
  const key = normalizedEnvironment(environment);
  const domain = (dynamicCloudVoice ? DYNAMIC_BYOC_DOMAINS : LEGACY_BYOC_DOMAINS)[key];
  if (!domain) {
    throw new Error(
      `Genesys BYOC domain mapping is not available for ${environment}; use the advanced custom SIP URI option`
    );
  }
  return domain;
}

async function listPages(getPage, label) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await getPage(pageNumber);
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error(`${label} pagination exceeded 100 pages`);
}

function isByocExternalTrunkBase(entry) {
  const metabase = `${entry?.trunkMetabase?.id || ""} ${entry?.trunkMetabase?.name || ""}`;
  return entry?.trunkType === "EXTERNAL" && /byoc/i.test(metabase);
}

function describeTrunkBase(entry, environment) {
  const terminationIdentifier = String(
    genesysPropertyValue(entry.properties, "trunk_sip_termination_uri") || ""
  ).trim();
  if (!terminationIdentifier) return null;
  const enabled = genesysPropertyValue(entry.properties, "trunk_enabled") !== false;
  const dynamicCloudVoice = genesysPropertyValue(
    entry.properties,
    "trunk_routing_outbound_higher_capacity"
  ) === true;
  const byocDomain = genesysByocDomain(environment, { dynamicCloudVoice });
  const fqdn = `${terminationIdentifier}.${byocDomain}`.toLowerCase();
  return {
    id: entry.id,
    name: entry.name,
    trunkType: entry.trunkType,
    trunkMetabase: entry.trunkMetabase
      ? { id: entry.trunkMetabase.id, name: entry.trunkMetabase.name }
      : null,
    enabled,
    managed: entry.managed === true,
    terminationIdentifier,
    dynamicCloudVoice,
    platform: dynamicCloudVoice ? "dynamic-cloud-voice" : "legacy-byoc-cloud",
    byocDomain,
    fqdn,
    transport: String(
      genesysPropertyValue(entry.properties, "trunk_transport_protocolVariant") || ""
    ).toLowerCase(),
    routingAddress: String(
      genesysPropertyValue(entry.properties, "trunk_sip_routingAddress") || ""
    ),
    dnisReplacementEnabled: genesysPropertyValue(
      entry.properties,
      "trunk_routing_inbound_dnis_enabled"
    ) === true,
  };
}

function ivrFlows(ivr) {
  return [
    ["open", ivr.openHoursFlow],
    ["closed", ivr.closedHoursFlow],
    ["holiday", ivr.holidayHoursFlow],
  ].filter(([, flow]) => flow?.id).map(([schedule, flow]) => ({
    schedule,
    id: flow.id,
    name: flow.name,
  }));
}

function sameDnis(left, right) {
  try {
    return normalizeGenesysDid(left) === normalizeGenesysDid(right);
  } catch {
    return false;
  }
}

function describeDestination(did, ivrs) {
  if (did.ownerType !== "IVR_CONFIG") return null;
  let phoneNumber;
  try {
    phoneNumber = normalizeGenesysDid(did.phoneNumber);
  } catch {
    return null;
  }
  const ivr = ivrs.find((entry) => entry.id === did.owner?.id) || ivrs.find(
    (entry) => (entry.dnis || []).some((dnis) => sameDnis(dnis, phoneNumber))
  );
  if (!ivr) return null;
  const flows = ivrFlows(ivr);
  if (!flows.length) return null;
  return {
    id: did.id || phoneNumber,
    phoneNumber,
    ownerType: did.ownerType,
    didPool: did.didPool ? { id: did.didPool.id, name: did.didPool.name } : null,
    route: {
      id: ivr.id,
      name: ivr.name,
      flows,
      scheduleGroup: ivr.scheduleGroup
        ? { id: ivr.scheduleGroup.id, name: ivr.scheduleGroup.name }
        : null,
    },
  };
}

export async function loadGenesysSipInventory({ telephonyApi, architectApi, environment }) {
  if (!telephonyApi || !architectApi) {
    throw new Error("Genesys Telephony and Architect APIs are required to discover SIP destinations");
  }
  const [trunkBases, dids, ivrs] = await Promise.all([
    listPages(
      (pageNumber) => telephonyApi.getTelephonyProvidersEdgesTrunkbasesettings({
        pageNumber,
        pageSize: 100,
        ignoreHidden: false,
      }),
      "Genesys trunk base settings"
    ),
    listPages(
      (pageNumber) => telephonyApi.getTelephonyProvidersEdgesDids({
        pageNumber,
        pageSize: 100,
        sortBy: "phoneNumber",
        sortOrder: "ASC",
      }),
      "Genesys DID inventory"
    ),
    listPages(
      (pageNumber) => architectApi.getArchitectIvrs({
        pageNumber,
        pageSize: 100,
        sortBy: "name",
        sortOrder: "ASC",
        expand: ["dnis"],
      }),
      "Genesys inbound call routes"
    ),
  ]);
  const trunks = trunkBases
    .filter(isByocExternalTrunkBase)
    .map((entry) => describeTrunkBase(entry, environment))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  const destinations = dids
    .map((did) => describeDestination(did, ivrs))
    .filter(Boolean)
    .sort((left, right) => left.phoneNumber.localeCompare(right.phoneNumber));
  return { trunks, destinations };
}

export async function loadGenesysDidPools(telephonyApi) {
  if (!telephonyApi) throw new Error("Genesys Telephony API is required to load DID pools");
  return listPages(
    (pageNumber) => telephonyApi.getTelephonyProvidersEdgesDidpools({
      pageNumber,
      pageSize: 100,
      sortBy: "startPhoneNumber",
      sortOrder: "ASC",
    }),
    "Genesys DID pools"
  );
}

export function resolveGenesysByocTrunk(inventory, trunkId) {
  const trunk = inventory.trunks.find((entry) => entry.id === trunkId);
  if (!trunk) throw new Error(`Genesys BYOC trunk ${trunkId || "(missing)"} was not found`);
  if (!trunk.enabled) throw new Error(`Genesys BYOC trunk ${trunk.name} is out of service`);
  if (trunk.dnisReplacementEnabled) {
    throw new Error(
      `Genesys BYOC trunk ${trunk.name} uses DNIS Replacement Routing; use the advanced custom SIP URI option`
    );
  }
  if (trunk.routingAddress && trunk.routingAddress !== "Request-URI") {
    throw new Error(
      `Genesys BYOC trunk ${trunk.name} routes on ${trunk.routingAddress}; Request-URI routing is required for an automatically generated SIP target`
    );
  }
  return trunk;
}

export function resolveGenesysSipDestination(inventory, { trunkId, did }) {
  const trunk = resolveGenesysByocTrunk(inventory, trunkId);
  const requestedDid = normalizeGenesysDid(did);
  const destination = inventory.destinations.find(
    (entry) => entry.phoneNumber === requestedDid || entry.id === did
  );
  if (!destination) {
    throw new Error(`Genesys inbound call destination ${did || "(missing)"} was not found`);
  }
  return {
    mode: "genesys-inventory",
    trunk,
    destination,
    genesysSipUri: buildGenesysSipUri({
      did: destination.phoneNumber,
      fqdn: trunk.fqdn,
      transport: trunk.transport,
    }),
  };
}
