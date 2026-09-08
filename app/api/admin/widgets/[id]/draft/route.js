import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { updateWidgetDraft } from "@/lib/widgets/store";

export async function PUT(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const body = await request.json();
    const widget = await updateWidgetDraft({
      id,
      config: body.config,
      actor: auth.actor,
    });
    if (!widget) return NextResponse.json({ error: "Widget not found" }, { status: 404 });
    return NextResponse.json({ widget });
  } catch (error) {
    const issues = error?.issues?.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return NextResponse.json(
      { error: "Invalid widget configuration", issues: issues || undefined },
      { status: 400 }
    );
  }
}
