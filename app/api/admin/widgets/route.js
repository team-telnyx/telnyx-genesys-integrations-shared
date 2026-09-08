import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { cloneWidget, createWidget, listWidgets } from "@/lib/widgets/store";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const widgets = await listWidgets(auth.actor.organizationId);
  return NextResponse.json({ widgets });
}

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const widget = body.cloneFromId
      ? await cloneWidget({ sourceId: body.cloneFromId, name: body.name, actor: auth.actor })
      : await createWidget({ name: body.name, actor: auth.actor });
    return NextResponse.json({ widget }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error.status || 400 });
  }
}
