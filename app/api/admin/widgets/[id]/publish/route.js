import { normalizeTelnyxPublicKey } from "@/lib/telnyx/webhooks.mjs";
import { ensurePublishedWidgetVideo, resolveVideoAccessGroups } from "@/lib/genesys/video-installer.mjs";
import { configureVideoPanelQueue, panelSettingsApi, preserveVideoPanelDefaultBeforeUpdate } from "@/lib/genesys/video-panel-settings.mjs";
import { withVideoPanelState } from "@/lib/genesys/video-panel-store.mjs";
import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { loadAdminConsoleGenesysContext } from "@/lib/genesys/admin-console-installer.mjs";
import {
  applyAdminWidgetChannelProfiles,
  listAdminHandoffPolicies,
  listAdminWidgetChannelProfiles,
} from "@/lib/genesys/admin-desired-state.mjs";
import { ensureWidgetDedicatedMessagingResources } from "@/lib/genesys/widget-supported-content.mjs";
import { applyWidgetInfrastructure, assertPublishableWidgetConfig } from "@/lib/widgets/config";
import {
  createWidgetInfrastructureState,
  widgetInfrastructureSyncReason,
} from "@/lib/widgets/infrastructure-state";
import { getWidget, publishWidget, updateWidgetDraft } from "@/lib/widgets/store";
import { registerManagedResourceBatch } from "@/lib/genesys/managed-resource-registry.mjs";

function publishHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publishErrorPayload(error) {
  const hasAssistantChanges = Array.isArray(error?.conflicts) || Array.isArray(error?.changes);
  return {
    error: error.message,
    ...(error?.code ? { code: error.code } : {}),
    ...(hasAssistantChanges ? {
      assistant: { id: error.assistantId, name: error.assistantName },
      conflicts: error.conflicts || [],
      changes: error.changes || [],
    } : {}),
  };
}

async function executeWidgetPublish({ id, auth, body, onProgress = () => {} }) {
  const progress = (status, label, detail = "") => onProgress({ status, label, detail });

    const forceInfrastructure = body?.forceInfrastructure === true;
    const approvedToolConflictKeys = Array.isArray(body?.approvedToolConflictKeys)
      ? body.approvedToolConflictKeys
      : [];
    progress("running", "Validate widget configuration and shared channel profiles");
    const current = await getWidget(id, auth.actor.organizationId);
    if (!current) throw publishHttpError("Widget not found", 404);
    const {
      ensurePublishedWidgetVoiceRouting,
      ensurePublishedWidgetAssistantResources,
      reconcilePublishedWidgetAssistantToolConflicts,
      readWidgetInfrastructureManifest,
      reservePublishedWidgetVoiceRouting,
    } = await import("../../../../../../scripts/manage-genesys-widget.mjs");
    const infrastructure = await readWidgetInfrastructureManifest();
    if (infrastructure?.organization?.id && infrastructure.organization.id !== auth.actor.organizationId) {
      throw publishHttpError("Web Chat Infrastructure belongs to another Genesys organization", 403);
    }
    const baseIntegrationId = String(
      infrastructure?.resources?.openMessagingIntegrationId ||
      current.baseOpenMessagingIntegrationId ||
      current.infrastructureConfig?.messaging?.baseIntegrationId ||
      ""
    ).trim();
    if (current.draft.config.channels.messaging.enabled && !baseIntegrationId) {
      throw new Error("Configure Web Chat Infrastructure before publishing this widget");
    }
    const [channelProfiles, handoffPolicies] = await Promise.all([
      listAdminWidgetChannelProfiles(auth.actor.organizationId),
      listAdminHandoffPolicies(auth.actor.organizationId),
    ]);
    const messagingProfile = handoffPolicies.find((policy) => policy.context === "web_messaging");
    const voicePolicy = handoffPolicies.find((policy) => policy.context === "web_voice");
    const messagingQueues = messagingProfile?.queues || [];
    const messagingDefaultQueue = messagingQueues.find((queue) => queue.id === messagingProfile?.defaultQueueId) || null;
    const voiceQueues = voicePolicy?.queues || [];
    const voiceDefaultQueue = voiceQueues.find((queue) => queue.id === voicePolicy?.defaultQueueId) || null;
    if (current.draft.config.channels.messaging.enabled && (!messagingQueues.length || !messagingDefaultQueue)) {
      throw new Error("Configure the Web Chat Queue Policy before publishing this widget");
    }
    if (current.draft.config.channels.voice.enabled && (!voiceQueues.length || !voicePolicy?.defaultQueueId)) {
      throw new Error("Configure the Web Calls Queue Policy before publishing this widget");
    }
    let publishConfig = applyWidgetInfrastructure(current.draft.config, {
      // The runtime must keep using the widget-dedicated integration. The base
      // integration is only an infrastructure template and is fingerprinted
      // separately below.
      integrationId: current.openMessagingIntegrationId || current.draft.config.channels.messaging.genesys.integrationId || baseIntegrationId,
      queues: messagingQueues,
      defaultQueue: messagingDefaultQueue,
    });
    publishConfig = applyAdminWidgetChannelProfiles(publishConfig, channelProfiles);
    if (!publishConfig.allowedOrigins.length && infrastructure?.messaging?.allowedOrigins?.length) {
      publishConfig = {
        ...publishConfig,
        allowedOrigins: [...infrastructure.messaging.allowedOrigins],
      };
    }
    progress("success", "Validate widget configuration and shared channel profiles", "ready");

    const messagingEnabled = publishConfig.channels.messaging.enabled;
    const voiceEnabled = publishConfig.channels.voice.enabled;
    const videoEnabled = publishConfig.channels.video.enabled;
    const videoAutoOpen = publishConfig.channels.video.genesys.autoOpen;
    const hasVideoPanelRequest = typeof videoAutoOpen === "boolean";
    if (videoAutoOpen === true && !videoEnabled) throw publishHttpError("Enable the video channel before enabling automatic panel opening", 400);
    const videoPanelToDisable = !videoEnabled && publishConfig.channels.video.genesys.widgetIntegrationId;
    if (videoEnabled) normalizeTelnyxPublicKey(process.env.TELNYX_PUBLIC_KEY);
    const publicBaseUrl = String(
      infrastructure?.publicBaseUrl ||
      current.infrastructureConfig?.endpoint ||
      process.env.GC_PUBLIC_BASE_URL ||
      ""
    ).trim();
    const desiredInfrastructure = createWidgetInfrastructureState({
      widget: current,
      config: publishConfig,
      publicBaseUrl,
      baseIntegrationId,
      messagingQueues,
      messagingDefaultQueueId: messagingDefaultQueue?.id,
      voiceQueues,
      voiceDefaultQueueId: voiceDefaultQueue?.id,
      openMessagingSecret: process.env.GC_OPEN_MESSAGING_SECRET,
      handoffApiKey: process.env.GENESYS_HANDOFF_API_KEY || process.env.WIDGET_HANDOFF_API_KEY,
    });
    const infrastructureSyncReason = widgetInfrastructureSyncReason(
      current,
      desiredInfrastructure,
      { force: forceInfrastructure }
    );
    const synchronizeInfrastructure = Boolean(infrastructureSyncReason);
    const previousVideo = current.published?.config?.channels?.video;
    const legacyPanelWillChange = synchronizeInfrastructure && previousVideo?.genesys?.widgetIntegrationId
      && (videoPanelToDisable || previousVideo.genesys.queueId !== publishConfig.channels.video.genesys.queueId);

    let context = null;
    if (hasVideoPanelRequest || legacyPanelWillChange || (synchronizeInfrastructure && (messagingEnabled || voiceEnabled || videoEnabled || videoPanelToDisable))) {
      if (!/^https:\/\//i.test(publicBaseUrl)) {
        throw new Error("GC_PUBLIC_BASE_URL must be a public HTTPS origin");
      }
      context = await loadAdminConsoleGenesysContext({
        environment: process.env.GC_ENVIRONMENT,
        clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
        clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
      });
      if (context.organization.id !== auth.actor.organizationId) {
        throw publishHttpError("Genesys organization mismatch", 403);
      }
    }
    // Detect permission/API failures before provisioning other channel resources.
    const videoPanelApi = hasVideoPanelRequest || legacyPanelWillChange ? panelSettingsApi(context) : null;
    if (videoPanelApi) await videoPanelApi.get();

    if (synchronizeInfrastructure && voiceEnabled) {
      await reconcilePublishedWidgetAssistantToolConflicts({
        organizationId: auth.actor.organizationId,
        widget: current,
        config: publishConfig,
        approvedConflictKeys: approvedToolConflictKeys,
        onProgress,
      });
    }

    let reservedVoiceRouting = null;
    if (synchronizeInfrastructure && voiceEnabled) {
      reservedVoiceRouting = await reservePublishedWidgetVoiceRouting({
        organizationId: auth.actor.organizationId,
        widget: current,
        context,
        trunkId: publishConfig.channels.voice.genesysTrunkId,
        onProgress,
      });
      if (publishConfig.channels.voice.genesysSipUriManaged !== false) {
        publishConfig = {
          ...publishConfig,
          channels: {
            ...publishConfig.channels,
            voice: {
              ...publishConfig.channels.voice,
              genesysSipUri: reservedVoiceRouting.genesysSipUri,
              genesysSipUriManaged: true,
            },
          },
        };
      }
    }

    // Validate the complete effective configuration before provisioning any
    // Genesys or Telnyx resources. This turns a misleading infrastructure
    // error into the exact missing widget setting and avoids partial writes.
    assertPublishableWidgetConfig(publishConfig);
    let saved = await updateWidgetDraft({ id, config: publishConfig, actor: auth.actor });
    if (!saved) throw publishHttpError("Widget not found", 404);

    let videoPanelSettings = null;
    if (videoPanelApi) {
      const groups = await resolveVideoAccessGroups({ context, infrastructure });
      if (hasVideoPanelRequest) await context.routingApi.getRoutingQueue(publishConfig.channels.video.genesys.queueId);
      progress("running", "Configure automatic video panel opening", publishConfig.channels.video.genesys.queueName);
      videoPanelSettings = await withVideoPanelState(auth.actor.organizationId, stored => {
        const options = { ...stored, settingsApi: videoPanelApi, integrationsApi: context.integrationsApi, baseUrl: publicBaseUrl, groups };
        return hasVideoPanelRequest
          ? configureVideoPanelQueue({ ...options, queueId: publishConfig.channels.video.genesys.queueId, enabled: videoAutoOpen })
          : preserveVideoPanelDefaultBeforeUpdate({ ...options, panelId: previousVideo.genesys.widgetIntegrationId });
      });
      progress("success", "Configure automatic video panel opening", hasVideoPanelRequest
        ? videoPanelSettings.enabled ? "Enabled for the selected queue" : "Disabled for the selected queue"
        : "Existing video queue settings preserved");
    }

    let genesysResources = null;
    if (synchronizeInfrastructure && messagingEnabled) {
      const secret = String(process.env.GC_OPEN_MESSAGING_SECRET || "").trim();
      if (secret.length < 32) throw new Error("GC_OPEN_MESSAGING_SECRET must contain at least 32 characters");
      progress("running", `Synchronize dedicated Genesys messaging resources: ${current.name}`);
      const dedicatedResources = await ensureWidgetDedicatedMessagingResources({
        context,
        widget: current,
        config: publishConfig,
        publicBaseUrl,
        secret,
        baseIntegrationId,
      });
      progress("success", `Synchronize dedicated Genesys messaging resources: ${current.name}`, "ready");
      genesysResources = {
        ...dedicatedResources,
        queues: messagingQueues,
        defaultQueue: messagingDefaultQueue,
      };
    }
    if (synchronizeInfrastructure && videoPanelToDisable) {
      await context.integrationsApi.patchIntegration(videoPanelToDisable, { body: { intendedState: "DISABLED" } });
    }
    let videoResources = null;
    if (synchronizeInfrastructure && videoEnabled) {
      const videoGroups = await resolveVideoAccessGroups({ context, infrastructure });
      videoResources = await ensurePublishedWidgetVideo({
        context, widget: current, config: publishConfig, baseUrl: publicBaseUrl,
        groups: videoGroups, secret: process.env.GC_OPEN_MESSAGING_SECRET, onProgress,
      });
      publishConfig.channels.video.genesys = { ...videoResources.genesys, autoOpen: videoAutoOpen };
      saved = await updateWidgetDraft({ id, config: publishConfig, actor: auth.actor });
      await registerManagedResourceBatch({
        organizationId: auth.actor.organizationId,
        aggregate: { kind: "messaging_profile", name: `widget:${current.id}:video`, desiredConfig: { widgetId: current.id, queueId: videoResources.genesys.queueId } },
        resources: [
          { key: "video_open_messaging", provider: "genesys", resourceType: "open_messaging_integration", remoteId: videoResources.integration.id, displayName: videoResources.integration.name, logicalKey: "widget_video_messaging", scopeType: "widget", scopeId: current.id },
          { key: "video_flow", provider: "genesys", resourceType: "architect_inbound_flow", remoteId: videoResources.flow.id, displayName: videoResources.flow.name, logicalKey: "widget_video_flow", scopeType: "widget", scopeId: current.id },
          { key: "video_panel", provider: "genesys", resourceType: "client_application", remoteId: videoResources.panel.id, displayName: videoResources.panel.name, logicalKey: "widget_video_panel", scopeType: "widget", scopeId: current.id },
        ],
      });
    }
    const voiceRouting = synchronizeInfrastructure && voiceEnabled
      ? await ensurePublishedWidgetVoiceRouting({
          organizationId: auth.actor.organizationId,
          widget: current,
          context,
          queues: voiceQueues,
          publicBaseUrl,
          trunkId: publishConfig.channels.voice.genesysTrunkId,
          reservedRouting: reservedVoiceRouting,
          onProgress,
        })
      : null;
    const telnyxResources = synchronizeInfrastructure && (messagingEnabled || voiceEnabled)
      ? await ensurePublishedWidgetAssistantResources({
          organizationId: auth.actor.organizationId,
          widget: current,
          config: publishConfig,
          infrastructure: {
            ...infrastructure,
            publicBaseUrl,
            messaging: {
              ...(infrastructure?.messaging || {}),
              queues: messagingQueues,
            },
            voice: {
              ...(infrastructure?.voice || {}),
              queues: voiceQueues,
            },
          },
          approvedToolConflictKeys,
          onProgress,
        })
      : null;
    if (genesysResources) {
      await registerManagedResourceBatch({
        organizationId: auth.actor.organizationId,
        aggregate: {
          kind: "messaging_profile",
          name: `widget:${current.id}:messaging`,
          desiredConfig: { widgetId: current.id, widgetName: current.name },
        },
        resources: [
          {
            key: "supported_content_profile",
            provider: "genesys",
            resourceType: "supported_content_profile",
            remoteId: genesysResources.profile.id,
            displayName: genesysResources.profile.name,
            logicalKey: "widget_supported_content",
            scopeType: "widget",
            scopeId: current.id,
          },
          {
            key: "open_messaging",
            provider: "genesys",
            resourceType: "open_messaging_integration",
            remoteId: genesysResources.integration.id,
            displayName: genesysResources.integration.name,
            logicalKey: "widget_open_messaging",
            scopeType: "widget",
            scopeId: current.id,
          },
        ],
      });
    }
    if (voiceRouting) {
      await registerManagedResourceBatch({
        organizationId: auth.actor.organizationId,
        aggregate: {
          kind: "voice_profile",
          name: `widget:${current.id}:voice`,
          desiredConfig: { widgetId: current.id, widgetName: current.name },
        },
        resources: [
          {
            key: "voice_flow", provider: "genesys", resourceType: "architect_inbound_flow",
            remoteId: voiceRouting.flow.id, displayName: voiceRouting.flow.name,
            logicalKey: "widget_voice_flow", scopeType: "widget", scopeId: current.id,
          },
          {
            key: "voice_ivr", provider: "genesys", resourceType: "inbound_call_route",
            remoteId: voiceRouting.ivr.id, displayName: voiceRouting.ivr.name,
            logicalKey: "widget_voice_ivr", scopeType: "widget", scopeId: current.id,
          },
          {
            key: "did_pool", provider: "genesys", resourceType: "did_pool",
            remoteId: voiceRouting.didPool.id, displayName: voiceRouting.didPool.name,
            logicalKey: "widget_voice_did_pool", scopeType: "widget", scopeId: current.id,
            metadata: { phoneNumber: voiceRouting.allocation.phone_number },
          },
        ],
        dependencies: [
          { resource: "voice_ivr", dependsOn: "voice_flow", relationship: "routes_to_flow" },
          { resource: "did_pool", dependsOn: "voice_ivr", relationship: "assigned_to_route" },
        ],
      });
    }
    if (hasVideoPanelRequest) {
      publishConfig.channels.video.genesys.autoOpen = null;
      saved = await updateWidgetDraft({ id, config: publishConfig, actor: auth.actor });
    }
    // Mark the fingerprint only after every created remote resource has been
    // recorded in PostgreSQL. A registry failure therefore leaves the next
    // publish on the safe reconciliation path instead of incorrectly taking
    // the revision-only shortcut.
    progress("running", `Publish widget revision: ${current.name}`);
    const widget = await publishWidget({
      id,
      actor: auth.actor,
      genesysResources,
      infrastructureState: synchronizeInfrastructure ? desiredInfrastructure : null,
      infrastructureSyncReason,
    });
    if (!widget) throw publishHttpError("Widget not found", 404);
    progress("success", `Publish widget revision: ${current.name}`, `revision ${widget.published.version}`);
    return {
      widget,
      genesysResources: genesysResources ? {
        supportedContentProfile: { id: genesysResources.profile.id, name: genesysResources.profile.name },
        openMessagingIntegration: { id: genesysResources.integration.id, name: genesysResources.integration.name },
        architectFlow: genesysResources.flow,
      } : null,
      voiceRouting: voiceRouting ? {
        phoneNumber: voiceRouting.allocation.phone_number,
        genesysSipUri: voiceRouting.genesysSipUri,
        trunk: { id: voiceRouting.trunk.id, name: voiceRouting.trunk.name, fqdn: voiceRouting.trunk.fqdn },
        didPool: { id: voiceRouting.didPool.id, name: voiceRouting.didPool.name },
        architectFlow: { id: voiceRouting.flow.id, name: voiceRouting.flow.name },
        inboundRoute: { id: voiceRouting.ivr.id, name: voiceRouting.ivr.name },
      } : null,
      telnyxResources: {
        assistantId: telnyxResources?.assistantId || null,
        handoffToolId: telnyxResources?.messaging?.tool?.id || null,
        hangupToolId: telnyxResources?.messaging?.hangupTool?.id || telnyxResources?.hangup?.tool?.id || null,
        transferToolId: telnyxResources?.transfer?.tool?.id || null,
        voiceQueueToolId: telnyxResources?.transfer?.queueTool?.id || null,
      },
      videoResources: videoResources ? { panel: videoResources.panel, flow: videoResources.flow } : null,
      videoPanelSettings,
      publication: {
        infrastructureSynchronized: synchronizeInfrastructure,
        infrastructureSyncReason,
      },
    };
}

function streamingPublishResponse(operation) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      operation((progress) => send({ type: "progress", progress }))
        .then((result) => send({ type: "result", result }))
        .catch((error) => send({
          type: "error",
          status: Number(error?.status || 400),
          ...publishErrorPayload(error),
        }))
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body?.stream === true) {
    return streamingPublishResponse((onProgress) => executeWidgetPublish({ id, auth, body, onProgress }));
  }
  try {
    return NextResponse.json(await executeWidgetPublish({ id, auth, body }));
  } catch (error) {
    return NextResponse.json(publishErrorPayload(error), { status: Number(error?.status || 400) });
  }
}
