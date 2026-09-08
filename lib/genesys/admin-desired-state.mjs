import { randomUUID } from "node:crypto";

import { installationResourceNames } from "./installation-scope.mjs";
import { normalizeTelnyxWebCallerNumber } from "./sip-transfer-tool.mjs";

import { getPostgresPool } from "../postgres.mjs";

export const ADMIN_HANDOFF_POLICY_CONTEXTS = Object.freeze([
  "audio_inbound",
  "callback_outbound",
  "web_messaging",
  "web_voice",
]);

export const ADMIN_WIDGET_CHANNELS = Object.freeze(["messaging", "voice"]);

const WIDGET_POLICY_CONTEXT_BY_CHANNEL = Object.freeze({
  messaging: "web_messaging",
  voice: "web_voice",
});

const WIDGET_PROFILE_AGGREGATE_NAME_BY_CHANNEL = Object.freeze({
  messaging: "web_messaging:default",
  voice: "web_voice:default",
});

const WIDGET_PROFILE_AGGREGATE_KIND_BY_CHANNEL = Object.freeze({
  messaging: "messaging_profile",
  voice: "voice_profile",
});

const LEGACY_COMPONENT_BY_CONTEXT = Object.freeze({
  audio_inbound: "audio",
  callback_outbound: "callbacks",
  web_messaging: "widget",
});

export const ADMIN_HANDOFF_POLICY_CONTEXT_BY_COMPONENT = Object.freeze({
  audio: "audio_inbound",
  callbacks: "callback_outbound",
  widget: "web_messaging",
});

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizedContext(value) {
  const context = String(value || "").trim().toLowerCase();
  if (!ADMIN_HANDOFF_POLICY_CONTEXTS.includes(context)) {
    throw new Error(`Unsupported handoff policy context ${value}`);
  }
  return context;
}

function normalizedWidgetChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (!ADMIN_WIDGET_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported widget channel ${value}`);
  }
  return channel;
}

function emptyWidgetChannelProfile(channel) {
  return {
    id: null,
    key: "default",
    channel,
    assistantId: "",
    assistantName: "",
    queuePolicyId: null,
    queuePolicyContext: WIDGET_POLICY_CONTEXT_BY_CHANNEL[channel],
    queueIds: [],
    defaultQueueId: "",
    config: channel === "voice" ? {
      genesysTrunkId: "",
      region: "auto",
    } : {},
    desiredRevision: 0,
    source: "empty",
    updatedAt: null,
  };
}

export function normalizeAdminWidgetChannelProfile(profile, {
  availableAssistants = [],
  availableTrunks = [],
  availableDids = [],
} = {}) {
  const channel = normalizedWidgetChannel(profile?.channel);
  if (channel === "messaging") {
    const assistantId = required(profile?.assistantId, "Telnyx assistant ID");
    const assistant = availableAssistants.find((entry) => String(entry?.id || "").trim() === assistantId);
    if (!assistant) throw new Error(`Telnyx assistant ${assistantId} is not available in the current inventory`);
    return { channel, assistantId, config: {} };
  }
  const genesysTrunkId = required(profile?.config?.genesysTrunkId, "Genesys BYOC trunk");
  const trunk = availableTrunks.find((entry) => String(entry?.id || "").trim() === genesysTrunkId);
  if (!trunk) throw new Error(`Genesys BYOC trunk ${genesysTrunkId} is not available in the current inventory`);
  if (trunk.enabled === false || trunk.compatible === false) {
    throw new Error(trunk.incompatibilityReason || `Genesys BYOC trunk ${genesysTrunkId} is not compatible with Web Calls`);
  }
  const region = String(profile?.config?.region || "auto").trim();
  const regions = ["auto", "eu", "us-east", "us-central", "us-west", "ca-central", "apac", "south-asia"];
  if (!regions.includes(region)) throw new Error(`Unsupported Web Calls media region ${region}`);
  // Profiles saved before the caller identity moved into this profile carry no
  // number; they stay saveable and Web Calls stays disabled until one is picked.
  const rawCallerNumber = String(profile?.config?.callerNumber || "").trim();
  const callerNumber = rawCallerNumber ? normalizeTelnyxWebCallerNumber(rawCallerNumber) : "";
  if (callerNumber && !availableDids.some((entry) => String(entry?.dnis || entry?.id || "").trim() === callerNumber)) {
    throw new Error(`Genesys number ${callerNumber} is not available in the current inventory`);
  }
  return {
    channel,
    config: {
      genesysTrunkId,
      region,
      callerNumber,
      keepAssistantOnCall: profile?.config?.keepAssistantOnCall === true,
    },
  };
}

export async function listAdminWidgetChannelProfiles(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const result = await getPostgresPool().query(
    `SELECT cp.id, cp.channel, cp.config, a.desired_revision, a.updated_at,
            aa.telnyx_assistant_id, aa.name AS assistant_name,
            hp.id AS queue_policy_id, hp.context AS queue_policy_context,
            q.genesys_queue_id, q.genesys_queue_name, q.is_default
     FROM integration_widget_channel_profiles cp
     JOIN integration_configuration_aggregates a ON a.id=cp.aggregate_id
     LEFT JOIN integration_ai_assistants aa ON aa.id=cp.assistant_id
     LEFT JOIN integration_handoff_policies hp ON hp.id=cp.queue_policy_id
     LEFT JOIN integration_handoff_policy_queues q ON q.policy_id=hp.id
     WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE
     ORDER BY cp.channel, q.genesys_queue_name, q.genesys_queue_id`,
    [organization]
  );
  const profiles = new Map(ADMIN_WIDGET_CHANNELS.map((channel) => [channel, emptyWidgetChannelProfile(channel)]));
  for (const row of result.rows) {
    let profile = profiles.get(row.channel);
    if (!profile?.id) {
      profile = {
        id: row.id,
        key: "default",
        channel: row.channel,
        assistantId: row.telnyx_assistant_id || "",
        assistantName: row.assistant_name || "",
        queuePolicyId: row.queue_policy_id || null,
        queuePolicyContext: row.queue_policy_context || WIDGET_POLICY_CONTEXT_BY_CHANNEL[row.channel],
        queueIds: [],
        queues: [],
        defaultQueueId: "",
        config: row.config || {},
        desiredRevision: row.desired_revision,
        source: "desired",
        updatedAt: row.updated_at,
      };
      profiles.set(row.channel, profile);
    }
    if (row.genesys_queue_id) {
      profile.queueIds.push(row.genesys_queue_id);
      profile.queues.push({ id: row.genesys_queue_id, name: row.genesys_queue_name });
      if (row.is_default) profile.defaultQueueId = row.genesys_queue_id;
    }
  }
  return ADMIN_WIDGET_CHANNELS.map((channel) => profiles.get(channel));
}

async function upsertWidgetChannelProfile(client, { actor, profile }) {
  const assistantId = profile.channel === "messaging" ? profile.assistantId : null;
  const aggregate = await client.query(
    `INSERT INTO integration_configuration_aggregates
      (id, genesys_organization_id, kind, name, enabled, desired_config,
       created_by_genesys_user_id, updated_by_genesys_user_id)
     VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6,$6)
     ON CONFLICT (genesys_organization_id, kind, name)
     DO UPDATE SET enabled=TRUE,
       desired_revision=integration_configuration_aggregates.desired_revision + 1,
       desired_config=EXCLUDED.desired_config,
       updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id,
       updated_at=NOW()
     RETURNING id`,
    [randomUUID(), actor.organizationId, WIDGET_PROFILE_AGGREGATE_KIND_BY_CHANNEL[profile.channel], WIDGET_PROFILE_AGGREGATE_NAME_BY_CHANNEL[profile.channel], JSON.stringify({
      ...(assistantId ? { assistantId } : {}),
      ...profile.config,
    }), actor.userId]
  );
  let internalAssistantId = null;
  if (assistantId) {
    const assistant = await client.query(
      `SELECT aa.id
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
       LIMIT 1`,
      [actor.organizationId, assistantId]
    );
    if (!assistant.rowCount) throw new Error(`Refresh inventory before assigning Telnyx assistant ${assistantId}`);
    internalAssistantId = assistant.rows[0].id;
  }
  const policy = await client.query(
    `SELECT p.id
     FROM integration_handoff_policies p
     JOIN integration_configuration_aggregates a ON a.id=p.aggregate_id
     WHERE a.genesys_organization_id=$1 AND p.context=$2 AND a.enabled=TRUE
     LIMIT 1`,
    [actor.organizationId, WIDGET_POLICY_CONTEXT_BY_CHANNEL[profile.channel]]
  );
  if (!policy.rowCount) {
    throw new Error(`Save the ${WIDGET_POLICY_CONTEXT_BY_CHANNEL[profile.channel]} Queue Policy before saving this channel profile`);
  }
  await client.query(
    `INSERT INTO integration_widget_channel_profiles
      (id, aggregate_id, channel, assistant_id, queue_policy_id, config)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (aggregate_id)
     DO UPDATE SET channel=EXCLUDED.channel, assistant_id=EXCLUDED.assistant_id,
       queue_policy_id=EXCLUDED.queue_policy_id, config=EXCLUDED.config, updated_at=NOW()`,
    [randomUUID(), aggregate.rows[0].id, profile.channel, internalAssistantId, policy.rows[0].id, JSON.stringify(profile.config)]
  );
}

export async function saveAdminWidgetChannelProfiles({
  actor,
  profiles,
  availableAssistants,
  availableTrunks,
  availableDids,
}) {
  const normalized = (Array.isArray(profiles) ? profiles : []).map((profile) => normalizeAdminWidgetChannelProfile(profile, {
    availableAssistants,
    availableTrunks,
    availableDids,
  }));
  const byChannel = new Map(normalized.map((profile) => [profile.channel, profile]));
  if (!byChannel.size || byChannel.size !== normalized.length) {
    throw new Error("Provide one unique Web channel profile to update");
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    for (const profile of normalized) {
      await upsertWidgetChannelProfile(client, { actor, profile });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { profiles: await listAdminWidgetChannelProfiles(actor.organizationId) };
}

export function applyAdminWidgetChannelProfiles(value, profiles = []) {
  const config = structuredClone(value || {});
  const byChannel = new Map((profiles || []).filter((profile) => profile?.source === "desired" || profile?.id).map((profile) => [profile.channel, profile]));
  const voice = byChannel.get("voice");
  const widgetAssistantId = String(
    config.channels?.messaging?.enabled
      ? config.channels.messaging.assistantId || config.channels?.voice?.assistantId || ""
      : config.channels?.voice?.assistantId || ""
  ).trim();
  if (config.channels?.messaging?.enabled) {
    if (!widgetAssistantId) {
      throw new Error("Select a Web Chat assistant in this widget before publishing it");
    }
    config.channels.messaging.assistantId = widgetAssistantId;
  }
  if (config.channels?.voice?.enabled) {
    if (!voice?.config?.genesysTrunkId) {
      throw new Error("Configure the default Web Calls profile before publishing this widget");
    }
    if (!widgetAssistantId) {
      throw new Error("Select an AI assistant in this widget before publishing it");
    }
    const widgetAssistantVersionId = String(config.channels.voice.assistantId || "").trim() === widgetAssistantId
      ? config.channels.voice.assistantVersionId || "main"
      : "main";
    config.channels.voice = {
      ...config.channels.voice,
      assistantId: widgetAssistantId,
      assistantVersionId: widgetAssistantVersionId,
      genesysTrunkId: voice.config.genesysTrunkId,
      // A managed SIP destination belongs to the published widget runtime even
      // though its concrete DID is intentionally excluded from the shared
      // Web Calls profile. Preserve it for UI-only publications; an actual
      // infrastructure synchronization replaces it from the DID allocation.
      genesysSipUri: config.channels.voice.genesysSipUriManaged !== false
        ? String(config.channels.voice.genesysSipUri || "").trim()
        : "",
      genesysSipUriManaged: true,
      keepAssistantOnCall: voice.config.keepAssistantOnCall === true,
      region: voice.config.region || "auto",
    };
  }
  return config;
}

function emptyAudioRoutingProfile() {
  return {
    id: null,
    key: "default",
    routes: [],
    desiredRevision: 0,
    source: "empty",
    updatedAt: null,
  };
}

export function normalizeAdminAudioRoutingProfile(profile, {
  availableAssistants = [],
  availableDids = [],
} = {}) {
  const assistantById = new Map(availableAssistants.map((assistant) => [String(assistant?.id || "").trim(), assistant]));
  const didByDnis = new Map(availableDids.map((did) => [String(did?.dnis || "").trim(), did]));
  const usedDnis = new Set();
  const routes = (Array.isArray(profile?.routes) ? profile.routes : []).map((route) => {
    const dnis = required(route?.dnis, "Genesys DNIS");
    if (!didByDnis.has(dnis)) throw new Error(`Genesys DNIS ${dnis} is not available in the current inventory`);
    if (usedDnis.has(dnis)) throw new Error(`Genesys DNIS ${dnis} is assigned more than once`);
    usedDnis.add(dnis);
    const assistantId = required(route?.assistantId, `Telnyx assistant for ${dnis}`);
    if (assistantId === "__managed_default__" || !assistantById.has(assistantId)) {
      throw new Error(`Telnyx assistant ${assistantId} is not available in the current inventory`);
    }
    const takeoverOwner = route?.takeoverOwner?.id ? {
      id: String(route.takeoverOwner.id),
      name: String(route.takeoverOwner.name || route.takeoverOwner.id),
      type: String(route.takeoverOwner.type || "UNKNOWN"),
    } : null;
    return {
      dnis,
      assistantId,
      assistantName: String(assistantById.get(assistantId)?.name || assistantId),
      takeover: route?.takeover === true,
      ...(takeoverOwner ? { takeoverOwner } : {}),
    };
  });
  if (!routes.length) throw new Error("Add at least one DNIS-to-assistant assignment");
  return { routes };
}

export async function getAdminAudioRoutingProfile(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const result = await getPostgresPool().query(
    `SELECT a.id AS aggregate_id, a.desired_revision, a.updated_at,
            r.dnis, r.takeover_approved, r.takeover_source,
            aa.telnyx_assistant_id, aa.name AS assistant_name
     FROM integration_configuration_aggregates a
     LEFT JOIN integration_audio_dnis_routes r ON r.aggregate_id=a.id
     LEFT JOIN integration_ai_assistants aa ON aa.id=r.assistant_id
     WHERE a.genesys_organization_id=$1 AND a.kind='audio_routing'
       AND a.name='default' AND a.enabled=TRUE
     ORDER BY r.dnis`,
    [organization]
  );
  if (!result.rowCount) return emptyAudioRoutingProfile();
  const first = result.rows[0];
  return {
    id: first.aggregate_id,
    key: "default",
    routes: result.rows.filter((row) => row.dnis).map((row) => ({
      dnis: row.dnis,
      assistantId: row.telnyx_assistant_id || "",
      assistantName: row.assistant_name || row.telnyx_assistant_id || "",
      ...(row.takeover_approved ? {
        takeover: true,
        ...(row.takeover_source?.owner?.id ? { takeoverOwner: row.takeover_source.owner } : {}),
      } : {}),
    })),
    desiredRevision: first.desired_revision,
    source: "desired",
    updatedAt: first.updated_at,
  };
}

export async function saveAdminAudioRoutingProfile({ actor, profile, availableAssistants, availableDids }) {
  const normalized = normalizeAdminAudioRoutingProfile(profile, { availableAssistants, availableDids });
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const aggregate = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id, genesys_organization_id, kind, name, enabled, desired_config,
         created_by_genesys_user_id, updated_by_genesys_user_id)
       VALUES ($1,$2,'audio_routing','default',TRUE,$3::jsonb,$4,$4)
       ON CONFLICT (genesys_organization_id, kind, name)
       DO UPDATE SET enabled=TRUE,
         desired_revision=integration_configuration_aggregates.desired_revision + 1,
         desired_config=EXCLUDED.desired_config,
         updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id,
         updated_at=NOW()
       RETURNING id`,
      [randomUUID(), actor.organizationId, JSON.stringify(normalized), actor.userId]
    );
    const aggregateId = aggregate.rows[0].id;
    const assistantRows = await client.query(
      `SELECT aa.id, aa.telnyx_assistant_id
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=ANY($2::text[])`,
      [actor.organizationId, [...new Set(normalized.routes.map((route) => route.assistantId))]]
    );
    const assistantIds = new Map(assistantRows.rows.map((row) => [row.telnyx_assistant_id, row.id]));
    const missingAssistant = normalized.routes.find((route) => !assistantIds.has(route.assistantId));
    if (missingAssistant) throw new Error(`Refresh inventory before assigning Telnyx assistant ${missingAssistant.assistantId}`);
    await client.query(`DELETE FROM integration_audio_dnis_routes WHERE aggregate_id=$1`, [aggregateId]);
    for (const route of normalized.routes) {
      await client.query(
        `INSERT INTO integration_audio_dnis_routes
          (id, aggregate_id, dnis, assistant_id, takeover_approved, takeover_source)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [randomUUID(), aggregateId, route.dnis, assistantIds.get(route.assistantId), route.takeover === true,
          JSON.stringify(route.takeoverOwner ? { owner: route.takeoverOwner } : {})]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { profile: await getAdminAudioRoutingProfile(actor.organizationId) };
}

export function applyAdminAudioRoutingProfile(value, profile) {
  if (!profile?.id || profile.source !== "desired" || !profile.routes?.length) {
    throw new Error("Configure the default Audio DNIS routing profile before building this deployment plan");
  }
  return {
    ...(value || {}),
    routes: structuredClone(profile.routes),
    createDefaultAssistant: false,
    assistantName: "",
    assistantUseCase: "",
    assistantInstructions: "",
    assistantGreeting: "",
    assistantContentGenerated: false,
  };
}

function emptyCallbackCampaignProfile() {
  const installationName = installationResourceNames().installationName;
  return {
    id: null,
    key: "default",
    assistantId: "",
    assistantName: "",
    queuePolicyId: null,
    queuePolicyContext: "callback_outbound",
    queueIds: [],
    queues: [],
    defaultQueueId: "",
    callerAddress: "",
    callerName: installationName,
    siteId: "",
    wrapupCodeId: "",
    desiredRevision: 0,
    source: "empty",
    updatedAt: null,
  };
}

export function normalizeAdminCallbackCampaignProfile(profile, {
  availableAssistants = [],
  availableDids = [],
  availableSites = [],
  availableWrapupCodes = [],
} = {}) {
  const installationName = installationResourceNames().installationName;
  const assistantId = required(profile?.assistantId, "Telnyx assistant ID");
  if (!availableAssistants.some((entry) => String(entry?.id || "").trim() === assistantId)) {
    throw new Error(`Telnyx assistant ${assistantId} is not available in the current inventory`);
  }
  const callerAddress = required(profile?.callerAddress, "Outbound caller ID");
  if (!/^\+[1-9]\d{7,14}$/.test(callerAddress)) {
    throw new Error("Outbound caller ID must be an E.164 number");
  }
  if (!availableDids.some((entry) => String(entry?.dnis || entry?.id || "").trim() === callerAddress)) {
    throw new Error(`Genesys number ${callerAddress} is not available in the current inventory`);
  }
  const siteId = required(profile?.siteId, "Genesys Site");
  if (!availableSites.some((entry) => String(entry?.id || "").trim() === siteId)) {
    throw new Error(`Genesys Site ${siteId} is not available in the current inventory`);
  }
  const wrapupCodeId = required(profile?.wrapupCodeId, "Default wrap-up code");
  if (!availableWrapupCodes.some((entry) => String(entry?.id || "").trim() === wrapupCodeId)) {
    throw new Error(`Genesys wrap-up code ${wrapupCodeId} is not available in the current inventory`);
  }
  const callerName = String(profile?.callerName || installationName).trim() || installationName;
  if (callerName.length > 100) throw new Error("Caller name must contain at most 100 characters");
  return { assistantId, callerAddress, callerName, siteId, wrapupCodeId };
}

export async function getAdminCallbackCampaignProfile(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const result = await getPostgresPool().query(
    `SELECT cc.id, cc.caller_address, cc.caller_name, cc.genesys_site_id,
            cc.genesys_wrapup_code_id, a.desired_revision, a.updated_at,
            aa.telnyx_assistant_id, aa.name AS assistant_name,
            hp.id AS queue_policy_id, hp.context AS queue_policy_context,
            q.genesys_queue_id, q.genesys_queue_name, q.is_default
     FROM integration_callback_campaigns cc
     JOIN integration_configuration_aggregates a ON a.id=cc.aggregate_id
     LEFT JOIN integration_ai_assistants aa ON aa.id=cc.assistant_id
     LEFT JOIN integration_handoff_policies hp ON hp.id=cc.queue_policy_id
     LEFT JOIN integration_handoff_policy_queues q ON q.policy_id=hp.id
     WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE
     ORDER BY q.genesys_queue_name, q.genesys_queue_id`,
    [organization]
  );
  if (!result.rowCount) return emptyCallbackCampaignProfile();
  const first = result.rows[0];
  const profile = {
    id: first.id,
    key: "default",
    assistantId: first.telnyx_assistant_id || "",
    assistantName: first.assistant_name || "",
    queuePolicyId: first.queue_policy_id || null,
    queuePolicyContext: first.queue_policy_context || "callback_outbound",
    queueIds: [],
    queues: [],
    defaultQueueId: "",
    callerAddress: first.caller_address,
    callerName: first.caller_name,
    siteId: first.genesys_site_id,
    wrapupCodeId: first.genesys_wrapup_code_id,
    desiredRevision: first.desired_revision,
    source: "desired",
    updatedAt: first.updated_at,
  };
  for (const row of result.rows) {
    if (!row.genesys_queue_id) continue;
    profile.queueIds.push(row.genesys_queue_id);
    profile.queues.push({ id: row.genesys_queue_id, name: row.genesys_queue_name });
    if (row.is_default) profile.defaultQueueId = row.genesys_queue_id;
  }
  return profile;
}

export async function saveAdminCallbackCampaignProfile({
  actor,
  profile,
  availableAssistants,
  availableDids,
  availableSites,
  availableWrapupCodes,
}) {
  const normalized = normalizeAdminCallbackCampaignProfile(profile, {
    availableAssistants,
    availableDids,
    availableSites,
    availableWrapupCodes,
  });
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const assistant = await client.query(
      `SELECT aa.id
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
       LIMIT 1`,
      [actor.organizationId, normalized.assistantId]
    );
    if (!assistant.rowCount) throw new Error(`Refresh inventory before assigning Telnyx assistant ${normalized.assistantId}`);
    const policy = await client.query(
      `SELECT p.id, COUNT(q.genesys_queue_id)::integer AS queue_count,
              COALESCE(BOOL_OR(q.is_default), FALSE) AS has_default
       FROM integration_handoff_policies p
       JOIN integration_configuration_aggregates a ON a.id=p.aggregate_id
       LEFT JOIN integration_handoff_policy_queues q ON q.policy_id=p.id
       WHERE a.genesys_organization_id=$1 AND p.context='callback_outbound' AND a.enabled=TRUE
       GROUP BY p.id
       LIMIT 1`,
      [actor.organizationId]
    );
    if (!policy.rowCount || !policy.rows[0].queue_count || !policy.rows[0].has_default) {
      throw new Error("Save a complete callback_outbound Queue Policy before saving the callback campaign profile");
    }
    const aggregate = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id, genesys_organization_id, kind, name, enabled, desired_config,
         created_by_genesys_user_id, updated_by_genesys_user_id)
       VALUES ($1,$2,'callback_campaign','default',TRUE,$3::jsonb,$4,$4)
       ON CONFLICT (genesys_organization_id, kind, name)
       DO UPDATE SET enabled=TRUE,
         desired_revision=integration_configuration_aggregates.desired_revision + 1,
         desired_config=EXCLUDED.desired_config,
         updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id,
         updated_at=NOW()
       RETURNING id`,
      [randomUUID(), actor.organizationId, JSON.stringify(normalized), actor.userId]
    );
    await client.query(
      `INSERT INTO integration_callback_campaigns
        (id, aggregate_id, assistant_id, queue_policy_id, caller_address,
         caller_name, genesys_site_id, genesys_wrapup_code_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (aggregate_id)
       DO UPDATE SET assistant_id=EXCLUDED.assistant_id,
         queue_policy_id=EXCLUDED.queue_policy_id,
         caller_address=EXCLUDED.caller_address, caller_name=EXCLUDED.caller_name,
         genesys_site_id=EXCLUDED.genesys_site_id,
         genesys_wrapup_code_id=EXCLUDED.genesys_wrapup_code_id,
         updated_at=NOW()`,
      [randomUUID(), aggregate.rows[0].id, assistant.rows[0].id, policy.rows[0].id,
        normalized.callerAddress, normalized.callerName, normalized.siteId, normalized.wrapupCodeId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { profile: await getAdminCallbackCampaignProfile(actor.organizationId) };
}

export function applyAdminCallbackCampaignProfile(value, profile) {
  if (!profile?.id || profile.source !== "desired") {
    throw new Error("Configure the default Callback Campaign profile before building this deployment plan");
  }
  if (!profile.queueIds?.length || !profile.defaultQueueId) {
    throw new Error("Configure the callback_outbound Queue Policy before building this deployment plan");
  }
  return {
    ...(value || {}),
    applicationName: installationResourceNames().installationName,
    deploymentId: "CALLBACKS",
    queueIds: [...profile.queueIds],
    defaultQueueId: profile.defaultQueueId,
    assistantId: profile.assistantId,
    createAssistant: false,
    assistantName: "",
    assistantUseCase: "",
    assistantInstructions: "",
    assistantGreeting: "",
    assistantContentGenerated: false,
    callerAddress: profile.callerAddress,
    callerName: profile.callerName,
    siteId: profile.siteId,
    wrapupCodeId: profile.wrapupCodeId,
  };
}

export async function registerAdminCallbackCampaignObservedResources({ organizationId, result }) {
  const organization = required(organizationId, "Genesys organization ID");
  const resources = [
    ["contact_list", result?.contactList],
    ["architect_outbound_flow", result?.flow],
    ["contact_list_filter", result?.contactListFilter],
    ["call_analysis_response_set", result?.responseSet],
    ["outbound_campaign", result?.campaign],
  ].filter(([, resource]) => String(resource?.id || "").trim());
  if (!resources.length) throw new Error("Callback deployment returned no observable Genesys resources");
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const aggregate = await client.query(
      `SELECT a.id
       FROM integration_configuration_aggregates a
       JOIN integration_callback_campaigns cc ON cc.aggregate_id=a.id
       WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE
       LIMIT 1`,
      [organization]
    );
    if (!aggregate.rowCount) throw new Error("Callback campaign desired-state aggregate is unavailable");
    const aggregateId = aggregate.rows[0].id;
    const resourceIds = new Map();
    for (const [resourceType, resource] of resources) {
      const observed = JSON.stringify(resource);
      const saved = await client.query(
        `INSERT INTO integration_managed_resources
          (id, aggregate_id, provider, resource_type, remote_id, display_name,
           observed_hash, status, observed_config, last_observed_at,
           logical_key, scope_type, scope_id, ownership)
         VALUES ($1,$2,'genesys',$3,$4,$5,md5($6),'healthy',$6::jsonb,NOW(),
           $3,'installation','callbacks','managed')
         ON CONFLICT (provider, remote_id)
         DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
           resource_type=EXCLUDED.resource_type, display_name=EXCLUDED.display_name,
           observed_hash=EXCLUDED.observed_hash, status='healthy',
           observed_config=EXCLUDED.observed_config,
           logical_key=EXCLUDED.logical_key, scope_type=EXCLUDED.scope_type,
           scope_id=EXCLUDED.scope_id, ownership='managed', deleted_at=NULL,
           updated_at=NOW(), last_observed_at=NOW()
         RETURNING id`,
        [randomUUID(), aggregateId, resourceType, String(resource.id).trim(), String(resource.name || resource.id).trim(), observed]
      );
      resourceIds.set(resourceType, saved.rows[0].id);
    }
    await client.query(
      `DELETE FROM integration_resource_dependencies
       WHERE resource_id IN (
         SELECT id FROM integration_managed_resources WHERE aggregate_id=$1
       )`,
      [aggregateId]
    );
    const assistantResource = await client.query(
      `SELECT id FROM integration_managed_resources
       WHERE provider='telnyx' AND remote_id=$1 AND resource_type='ai_assistant'
       LIMIT 1`,
      [String(result?.assistant?.id || "").trim()]
    );
    const dependencies = [
      ["outbound_campaign", "contact_list", "uses_contact_list"],
      ["outbound_campaign", "call_analysis_response_set", "uses_response_set"],
      ["contact_list_filter", "contact_list", "filters_contact_list"],
      ["call_analysis_response_set", "architect_outbound_flow", "transfers_to_flow"],
    ];
    for (const [source, target, relationship] of dependencies) {
      if (!resourceIds.has(source) || !resourceIds.has(target)) continue;
      await client.query(
        `INSERT INTO integration_resource_dependencies
          (resource_id, depends_on_resource_id, relationship)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [resourceIds.get(source), resourceIds.get(target), relationship]
      );
    }
    if (resourceIds.has("architect_outbound_flow") && assistantResource.rowCount) {
      await client.query(
        `INSERT INTO integration_resource_dependencies
          (resource_id, depends_on_resource_id, relationship)
         VALUES ($1,$2,'routes_to_assistant')
         ON CONFLICT DO NOTHING`,
        [resourceIds.get("architect_outbound_flow"), assistantResource.rows[0].id]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return resources.length;
}

export async function registerAdminAudioObservedResources({ organizationId, result, config = {} }) {
  const organization = required(organizationId, "Genesys organization ID");
  const observed = result?.run?.resources || {};
  const defaultName = installationResourceNames().installationName;
  const applicationName = String(config.applicationName || defaultName).trim() || defaultName;
  const connectorResources = [
    ["audio_connector", observed.audioConnectorIntegrationId, applicationName],
    ["interaction_widget", observed.widgetId, applicationName],
    ["architect_script", observed.scriptId, applicationName],
  ].filter(([, remoteId]) => String(remoteId || "").trim());
  const routingResources = [
    ["architect_inbound_flow", observed.flowId, applicationName],
    ["inbound_call_route", observed.callRouteId, applicationName],
  ].filter(([, remoteId]) => String(remoteId || "").trim());
  if (!connectorResources.length || !routingResources.length) {
    throw new Error("Audio deployment returned incomplete observable Genesys resources");
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const connectorAggregate = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id, genesys_organization_id, kind, name, enabled, desired_config)
       VALUES ($1,$2,'audio_connector','default',TRUE,$3::jsonb)
       ON CONFLICT (genesys_organization_id, kind, name)
       DO UPDATE SET enabled=TRUE, desired_config=EXCLUDED.desired_config, updated_at=NOW()
       RETURNING id`,
      [randomUUID(), organization, JSON.stringify({
        deploymentId: String(config.deploymentId || "CECA32"),
        applicationName,
      })]
    );
    const routingAggregate = await client.query(
      `SELECT id FROM integration_configuration_aggregates
       WHERE genesys_organization_id=$1 AND kind='audio_routing'
         AND name='default' AND enabled=TRUE
       LIMIT 1`,
      [organization]
    );
    if (!routingAggregate.rowCount) throw new Error("Audio routing desired-state aggregate is unavailable");
    const connectorAggregateId = connectorAggregate.rows[0].id;
    const routingAggregateId = routingAggregate.rows[0].id;
    const resourceIds = new Map();
    const saveResource = async (aggregateId, resourceType, remoteId, displayName) => {
      const snapshot = JSON.stringify({ id: String(remoteId), name: displayName });
      const saved = await client.query(
        `INSERT INTO integration_managed_resources
          (id, aggregate_id, provider, resource_type, remote_id, display_name,
           observed_hash, status, observed_config, metadata, last_observed_at,
           logical_key, scope_type, scope_id, ownership)
         VALUES ($1,$2,'genesys',$3,$4,$5,md5($6),'healthy',$6::jsonb,
           '{"source":"deployment"}'::jsonb,NOW(),$3,'installation','audio','managed')
         ON CONFLICT (provider, remote_id)
         DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
           resource_type=EXCLUDED.resource_type, display_name=EXCLUDED.display_name,
           observed_hash=EXCLUDED.observed_hash, status='healthy',
           observed_config=EXCLUDED.observed_config,
           metadata=integration_managed_resources.metadata || EXCLUDED.metadata,
           updated_at=NOW(), last_observed_at=NOW(),
           logical_key=EXCLUDED.logical_key, scope_type=EXCLUDED.scope_type,
           scope_id=EXCLUDED.scope_id, ownership='managed', deleted_at=NULL
         RETURNING id`,
        [randomUUID(), aggregateId, resourceType, String(remoteId), displayName, snapshot]
      );
      resourceIds.set(resourceType, saved.rows[0].id);
    };
    for (const [resourceType, remoteId, displayName] of connectorResources) {
      await saveResource(connectorAggregateId, resourceType, remoteId, displayName);
    }
    for (const [resourceType, remoteId, displayName] of routingResources) {
      await saveResource(routingAggregateId, resourceType, remoteId, displayName);
    }
    const activeResourceIds = [...resourceIds.values()];
    await client.query(
      `UPDATE integration_managed_resources
       SET status='retired', deleted_at=NOW(),
           metadata=metadata || $3::jsonb, updated_at=NOW()
       WHERE aggregate_id=ANY($1::uuid[])
         AND NOT (id=ANY($2::uuid[]))
         AND status <> 'retired'`,
      [
        [connectorAggregateId, routingAggregateId],
        activeResourceIds,
        JSON.stringify({ source: "deployment", retiredReason: "superseded_by_audio_deployment" }),
      ]
    );
    await client.query(
      `DELETE FROM integration_resource_dependencies
       WHERE resource_id IN (
         SELECT id FROM integration_managed_resources
         WHERE aggregate_id=ANY($1::uuid[])
       ) OR depends_on_resource_id IN (
         SELECT id FROM integration_managed_resources
         WHERE aggregate_id=ANY($1::uuid[])
       )`,
      [[connectorAggregateId, routingAggregateId]]
    );
    const dependencies = [
      ["architect_inbound_flow", "audio_connector", "invokes_connector"],
      ["inbound_call_route", "architect_inbound_flow", "routes_to_flow"],
      ["interaction_widget", "architect_script", "uses_script"],
    ];
    for (const [source, target, relationship] of dependencies) {
      if (!resourceIds.has(source) || !resourceIds.has(target)) continue;
      await client.query(
        `INSERT INTO integration_resource_dependencies
          (resource_id, depends_on_resource_id, relationship)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [resourceIds.get(source), resourceIds.get(target), relationship]
      );
    }
    const assistantIds = [...new Set((observed.assistantIds || [])
      .map((id) => String(id || "").trim()).filter(Boolean))];
    if (resourceIds.has("architect_inbound_flow") && assistantIds.length) {
      const assistants = await client.query(
        `SELECT id FROM integration_managed_resources
         WHERE provider='telnyx' AND resource_type='ai_assistant'
           AND remote_id=ANY($1::text[])`,
        [assistantIds]
      );
      for (const assistant of assistants.rows) {
        await client.query(
          `INSERT INTO integration_resource_dependencies
            (resource_id, depends_on_resource_id, relationship)
           VALUES ($1,$2,'routes_to_assistant')
           ON CONFLICT DO NOTHING`,
          [resourceIds.get("architect_inbound_flow"), assistant.id]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return connectorResources.length + routingResources.length;
}

export function normalizeAdminHandoffPolicy(policy, availableQueues = []) {
  const context = normalizedContext(policy?.context);
  const queueById = new Map((availableQueues || []).map((queue) => [
    required(queue.id, "Genesys queue ID"),
    required(queue.name, "Genesys queue name"),
  ]));
  const queueIds = [...new Set((Array.isArray(policy?.queueIds) ? policy.queueIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
  const unknownQueue = queueIds.find((id) => !queueById.has(id));
  if (unknownQueue) throw new Error(`Genesys queue ${unknownQueue} is not available in the current inventory`);
  const defaultQueueId = String(policy?.defaultQueueId || "").trim();
  if (queueIds.length && !defaultQueueId) {
    throw new Error(`Select a default Genesys queue for ${context}`);
  }
  if (defaultQueueId && !queueIds.includes(defaultQueueId)) {
    throw new Error(`Default Genesys queue for ${context} must belong to its allowlist`);
  }
  return {
    context,
    queueIds,
    defaultQueueId,
    queues: queueIds.map((id) => ({ id, name: queueById.get(id) })),
  };
}

function emptyPolicy(context) {
  return {
    id: null,
    context,
    queueIds: [],
    defaultQueueId: "",
    queues: [],
    desiredRevision: 0,
    source: "empty",
    updatedAt: null,
  };
}

export async function listAdminHandoffPolicies(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const [desired, legacy] = await Promise.all([
    getPostgresPool().query(
      `SELECT p.id, p.context, a.desired_revision, a.updated_at,
              q.genesys_queue_id, q.genesys_queue_name, q.is_default
       FROM integration_handoff_policies p
       JOIN integration_configuration_aggregates a ON a.id=p.aggregate_id
       LEFT JOIN integration_handoff_policy_queues q ON q.policy_id=p.id
       WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE
       ORDER BY p.context, q.genesys_queue_name, q.genesys_queue_id`,
      [organization]
    ),
    getPostgresPool().query(
      `SELECT component, config, updated_at
       FROM integration_deployment_profiles
       WHERE genesys_organization_id=$1 AND component IN ('audio','callbacks','widget')`,
      [organization]
    ),
  ]);
  const policies = new Map(ADMIN_HANDOFF_POLICY_CONTEXTS.map((context) => [context, emptyPolicy(context)]));
  for (const row of desired.rows) {
    let policy = policies.get(row.context);
    if (!policy?.id) {
      policy = {
        id: row.id,
        context: row.context,
        queueIds: [],
        defaultQueueId: "",
        queues: [],
        desiredRevision: row.desired_revision,
        source: "desired",
        updatedAt: row.updated_at,
      };
      policies.set(row.context, policy);
    }
    if (row.genesys_queue_id) {
      policy.queueIds.push(row.genesys_queue_id);
      policy.queues.push({ id: row.genesys_queue_id, name: row.genesys_queue_name });
      if (row.is_default) policy.defaultQueueId = row.genesys_queue_id;
    }
  }
  const legacyByComponent = new Map(legacy.rows.map((row) => [row.component, row]));
  for (const context of ADMIN_HANDOFF_POLICY_CONTEXTS) {
    if (policies.get(context).source === "desired") continue;
    const legacyComponent = LEGACY_COMPONENT_BY_CONTEXT[context];
    const row = legacyByComponent.get(legacyComponent);
    if (!row) continue;
    const config = row.config || {};
    const names = new Map((config.allowedQueues || []).map((queue) => [queue.id, queue.name]));
    const queueIds = [...new Set((config.queueIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    policies.set(context, {
      id: null,
      context,
      queueIds,
      defaultQueueId: queueIds.includes(config.defaultQueueId) ? config.defaultQueueId : "",
      queues: queueIds.map((id) => ({ id, name: names.get(id) || id })),
      desiredRevision: 0,
      source: "legacy",
      updatedAt: row.updated_at,
    });
  }
  return ADMIN_HANDOFF_POLICY_CONTEXTS.map((context) => policies.get(context));
}

async function upsertPolicyAggregate(client, { actor, policy }) {
  const aggregate = await client.query(
    `INSERT INTO integration_configuration_aggregates
      (id, genesys_organization_id, kind, name, enabled, desired_config,
       created_by_genesys_user_id, updated_by_genesys_user_id)
     VALUES ($1,$2,'queue_policy',$3,TRUE,$4::jsonb,$5,$5)
     ON CONFLICT (genesys_organization_id, kind, name)
     DO UPDATE SET enabled=TRUE,
       desired_revision=integration_configuration_aggregates.desired_revision + 1,
       desired_config=EXCLUDED.desired_config,
       updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id,
       updated_at=NOW()
     RETURNING id`,
    [randomUUID(), actor.organizationId, policy.context, JSON.stringify({
      queueIds: policy.queueIds,
      defaultQueueId: policy.defaultQueueId,
    }), actor.userId]
  );
  const aggregateId = aggregate.rows[0].id;
  const savedPolicy = await client.query(
    `INSERT INTO integration_handoff_policies
      (id, aggregate_id, context, name)
     VALUES ($1,$2,$3,$3)
     ON CONFLICT (aggregate_id)
     DO UPDATE SET context=EXCLUDED.context, name=EXCLUDED.name, updated_at=NOW()
     RETURNING id`,
    [randomUUID(), aggregateId, policy.context]
  );
  const policyId = savedPolicy.rows[0].id;
  await client.query(`DELETE FROM integration_handoff_policy_queues WHERE policy_id=$1`, [policyId]);
  for (const queue of policy.queues) {
    await client.query(
      `INSERT INTO integration_handoff_policy_queues
        (policy_id, genesys_queue_id, genesys_queue_name, is_default)
       VALUES ($1,$2,$3,$4)`,
      [policyId, queue.id, queue.name, queue.id === policy.defaultQueueId]
    );
  }
}

export async function saveAdminHandoffPolicies({ actor, policies, availableQueues }) {
  const seen = new Set();
  const normalized = (Array.isArray(policies) ? policies : []).map((policy) => {
    const value = normalizeAdminHandoffPolicy(policy, availableQueues);
    if (seen.has(value.context)) throw new Error(`Duplicate handoff policy context ${value.context}`);
    seen.add(value.context);
    return value;
  });
  if (!normalized.length) throw new Error("Provide at least one handoff policy");
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    for (const policy of normalized) {
      await upsertPolicyAggregate(client, { actor, policy });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    policies: await listAdminHandoffPolicies(actor.organizationId),
  };
}

export async function resolveAdminComponentDesiredState({ organizationId, component, config }) {
  const context = ADMIN_HANDOFF_POLICY_CONTEXT_BY_COMPONENT[component];
  if (!context) return { ...(config || {}) };
  const policy = (await listAdminHandoffPolicies(organizationId))
    .find((entry) => entry.context === context);
  if (!policy?.queueIds?.length || !policy.defaultQueueId) {
    throw new Error(`Configure and save the ${context} Queue Policy before building this deployment plan`);
  }
  const withPolicy = {
    ...(config || {}),
    queueIds: policy.queueIds,
    defaultQueueId: policy.defaultQueueId,
  };
  if (component === "audio") {
    return applyAdminAudioRoutingProfile(
      withPolicy,
      await getAdminAudioRoutingProfile(organizationId)
    );
  }
  if (component !== "callbacks") return withPolicy;
  return applyAdminCallbackCampaignProfile(
    withPolicy,
    await getAdminCallbackCampaignProfile(organizationId)
  );
}

export async function syncAdminAssistantInventory({ organizationId, assistants }) {
  const organization = required(organizationId, "Genesys organization ID");
  const observed = (Array.isArray(assistants) ? assistants : [])
    .map((assistant) => ({
      id: String(assistant?.id || "").trim(),
      name: String(assistant?.name || assistant?.id || "").trim(),
    }))
    .filter((assistant) => assistant.id && assistant.name);
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE integration_managed_resources r
       SET status='missing', updated_at=NOW(), last_observed_at=NOW()
       FROM integration_configuration_aggregates a
       WHERE r.aggregate_id=a.id AND a.genesys_organization_id=$1
         AND a.kind='assistant' AND r.provider='telnyx'
         AND r.resource_type='ai_assistant' AND r.status <> 'retired'`,
      [organization]
    );
    for (const assistant of observed) {
      const aggregate = await client.query(
        `INSERT INTO integration_configuration_aggregates
          (id, genesys_organization_id, kind, name, enabled, desired_config)
         VALUES ($1,$2,'assistant',$3,TRUE,$4::jsonb)
         ON CONFLICT (genesys_organization_id, kind, name)
         DO UPDATE SET enabled=TRUE, updated_at=NOW()
         RETURNING id`,
        [randomUUID(), organization, `telnyx:${assistant.id}`, JSON.stringify({ remoteId: assistant.id })]
      );
      const aggregateId = aggregate.rows[0].id;
      await client.query(
        `INSERT INTO integration_ai_assistants
          (id, aggregate_id, telnyx_assistant_id, ownership, name)
         VALUES ($1,$2,$3,'external',$4)
         ON CONFLICT (telnyx_assistant_id)
         DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()`,
        [randomUUID(), aggregateId, assistant.id, assistant.name]
      );
      await client.query(
        `INSERT INTO integration_managed_resources
          (id, aggregate_id, provider, resource_type, remote_id, display_name,
           status, observed_config, last_observed_at, ownership, logical_key,
           scope_type, scope_id)
         VALUES ($1,$2,'telnyx','ai_assistant',$3,$4,'healthy',$5::jsonb,NOW(),
           'external','assistant','installation',$3)
         ON CONFLICT (provider, remote_id)
         DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
           resource_type=EXCLUDED.resource_type, display_name=EXCLUDED.display_name,
           status='healthy', observed_config=EXCLUDED.observed_config,
           ownership=CASE
             WHEN integration_managed_resources.ownership='managed' THEN 'managed'
             ELSE 'external'
           END,
           logical_key=COALESCE(integration_managed_resources.logical_key, EXCLUDED.logical_key),
           scope_type=COALESCE(integration_managed_resources.scope_type, EXCLUDED.scope_type),
           scope_id=COALESCE(integration_managed_resources.scope_id, EXCLUDED.scope_id),
           updated_at=NOW(), last_observed_at=NOW()`,
        [randomUUID(), aggregateId, assistant.id, assistant.name, JSON.stringify(assistant)]
      );
    }
    const stale = await client.query(
      `SELECT aa.telnyx_assistant_id
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       WHERE a.genesys_organization_id=$1
         AND NOT (aa.telnyx_assistant_id = ANY($2::text[]))`,
      [organization, observed.map((assistant) => assistant.id)]
    );
    const removed = [];
    for (const row of stale.rows) {
      const result = await removeAdminAssistantWithClient(client, {
        organizationId: organization,
        telnyxAssistantId: row.telnyx_assistant_id,
      });
      if (result.removed) removed.push(result);
    }
    await client.query("COMMIT");
    return { observed: observed.length, removed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeAdminAssistantWithClient(client, {
  organizationId,
  telnyxAssistantId,
}) {
  const assistant = await client.query(
    `SELECT aa.id, aa.aggregate_id
     FROM integration_ai_assistants aa
     JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
     WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
     LIMIT 1`,
    [organizationId, telnyxAssistantId]
  );
  if (!assistant.rowCount) {
    return { removed: false, telnyxAssistantId };
  }
  const { id: assistantId, aggregate_id: aggregateId } = assistant.rows[0];
  const audioAggregates = await client.query(
    `SELECT DISTINCT aggregate_id
     FROM integration_audio_dnis_routes
     WHERE assistant_id=$1`,
    [assistantId]
  );
  const callbackAndChannelAggregates = await client.query(
    `SELECT aggregate_id FROM integration_callback_campaigns WHERE assistant_id=$1
     UNION
     SELECT aggregate_id FROM integration_widget_channel_profiles WHERE assistant_id=$1`,
    [assistantId]
  );
  const routes = await client.query(
    `DELETE FROM integration_audio_dnis_routes
     WHERE assistant_id=$1
     RETURNING id`,
    [assistantId]
  );
  for (const row of audioAggregates.rows) {
    await client.query(
      `UPDATE integration_configuration_aggregates
       SET desired_config=jsonb_set(
             COALESCE(desired_config, '{}'::jsonb),
             '{routes}',
             COALESCE((
               SELECT jsonb_agg(route)
               FROM jsonb_array_elements(COALESCE(desired_config->'routes', '[]'::jsonb)) route
               WHERE route->>'assistantId' IS DISTINCT FROM $2
             ), '[]'::jsonb),
             TRUE
           ),
           desired_revision=desired_revision + 1,
           updated_at=NOW()
       WHERE id=$1`,
      [row.aggregate_id, telnyxAssistantId]
    );
  }
  const callbacks = await client.query(
    `UPDATE integration_callback_campaigns
     SET assistant_id=NULL, updated_at=NOW()
     WHERE assistant_id=$1
     RETURNING id`,
    [assistantId]
  );
  const channels = await client.query(
    `UPDATE integration_widget_channel_profiles
     SET assistant_id=NULL, updated_at=NOW()
     WHERE assistant_id=$1
     RETURNING id`,
    [assistantId]
  );
  if (callbackAndChannelAggregates.rowCount) {
    await client.query(
      `UPDATE integration_configuration_aggregates
       SET desired_config=COALESCE(desired_config, '{}'::jsonb) - 'assistantId',
           desired_revision=desired_revision + 1,
           updated_at=NOW()
       WHERE id=ANY($1::uuid[])`,
      [callbackAndChannelAggregates.rows.map((row) => row.aggregate_id)]
    );
  }
  const assignments = await client.query(
    `DELETE FROM integration_ai_tool_assignments
     WHERE remote_assistant_id=$1
     RETURNING id`,
    [telnyxAssistantId]
  );
  await client.query(
    `DELETE FROM integration_configuration_aggregates
     WHERE id=$1`,
    [aggregateId]
  );
  return {
    removed: true,
    telnyxAssistantId,
    removedRoutes: routes.rowCount,
    clearedCallbacks: callbacks.rowCount,
    clearedChannels: channels.rowCount,
    removedToolAssignments: assignments.rowCount,
  };
}

export async function removeAdminAssistantMissingFromProvider({
  organizationId,
  telnyxAssistantId,
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const assistantId = required(telnyxAssistantId, "Telnyx assistant ID");
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await removeAdminAssistantWithClient(client, {
      organizationId: organization,
      telnyxAssistantId: assistantId,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function mergeAdminInventoryAssistant(inventory, assistant) {
  const assistantId = required(assistant?.id, "Telnyx assistant ID");
  const name = required(assistant?.name, "Telnyx assistant name");
  const currentInventory = inventory && typeof inventory === "object" && !Array.isArray(inventory)
    ? inventory
    : {};
  const previous = (currentInventory.telnyxAssistants || []).find(
    (entry) => String(entry?.id || "").trim() === assistantId
  );
  const createdAt = String(assistant?.created_at || assistant?.createdAt || "").trim() || null;
  const inventoryAssistant = {
    id: assistantId,
    name,
    audioConnector: previous?.audioConnector === true,
    versions: Array.isArray(previous?.versions) && previous.versions.length
      ? previous.versions
      : [{ id: "main", name: "Main / current", createdAt }],
  };
  return {
    ...currentInventory,
    telnyxAssistants: [
      ...(currentInventory.telnyxAssistants || []).filter(
        (entry) => String(entry?.id || "").trim() !== assistantId
      ),
      inventoryAssistant,
    ].sort((left, right) => String(left?.name || "").localeCompare(String(right?.name || ""))),
  };
}

export async function registerAdminManagedAssistant({ actor, assistant, desiredConfig }) {
  const assistantId = required(assistant?.id, "Telnyx assistant ID");
  const name = required(assistant?.name, "Telnyx assistant name");
  let inventoryAssistant = mergeAdminInventoryAssistant({}, assistant).telnyxAssistants[0];
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const aggregate = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id, genesys_organization_id, kind, name, enabled, desired_config,
         created_by_genesys_user_id, updated_by_genesys_user_id)
       VALUES ($1,$2,'assistant',$3,TRUE,$4::jsonb,$5,$5)
       ON CONFLICT (genesys_organization_id, kind, name)
       DO UPDATE SET enabled=TRUE,
         desired_revision=integration_configuration_aggregates.desired_revision + 1,
         desired_config=EXCLUDED.desired_config,
         updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id,
         updated_at=NOW()
       RETURNING id`,
      [randomUUID(), actor.organizationId, `telnyx:${assistantId}`, JSON.stringify(desiredConfig || {}), actor.userId]
    );
    const aggregateId = aggregate.rows[0].id;
    await client.query(
      `INSERT INTO integration_ai_assistants
        (id, aggregate_id, telnyx_assistant_id, ownership, name, desired_config)
       VALUES ($1,$2,$3,'managed',$4,$5::jsonb)
       ON CONFLICT (telnyx_assistant_id)
       DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id, ownership='managed',
         name=EXCLUDED.name, desired_config=EXCLUDED.desired_config, updated_at=NOW()`,
      [randomUUID(), aggregateId, assistantId, name, JSON.stringify(desiredConfig || {})]
    );
    await client.query(
      `INSERT INTO integration_managed_resources
        (id, aggregate_id, provider, resource_type, remote_id, display_name,
         status, desired_hash, observed_hash, observed_config, last_observed_at,
         ownership, logical_key, scope_type, scope_id)
       VALUES ($1,$2,'telnyx','ai_assistant',$3,$4,'healthy',md5($5),md5($5),$5::jsonb,NOW(),
         'managed','assistant','installation',$3)
       ON CONFLICT (provider, remote_id)
       DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id, display_name=EXCLUDED.display_name,
         status='healthy', desired_hash=EXCLUDED.desired_hash,
         observed_hash=EXCLUDED.observed_hash,
         observed_config=EXCLUDED.observed_config, ownership='managed',
         logical_key='assistant', scope_type='installation', scope_id=EXCLUDED.scope_id,
         updated_at=NOW(), last_observed_at=NOW()`,
      [randomUUID(), aggregateId, assistantId, name, JSON.stringify(desiredConfig || {})]
    );
    const cached = await client.query(
      `SELECT inventory
       FROM integration_inventory_snapshots
       WHERE genesys_organization_id=$1
       FOR UPDATE`,
      [actor.organizationId]
    );
    if (cached.rowCount) {
      const nextInventory = mergeAdminInventoryAssistant(cached.rows[0].inventory, assistant);
      inventoryAssistant = nextInventory.telnyxAssistants.find((entry) => entry.id === assistantId);
      await client.query(
        `UPDATE integration_inventory_snapshots
         SET inventory=$2::jsonb, refreshed_at=NOW()
         WHERE genesys_organization_id=$1`,
        [actor.organizationId, JSON.stringify(nextInventory)]
      );
    }
    await client.query("COMMIT");
    return inventoryAssistant;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdminAssistantCatalog(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const [assistants, assignments] = await Promise.all([
    getPostgresPool().query(
      `SELECT aa.id, aa.telnyx_assistant_id, aa.ownership, aa.name,
              aa.desired_config, a.desired_revision, a.enabled,
              r.status, r.last_observed_at,
              EXISTS (
                SELECT 1 FROM integration_audio_dnis_routes dr
                WHERE dr.assistant_id=aa.id
              ) AS has_dnis_route,
              EXISTS (
                SELECT 1 FROM integration_ai_tool_assignments ta
                JOIN integration_ai_tool_definitions td ON td.id=ta.tool_definition_id
                JOIN integration_configuration_aggregates tda ON tda.id=td.aggregate_id
                WHERE ta.remote_assistant_id=aa.telnyx_assistant_id
                  AND ta.status='active' AND td.status NOT IN ('retired', 'missing')
                  AND tda.genesys_organization_id=$1 AND tda.enabled=TRUE
              ) AS has_active_tool_assignment
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       LEFT JOIN integration_managed_resources r ON r.aggregate_id=a.id
         AND r.provider='telnyx' AND r.resource_type='ai_assistant'
       WHERE a.genesys_organization_id=$1
         AND (r.status IS NULL OR r.status <> 'missing')
       ORDER BY LOWER(aa.name), aa.telnyx_assistant_id`,
      [organization]
    ),
    getPostgresPool().query(
      `SELECT ma.remote_assistant_id AS assistant_id,
              t.id, t.logical_key, t.display_name, t.remote_tool_id,
              ma.component, ma.deployment_id
       FROM integration_ai_tool_assignments ma
       JOIN integration_ai_tool_definitions t ON t.id=ma.tool_definition_id
       JOIN integration_configuration_aggregates a ON a.id=t.aggregate_id
       WHERE a.genesys_organization_id=$1
         AND ma.status='active' AND t.status NOT IN ('retired', 'missing')
       ORDER BY t.logical_key, ma.component, ma.deployment_id`,
      [organization]
    ),
  ]);
  const toolsByAssistant = new Map();
  for (const row of assignments.rows) {
    const entries = toolsByAssistant.get(row.assistant_id) || [];
    entries.push({
      id: row.id,
      logicalKey: row.logical_key,
      displayName: row.display_name,
      remoteToolId: row.remote_tool_id,
      component: row.component,
      deploymentId: row.deployment_id,
    });
    toolsByAssistant.set(row.assistant_id, entries);
  }
  return assistants.rows.map((row) => ({
    id: row.id,
    telnyxAssistantId: row.telnyx_assistant_id,
    name: row.name,
    ownership: row.ownership,
    desiredConfig: row.desired_config || {},
    desiredRevision: row.desired_revision,
    enabled: row.enabled,
    status: row.status || "unknown",
    lastObservedAt: row.last_observed_at,
    managed: row.ownership === "managed" || row.has_dnis_route || row.has_active_tool_assignment,
    managementReasons: [
      row.ownership === "managed" && "created_by_admin",
      row.has_dnis_route && "dnis_route",
      row.has_active_tool_assignment && "managed_tool",
    ].filter(Boolean),
    tools: toolsByAssistant.get(row.telnyx_assistant_id) || [],
  }));
}

export async function getAdminAssistantUsage(organizationId, telnyxAssistantId) {
  const organization = required(organizationId, "Genesys organization ID");
  const assistantId = required(telnyxAssistantId, "Telnyx assistant ID");
  const result = await getPostgresPool().query(
    `SELECT aa.id,
            COALESCE((
              SELECT jsonb_agg(DISTINCT dr.dnis ORDER BY dr.dnis)
              FROM integration_audio_dnis_routes dr
              WHERE dr.assistant_id=aa.id
            ), '[]'::jsonb) AS dnis,
            EXISTS (
              SELECT 1 FROM integration_callback_campaigns cc
              JOIN integration_configuration_aggregates ca ON ca.id=cc.aggregate_id
              WHERE cc.assistant_id=aa.id AND ca.genesys_organization_id=$1 AND ca.enabled=TRUE
            ) AS callback_campaign,
            COALESCE((
              SELECT jsonb_agg(DISTINCT wp.channel ORDER BY wp.channel)
              FROM integration_widget_channel_profiles wp
              JOIN integration_configuration_aggregates wa ON wa.id=wp.aggregate_id
              WHERE wp.assistant_id=aa.id AND wa.genesys_organization_id=$1 AND wa.enabled=TRUE
            ), '[]'::jsonb) AS web_channels
     FROM integration_ai_assistants aa
     JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
     WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
     LIMIT 1`,
    [organization, assistantId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    dnis: row.dnis || [],
    callbackCampaign: row.callback_campaign === true,
    webChannels: row.web_channels || [],
  };
}

export async function saveAdminManagedAssistantConfiguration({
  actor,
  telnyxAssistantId,
  assistant,
  managedToolIds,
  instructionSections,
  insightGroupId = null,
  bundleFingerprint = null,
}) {
  const assistantId = required(telnyxAssistantId, "Telnyx assistant ID");
  const observed = {
    name: String(assistant?.name || assistantId),
    instructions: String(assistant?.instructions || ""),
    managedToolIds: [...new Set(managedToolIds || [])].sort(),
    instructionSections: instructionSections || [],
  };
  const result = await getPostgresPool().query(
    `WITH target AS (
       SELECT aa.id, aa.aggregate_id, aa.desired_config
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
       WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
       LIMIT 1
     ), updated_assistant AS (
       UPDATE integration_ai_assistants aa
       SET name=$3,
           desired_config=COALESCE(aa.desired_config, '{}'::jsonb) || $4::jsonb,
           updated_at=NOW()
       FROM target
       WHERE aa.id=target.id
       RETURNING aa.aggregate_id, aa.desired_config
     ), updated_aggregate AS (
       UPDATE integration_configuration_aggregates a
       SET desired_config=COALESCE(a.desired_config, '{}'::jsonb) || $4::jsonb,
           desired_revision=CASE
             WHEN COALESCE(a.desired_config, '{}'::jsonb) || $4::jsonb IS DISTINCT FROM a.desired_config
             THEN a.desired_revision + 1 ELSE a.desired_revision
           END,
           updated_by_genesys_user_id=$5, updated_at=NOW()
       FROM updated_assistant ua
       WHERE a.id=ua.aggregate_id
       RETURNING a.id
     )
     UPDATE integration_managed_resources r
     SET display_name=$3, desired_hash=md5($6), observed_hash=md5($6),
         observed_config=$6::jsonb, status='healthy', updated_at=NOW(), last_observed_at=NOW()
     FROM updated_aggregate a
     WHERE r.aggregate_id=a.id AND r.provider='telnyx' AND r.resource_type='ai_assistant'
     RETURNING r.id`,
    [
      actor.organizationId,
      assistantId,
      observed.name,
      JSON.stringify({
        managedToolIds: observed.managedToolIds,
        managedInstructionSections: instructionSections || [],
        managedInsightGroupId: insightGroupId || null,
        managedBundleFingerprint: bundleFingerprint || null,
        managedPrivacySettings: {
          dataRetention: true,
          piiRedaction: "disabled",
        },
      }),
      actor.userId,
      JSON.stringify(observed),
    ]
  );
  if (!result.rowCount) throw new Error("Managed AI assistant was not found");
  return observed;
}
