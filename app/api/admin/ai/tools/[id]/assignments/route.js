import { NextResponse } from "next/server";
import Telnyx from "telnyx";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  listAdminAssistantCatalog,
  removeAdminAssistantMissingFromProvider,
} from "@/lib/genesys/admin-desired-state.mjs";
import {
  getAdminManagedToolById,
  removeAdminManagedToolMissingFromProvider,
} from "@/lib/genesys/admin-managed-tools.mjs";
import { assistantToolIds } from "@/lib/genesys/handoff-tool-definition.mjs";

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export async function GET(request, { params }) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    const tool = await getAdminManagedToolById(auth.actor.organizationId, id);
    if (!tool || tool.status === "retired") {
      return NextResponse.json({ error: "Managed assistant tool was not found" }, { status: 404 });
    }
    const catalog = await listAdminAssistantCatalog(auth.actor.organizationId);
    const assistants = catalog.filter((assistant) =>
      assistant.managed && assistant.status !== "missing" && assistant.telnyxAssistantId
    );
    const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
    try {
      await telnyx.ai.tools.retrieve(tool.remoteToolId);
    } catch (error) {
      if (remoteStatus(error) !== 404) throw error;
      await removeAdminManagedToolMissingFromProvider({
        organizationId: auth.actor.organizationId,
        id: tool.id,
      });
      return NextResponse.json({
        error: "This managed assistant tool no longer exists in Telnyx and was removed from the integration catalog.",
        removed: true,
      }, { status: 410 });
    }
    const attached = [];
    for (const assistant of assistants) {
      try {
        const response = await telnyx.ai.assistants.retrieve(assistant.telnyxAssistantId);
        const remote = response?.data || response;
        if (assistantToolIds(remote).includes(tool.remoteToolId)) attached.push(assistant.telnyxAssistantId);
      } catch (error) {
        if (remoteStatus(error) !== 404) throw error;
        await removeAdminAssistantMissingFromProvider({
          organizationId: auth.actor.organizationId,
          telnyxAssistantId: assistant.telnyxAssistantId,
        });
      }
    }
    return NextResponse.json({ readOnly: true, assistantIds: attached }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = remoteStatus(error);
    return NextResponse.json({ error: error.message }, {
      status: status >= 400 && status < 500 ? status : 502,
    });
  }
}

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    error: "Assistant tool attachments are owned by deployment rules and cannot be changed manually",
  }, { status: 405, headers: { Allow: "GET" } });
}
