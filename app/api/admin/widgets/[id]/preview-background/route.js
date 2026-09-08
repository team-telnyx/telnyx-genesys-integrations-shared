import { NextResponse } from "next/server";
import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { getWidget } from "@/lib/widgets/store";
import {
  deleteWidgetPreviewAsset,
  MAX_WIDGET_PREVIEW_BYTES,
  readWidgetPreviewAsset,
  writeWidgetPreviewAsset,
} from "@/lib/widgets/preview-assets";

export const runtime = "nodejs";

function previewVariant(request) {
  const variant = request.nextUrl.searchParams.get("variant") || "";
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(variant)) throw new Error("Invalid preview variant");
  return variant;
}

async function authorizedWidget(request, id) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return { error: auth.error };
  try {
    const widget = await getWidget(id, auth.actor.organizationId);
    return widget ? { widget } : { error: NextResponse.json({ error: "Widget not found" }, { status: 404 }) };
  } catch {
    return { error: NextResponse.json({ error: "Invalid widget ID" }, { status: 400 }) };
  }
}

export async function GET(request, { params }) {
  const { id } = await params;
  const access = await authorizedWidget(request, id);
  if (access.error) return access.error;
  try {
    const image = await readWidgetPreviewAsset(id, previewVariant(request));
    return new NextResponse(image, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "private, no-store",
        "content-length": String(image.length),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error?.code === "ENOENT") return NextResponse.json({ error: "Screenshot not found" }, { status: 404 });
    return NextResponse.json({ error: "Screenshot could not be read" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const { id } = await params;
  const access = await authorizedWidget(request, id);
  if (access.error) return access.error;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "Screenshot file is required" }, { status: 400 });
    }
    if (file.size > MAX_WIDGET_PREVIEW_BYTES) {
      return NextResponse.json({ error: "Screenshot exceeds the 8 MB stored-file limit" }, { status: 413 });
    }
    const url = await writeWidgetPreviewAsset(id, previewVariant(request), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Screenshot upload failed" }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const { id } = await params;
  const access = await authorizedWidget(request, id);
  if (access.error) return access.error;
  try {
    await deleteWidgetPreviewAsset(id, previewVariant(request));
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Screenshot delete failed" }, { status: 400 });
  }
}
