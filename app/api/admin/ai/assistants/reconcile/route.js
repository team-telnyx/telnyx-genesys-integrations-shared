import { NextResponse } from "next/server";
import Telnyx from "telnyx";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { listAdminAssistantCatalog } from "@/lib/genesys/admin-desired-state.mjs";
import { reconcileAdminManagedAssistantBundles } from "@/lib/genesys/admin-managed-insights.mjs";

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
    const result = await reconcileAdminManagedAssistantBundles({
      telnyx,
      actor: auth.actor,
    });
    return NextResponse.json({
      profile: result.profile,
      reconciliation: result.assistants,
      assistants: await listAdminAssistantCatalog(auth.actor.organizationId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = remoteStatus(error);
    return NextResponse.json(
      { error: error?.message || String(error) },
      { status: status >= 400 && status < 500 ? status : 502 }
    );
  }
}
