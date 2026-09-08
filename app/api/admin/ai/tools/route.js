import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { listAdminManagedTools } from "@/lib/genesys/admin-managed-tools.mjs";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    readOnly: true,
    tools: await listAdminManagedTools(auth.actor.organizationId),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    error: "Assistant tools are owned by deployment rules and cannot be created manually",
  }, { status: 405, headers: { Allow: "GET" } });
}
