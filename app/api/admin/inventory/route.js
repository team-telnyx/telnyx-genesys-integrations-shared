import { NextResponse } from "next/server";
import Telnyx from "telnyx";

import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { loadAdminConsoleGenesysContext } from "@/lib/genesys/admin-console-installer.mjs";
import {
  buildAudioDeploymentInventory,
  buildTtsDeploymentInventory,
  buildWebChatInfrastructureInventory,
  buildWidgetDeploymentInventory,
  listAllGenesysDids,
  listConfiguredGenesysDnis,
  loadAudioAgentExperienceInventory,
  loadAudioArchitectFlowInventory,
} from "@/lib/genesys/admin-inventory.mjs";
import { listAllOpenMessagingIntegrations } from "@/lib/genesys/widget-installer-resources.mjs";
import { loadTtsInventory } from "@/lib/genesys/tts-connector-genesys.mjs";
import {
  GENESYS_TTS_CONNECTOR_TYPE,
  verifiedTtsConnectorProfiles,
} from "@/lib/genesys/tts-connector-profiles.mjs";
import { genesysTtsTestFlowName } from "@/lib/genesys/tts-connector-architect.mjs";
import {
  loadGenesysSipInventory,
  resolveGenesysByocTrunk,
} from "@/lib/genesys/sip-destination.mjs";
import { listWidgets } from "@/lib/widgets/store";
import {
  getLatestSuccessfulAdminDeploymentResult,
  listAdminComponentConfigs,
  saveAdminInventoryCache,
} from "@/lib/genesys/admin-console-store.mjs";
import {
  listAdminManagedTools,
  reconcileAdminManagedToolsWithProvider,
  syncAdminManagedToolsToDesiredState,
} from "@/lib/genesys/admin-managed-tools.mjs";
import {
  finishAdminInventorySync,
  startAdminInventorySync,
  syncAdminDashboardObservedInventory,
} from "@/lib/genesys/admin-dashboard.mjs";
import {
  getAdminCallbackCampaignProfile,
  getAdminAudioRoutingProfile,
  listAdminHandoffPolicies,
  listAdminWidgetChannelProfiles,
  syncAdminAssistantInventory,
} from "@/lib/genesys/admin-desired-state.mjs";
import { callbackContactListRecordCounts } from "@/lib/genesys/callbacks-manager.mjs";
import { installationResourceNames } from "@/lib/genesys/installation-scope.mjs";

export const dynamic = "force-dynamic";

const AUDIO_CONNECTOR_TYPE = "audio-connector";

function assistantVersionDate(version) {
  return String(version?.version_created_at || version?.created_at || "").trim();
}

async function optionalInventory(label, load, fallback, warnings) {
  try {
    return await load();
  } catch (error) {
    warnings.push({ component: label, error: error?.message || String(error) });
    return fallback;
  }
}

async function listAssistantVersions(telnyx, assistant) {
  const fallback = [{
    id: "main",
    name: "Main / current",
    createdAt: String(assistant?.created_at || "").trim() || null,
  }];
  if (!telnyx.ai.assistants.versions?.list) return fallback;
  try {
    const response = await telnyx.ai.assistants.versions.list(assistant.id);
    const versions = Array.isArray(response?.data) ? response.data : [];
    const normalized = versions.map((version) => ({
      id: String(version.version_id || version.id || "").trim(),
      name: String(version.version_name || "").trim() ||
        (String(version.version_id || "").trim() === "main" ? "Main / current" : "Assistant version"),
      createdAt: assistantVersionDate(version) || null,
    })).filter(({ id }) => id);
    normalized.sort((left, right) => {
      const byDate = Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "");
      return Number.isFinite(byDate) && byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });
    return normalized.length ? normalized : fallback;
  } catch {
    // An older Telnyx account or SDK can omit version access. Keep the current
    // assistant usable without turning the entire admin inventory refresh into an error.
    return fallback;
  }
}

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  let syncRunId = null;
  try {
    syncRunId = await startAdminInventorySync(auth.actor.organizationId);
    const context = await loadAdminConsoleGenesysContext({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
    });
    if (context.organization.id !== auth.actor.organizationId) {
      await finishAdminInventorySync(syncRunId, {
        status: "failed",
        error: "Genesys organization mismatch",
      });
      return NextResponse.json({ error: "Genesys organization mismatch" }, { status: 403 });
    }
    const [
      { listAudioConnectorIntegrations, listManagedAudioDeployments, PRIMARY_AUDIO_DEPLOYMENT_ID },
      {
        listInboundMessageFlows,
        listManagedWidgetDeployments,
        listTelnyxAssistants,
        readWidgetInfrastructureManifest,
      },
    ] = await Promise.all([
      import("../../../../scripts/manage-genesys-audio.mjs"),
      import("../../../../scripts/manage-genesys-widget.mjs"),
    ]);
    const inventoryWarnings = [];
    const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
    const ttsInventory = await loadTtsInventory(context.integrationsApi);
    const [
      ttsDeploymentInventory,
      ttsIntegrationType,
      audioIntegrationType,
      audioIntegrations,
      audioManifests,
      widgetManifests,
      widgetInfrastructureManifest,
      messageFlows,
      openMessagingIntegrations,
      assistants,
      widgets,
      configuredDnis,
      componentConfigs,
      genesysSipInventory,
      genesysSites,
      wrapupCodes,
      storedManagedTools,
      callbackDeployment,
    ] = await Promise.all([
      buildTtsDeploymentInventory({ inventory: ttsInventory, architectApi: context.architectApi }),
      context.integrationsApi.getIntegrationsType(GENESYS_TTS_CONNECTOR_TYPE),
      optionalInventory("audioConnectorType", () => context.integrationsApi.getIntegrationsType(AUDIO_CONNECTOR_TYPE), null, inventoryWarnings),
      optionalInventory("audioIntegrations", () => listAudioConnectorIntegrations(context.integrationsApi), [], inventoryWarnings),
      optionalInventory("audioDeployments", () => listManagedAudioDeployments(), [], inventoryWarnings),
      listManagedWidgetDeployments(),
      optionalInventory("webChatInfrastructureManifest", () => readWidgetInfrastructureManifest(), null, inventoryWarnings),
      listInboundMessageFlows(context.architectApi),
      optionalInventory("openMessagingIntegrations", () => listAllOpenMessagingIntegrations(context.conversationsApi), [], inventoryWarnings),
      listTelnyxAssistants(telnyx),
      listWidgets(auth.actor.organizationId),
      listConfiguredGenesysDnis(context.architectApi),
      listAdminComponentConfigs(auth.actor.organizationId),
      optionalInventory("genesysSip", () => loadGenesysSipInventory({
        telephonyApi: context.telephonyApi,
        architectApi: context.architectApi,
        environment: context.environment,
      }), { trunks: [] }, inventoryWarnings),
      context.telephonyApi.getTelephonyProvidersEdgesSites({ pageSize: 100, pageNumber: 1 }),
      context.routingApi.getRoutingWrapupcodes({ pageSize: 100, pageNumber: 1 }),
      listAdminManagedTools(auth.actor.organizationId),
      getLatestSuccessfulAdminDeploymentResult(auth.actor.organizationId, "callbacks"),
    ]);
    const [audioFlowInventory, audioAgentExperienceInventory] = await Promise.all([
      optionalInventory("audioArchitectFlows", () => loadAudioArchitectFlowInventory({
        manifests: audioManifests,
        architectApi: context.architectApi,
      }), {}, inventoryWarnings),
      optionalInventory("audioAgentExperience", () => loadAudioAgentExperienceInventory({
        manifests: audioManifests,
        integrationsApi: context.integrationsApi,
        scriptsApi: context.scriptsApi,
        groups: context.groups,
        queues: context.queues,
      }), {}, inventoryWarnings),
    ]);
    const genesysDids = await optionalInventory(
      "genesysDids",
      () => listAllGenesysDids(context.telephonyApi, configuredDnis),
      [],
      inventoryWarnings
    );
    const audioDeployments = buildAudioDeploymentInventory({
      integrations: audioIntegrations,
      manifests: audioManifests,
      flowInventory: audioFlowInventory,
      agentExperienceInventory: audioAgentExperienceInventory,
    }).filter((entry) => entry.id === PRIMARY_AUDIO_DEPLOYMENT_ID);
    const storedAudioComponent = componentConfigs.find(({ component }) => component === "audio");
    const storedAudioRoutes = storedAudioComponent?.enabled
      ? storedAudioComponent.config?.routes || []
      : [];
    const audioAssistantIds = new Set(
      [
        ...audioDeployments.flatMap((deployment) => deployment.config.routes || []),
        ...storedAudioRoutes,
      ]
        .map((route) => String(route.assistantId || "").trim())
        .filter(Boolean)
    );
    await optionalInventory("assistantDesiredState", () => syncAdminAssistantInventory({
      organizationId: auth.actor.organizationId,
      assistants,
    }), null, inventoryWarnings);
    const toolReconciliation = await reconcileAdminManagedToolsWithProvider({
      telnyx,
      organizationId: auth.actor.organizationId,
      tools: storedManagedTools,
    });
    for (const error of toolReconciliation.errors) {
      inventoryWarnings.push({
        component: `managedTool:${error.remoteToolId}`,
        error: error.error,
      });
    }
    const managedTools = toolReconciliation.tools;
    await optionalInventory("toolDesiredState", () => syncAdminManagedToolsToDesiredState({
      organizationId: auth.actor.organizationId,
      tools: managedTools,
    }), null, inventoryWarnings);
    const assistantVersions = new Map(await Promise.all(
      assistants.map(async (assistant) => [
        assistant.id,
        await listAssistantVersions(telnyx, assistant),
      ])
    ));
    const [channelProfiles, handoffPolicies] = await Promise.all([
      listAdminWidgetChannelProfiles(auth.actor.organizationId),
      listAdminHandoffPolicies(auth.actor.organizationId),
    ]);
    const callbackProfile = await getAdminCallbackCampaignProfile(auth.actor.organizationId);
    const audioRoutingProfile = await getAdminAudioRoutingProfile(auth.actor.organizationId);
    const webChatRecipientId = widgetInfrastructureManifest?.messaging?.recipientId || "";
    const webChatRecipient = webChatRecipientId
      ? await optionalInventory(
        "webChatRecipient",
        () => context.routingApi.getRoutingMessageRecipient(webChatRecipientId),
        null,
        inventoryWarnings
      )
      : null;
    const webChatInfrastructure = buildWebChatInfrastructureInventory({
      manifest: widgetInfrastructureManifest,
      messageFlows,
      openMessagingIntegrations,
      recipient: webChatRecipient,
      managedTools,
      desiredProfile: handoffPolicies.find((policy) => policy.context === "web_messaging"),
      publicBaseUrl: process.env.GC_PUBLIC_BASE_URL || "",
    });
    const storedCallbackResources = callbackDeployment?.result || null;
    const callbackCampaignId = storedCallbackResources?.campaign?.id || null;
    const callbackContactListId = storedCallbackResources?.contactList?.id || null;
    const callbackFilterId = storedCallbackResources?.contactListFilter?.id || null;
    const [observedCallbackCampaign, observedCallbackContactList, observedCallbackFilter] = await Promise.all([
      callbackCampaignId
        ? optionalInventory(
          "callbackCampaign",
          () => context.outboundApi.getOutboundCampaign(callbackCampaignId),
          null,
          inventoryWarnings
        )
        : null,
      callbackContactListId
        ? optionalInventory(
          "callbackContactList",
          () => context.outboundApi.getOutboundContactlist(callbackContactListId),
          null,
          inventoryWarnings
        )
        : null,
      callbackFilterId
        ? optionalInventory(
          "callbackContactListFilter",
          () => context.outboundApi.getOutboundContactlistfilter(callbackFilterId),
          null,
          inventoryWarnings
        )
        : null,
    ]);
    const callbackFilterPreview = observedCallbackFilter
      ? await optionalInventory(
        "callbackContactListFilterPreview",
        () => context.outboundApi.postOutboundContactlistfiltersPreview(observedCallbackFilter),
        null,
        inventoryWarnings
      )
      : null;
    const callbackCampaignStatus = String(observedCallbackCampaign?.campaignStatus || "").trim().toLowerCase();
    const callbackRecordCounts = callbackContactListRecordCounts(
      observedCallbackContactList,
      callbackFilterPreview
    );
    const callbackResources = storedCallbackResources ? {
      campaigns: storedCallbackResources.campaign ? [{
        ...storedCallbackResources.campaign,
        name: observedCallbackCampaign?.name || storedCallbackResources.campaign.name,
        campaignStatus: callbackCampaignStatus || null,
        status: callbackCampaignStatus || "unknown",
        enabled: callbackCampaignStatus === "on",
      }] : [],
      contactLists: storedCallbackResources.contactList ? [{
        ...storedCallbackResources.contactList,
        name: observedCallbackContactList?.name || storedCallbackResources.contactList.name,
        ...callbackRecordCounts,
      }] : [],
      flows: storedCallbackResources.flow ? [storedCallbackResources.flow] : [],
      completedAt: callbackDeployment.completedAt,
    } : { campaigns: [], contactLists: [], flows: [], completedAt: null };
    for (const route of audioRoutingProfile.routes || []) audioAssistantIds.add(route.assistantId);
    const inventoryResponse = {
      installation: installationResourceNames(),
      organization: { id: context.organization.id, name: context.organization.name },
      environment: context.environment,
      publicBaseUrl: process.env.GC_PUBLIC_BASE_URL || null,
      queues: context.queues.map(({ id, name }) => ({ id, name })),
      groups: context.groups.map(({ id, name, type }) => ({ id, name, type })),
      ttsProfiles: verifiedTtsConnectorProfiles().map((profile) => ({
        id: profile.id,
        name: profile.displayName,
        provider: profile.provider,
        connectorName: profile.integrationName,
        testFlowName: genesysTtsTestFlowName(profile),
      })),
      ttsCapacity: {
        used: ttsInventory.length,
        total: Number(ttsIntegrationType?.maxInstances || 10),
      },
      audioCapacity: {
        used: audioIntegrations.length,
        total: Number(audioIntegrationType?.maxInstances || 10),
      },
      ttsDeployments: ttsDeploymentInventory.deployments,
      ttsFlows: ttsDeploymentInventory.flows,
      ttsFlowConflicts: ttsDeploymentInventory.conflicts,
      audioDeployments,
      configuredDnis,
      genesysDids,
      genesysSites: (genesysSites.entities || []).map(({ id, name }) => ({ id, name })),
      wrapupCodes: (wrapupCodes.entities || []).map(({ id, name }) => ({ id, name })),
      widgetDeployments: buildWidgetDeploymentInventory({
        widgets,
        manifests: widgetManifests,
        messageFlows,
        assistants,
      }),
      messageFlows: messageFlows.map(({ id, name }) => ({ id, name })),
      telnyxAssistants: assistants.map(({ id, name }) => ({
        id,
        name,
        audioConnector: audioAssistantIds.has(id),
        versions: assistantVersions.get(id) || [],
      })),
      channelProfiles,
      handoffPolicies,
      webChatInfrastructure,
      callbackProfile,
      audioRoutingProfile,
      managedTools,
      callbackResources,
      genesysSipTrunks: genesysSipInventory.trunks.map((trunk) => {
        let compatible = true;
        let incompatibilityReason = null;
        try {
          resolveGenesysByocTrunk(genesysSipInventory, trunk.id);
        } catch (error) {
          compatible = false;
          incompatibilityReason = error.message;
        }
        return {
          id: trunk.id,
          name: trunk.name,
          enabled: trunk.enabled,
          compatible,
          incompatibilityReason,
          terminationIdentifier: trunk.terminationIdentifier,
          byocDomain: trunk.byocDomain,
          fqdn: trunk.fqdn,
          platform: trunk.platform,
          transport: trunk.transport,
        };
      }),
      warnings: inventoryWarnings,
      source: "live",
      refreshedAt: new Date().toISOString(),
    };
    await optionalInventory("dashboardObservedState", () => syncAdminDashboardObservedInventory({
      organizationId: auth.actor.organizationId,
      ttsDeployments: ttsDeploymentInventory.deployments,
      ttsFlows: ttsDeploymentInventory.flows,
      audioManifests,
      widgetManifests,
      widgetInfrastructureManifest,
    }), null, inventoryWarnings);
    await saveAdminInventoryCache(auth.actor.organizationId, inventoryResponse);
    await finishAdminInventorySync(syncRunId, {
      status: inventoryWarnings.length ? "partial" : "succeeded",
      summary: {
        warnings: inventoryWarnings.length,
        assistants: assistants.length,
        managedTools: managedTools.length,
        audioDeployments: audioDeployments.length,
        widgetDeployments: inventoryResponse.widgetDeployments.length,
        ttsDeployments: inventoryResponse.ttsDeployments.length,
      },
    });
    return NextResponse.json(inventoryResponse, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      },
    });
  } catch (error) {
    if (syncRunId) {
      await finishAdminInventorySync(syncRunId, {
        status: "failed",
        error: String(error?.message || error).slice(0, 4000),
      }).catch(() => undefined);
    }
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
