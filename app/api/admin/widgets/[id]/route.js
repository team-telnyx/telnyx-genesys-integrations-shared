import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getWidget, updateWidget } from "@/lib/widgets/store";

export async function GET(request, { params }) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const widget = await getWidget(id, auth.actor.organizationId);
  if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
  return NextResponse.json({ widget });
}

export async function PATCH(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const body = await request.json();
    const widget = await updateWidget({
      id,
      name: body.name,
      enabled: body.enabled,
      actor: auth.actor,
    });
    if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
    return NextResponse.json({ widget });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error.status || 400 });
  }
}
