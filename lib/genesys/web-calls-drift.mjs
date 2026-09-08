import { buildGenesysSipUri, genesysTrunkTransport } from "./sip-uri.mjs";

// Saving the Web Calls profile only records desired state. Each published widget
// keeps the routing it was published with until it is republished, because the
// synthetic DID and SIP URI belong to the widget, not to the profile. Comparing
// the two is what lets the page say so instead of showing a stale URI silently.

function sipUriDid(sipUri) {
  const match = String(sipUri || "").match(/^sips?:(\+[1-9]\d{6,14})@/i);
  return match ? match[1] : null;
}

function changed(label, from, to) {
  return from === to ? null : { label, from: from || "—", to: to || "—" };
}

export function webCallDeploymentDrift(deployment, { voiceProfile, trunks = [] } = {}) {
  const config = deployment?.config || {};
  if (!config.voiceEnabled) return { needsRepublish: false, reasons: [], expectedSipUri: null };

  const desiredTrunkId = voiceProfile?.config?.genesysTrunkId || "";
  const desiredRegion = voiceProfile?.config?.region || "";
  // Switching this rebuilds which Telnyx tools the assistant carries, so it is a
  // republish just like a routing change even though no SIP URI moves.
  const handoffMode = (keep) => (keep ? "Invite + Skip Turn" : "SIP Transfer");
  const desiredKeepOnCall = voiceProfile?.config?.keepAssistantOnCall === true;
  const trunk = trunks.find(({ id }) => id === desiredTrunkId) || null;

  // The DID stays with the widget across republishes, so the expected URI is the
  // current number carried onto the desired trunk.
  const did = sipUriDid(config.genesysSipUri);
  let expectedSipUri = null;
  if (did && trunk?.fqdn) {
    try {
      expectedSipUri = buildGenesysSipUri({ did, fqdn: trunk.fqdn, transport: trunk.transport });
    } catch {
      expectedSipUri = null;
    }
  }

  const reasons = [
    changed("SIP URI", config.genesysSipUri, expectedSipUri || config.genesysSipUri),
    changed("Trunk", config.genesysTrunkId, desiredTrunkId || config.genesysTrunkId),
    changed("Media region", config.voiceRegion, desiredRegion || config.voiceRegion),
    changed("Handoff", handoffMode(config.keepAssistantOnCall === true), handoffMode(desiredKeepOnCall)),
  ].filter(Boolean);

  return {
    needsRepublish: reasons.length > 0,
    reasons,
    expectedSipUri,
    trunkTransport: genesysTrunkTransport(trunk),
    trunkName: trunk?.name || null,
  };
}

export function webCallDeploymentsNeedingRepublish(deployments = [], options = {}) {
  return deployments
    .map((deployment) => ({ deployment, drift: webCallDeploymentDrift(deployment, options) }))
    .filter(({ drift }) => drift.needsRepublish);
}
