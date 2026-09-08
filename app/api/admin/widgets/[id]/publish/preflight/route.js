import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  applyAdminWidgetChannelProfiles,
  listAdminHandoffPolicies,
  listAdminWidgetChannelProfiles,
} from "@/lib/genesys/admin-desired-state.mjs";
import { applyWidgetInfrastructure } from "@/lib/widgets/config";
import {
  createWidgetInfrastructureState,
  widgetInfrastructureSyncReason,
} from "@/lib/widgets/infrastructure-state";
import { getWidget } from "@/lib/widgets/store";

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const widget = await getWidget(id, auth.actor.organizationId);
    if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
    const [profiles, policies, widgetManager] = await Promise.all([
      listAdminWidgetChannelProfiles(auth.actor.organizationId),
      listAdminHandoffPolicies(auth.actor.organizationId),
      import("../../../../../../../scripts/manage-genesys-widget.mjs"),
    ]);
    const infrastructure = await widgetManager.readWidgetInfrastructureManifest();
    const messagingPolicy = policies.find((policy) => policy.context === "web_messaging");
    const voicePolicy = policies.find((policy) => policy.context === "web_voice");
    const messagingQueues = messagingPolicy?.queues || [];
    const messagingDefaultQueue = messagingQueues.find((queue) => queue.id === messagingPolicy?.defaultQueueId) || null;
    const voiceQueues = voicePolicy?.queues || [];
    const baseIntegrationId = String(
      infrastructure?.resources?.openMessagingIntegrationId ||
      widget.baseOpenMessagingIntegrationId ||
      widget.infrastructureConfig?.messaging?.baseIntegrationId ||
      ""
    ).trim();
    let config = applyWidgetInfrastructure(widget.draft.config, {
      integrationId: widget.openMessagingIntegrationId || widget.draft.config.channels.messaging.genesys.integrationId || baseIntegrationId,
      queues: messagingQueues,
      defaultQueue: messagingDefaultQueue,
    });
    config = applyAdminWidgetChannelProfiles(config, profiles);
    const publicBaseUrl = String(
      infrastructure?.publicBaseUrl || widget.infrastructureConfig?.endpoint || process.env.GC_PUBLIC_BASE_URL || ""
    ).trim();
    const desiredInfrastructure = createWidgetInfrastructureState({
      widget,
      config,
      publicBaseUrl,
      baseIntegrationId,
      messagingQueues,
      messagingDefaultQueueId: messagingDefaultQueue?.id,
      voiceQueues,
      voiceDefaultQueueId: voicePolicy?.defaultQueueId,
      openMessagingSecret: process.env.GC_OPEN_MESSAGING_SECRET,
      handoffApiKey: process.env.GENESYS_HANDOFF_API_KEY || process.env.WIDGET_HANDOFF_API_KEY,
    });
    const infrastructureSyncReason = widgetInfrastructureSyncReason(widget, desiredInfrastructure, {
      force: body?.forceInfrastructure === true,
    });
    const { inspectPublishedWidgetAssistantToolConflicts } = widgetManager;
    const toolInspection = infrastructureSyncReason && config.channels.voice.enabled
      ? await inspectPublishedWidgetAssistantToolConflicts({
          organizationId: auth.actor.organizationId,
          widget,
          config,
        })
      : null;
    const inspection = toolInspection;
    return NextResponse.json({
      assistant: inspection ? {
        id: inspection.assistantId,
        name: inspection.assistantName,
      } : null,
      conflicts: toolInspection?.conflicts || [],
      changes: [],
      infrastructureSyncReason,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: Number(error?.status || 400) });
  }
}
