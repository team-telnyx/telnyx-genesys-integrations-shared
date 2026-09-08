import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    error: "Assistant tools are owned by deployment rules and cannot be edited manually",
  }, { status: 405 });
}
