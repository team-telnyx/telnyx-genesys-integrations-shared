import { NextResponse } from "next/server";
import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({ authenticated: true, user: auth.actor });
}
