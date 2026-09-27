import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { createWidgetTestGrant } from "@/lib/widgets/session-tokens";
import { getWidget, recordWidgetTestOpened } from "@/lib/widgets/store";

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid widget ID" }, { status: 400 });
  const widget = await getWidget(id, auth.actor.organizationId);
  if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
  if (!widget.published || !widget.enabled) {
    return NextResponse.json({ error: "Publish and enable the widget before testing it" }, { status: 409 });
  }
  const origin = new URL(request.headers.get("origin")).origin;
  const grant = createWidgetTestGrant({ publicId: widget.publicId, revisionId: widget.published.id, origin, userId: auth.actor.userId });
  await recordWidgetTestOpened({ widgetId: widget.id, actor: auth.actor, origin, revisionId: widget.published.id });
  return NextResponse.json({ publicId: widget.publicId, name: widget.name, revision: widget.published.version, grant },
    { headers: { "Cache-Control": "no-store" } });
}
