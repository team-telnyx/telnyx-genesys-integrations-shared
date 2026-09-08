import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { loadAdminConsoleGenesysContext } from "@/lib/genesys/admin-console-installer.mjs";
import { getWidget } from "@/lib/widgets/store";

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const trunkId = String(body.trunkId || "").trim();
    if (!trunkId) {
      return NextResponse.json({ error: "Select a Genesys BYOC trunk" }, { status: 400 });
    }
    const widget = await getWidget(id, auth.actor.organizationId);
    if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
    const context = await loadAdminConsoleGenesysContext({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
    });
    if (context.organization.id !== auth.actor.organizationId) {
      return NextResponse.json({ error: "Genesys organization mismatch" }, { status: 403 });
    }
    const { reservePublishedWidgetVoiceRouting } = await import(
      "../../../../../../scripts/manage-genesys-widget.mjs"
    );
    const routing = await reservePublishedWidgetVoiceRouting({
      organizationId: auth.actor.organizationId,
      widget,
      context,
      trunkId,
    });
    return NextResponse.json({
      genesysSipUri: routing.genesysSipUri,
      phoneNumber: routing.allocation.phone_number,
      trunk: {
        id: routing.trunk.id,
        name: routing.trunk.name,
        fqdn: routing.trunk.fqdn,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
