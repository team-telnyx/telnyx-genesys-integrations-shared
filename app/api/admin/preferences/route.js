import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  getAdminUserPreferences,
  saveAdminUserPreferences,
} from "@/lib/genesys/admin-console-store.mjs";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({ preferences: await getAdminUserPreferences(auth.actor) });
}

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const preferences = await saveAdminUserPreferences(auth.actor, await request.json());
    return NextResponse.json({ preferences });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
