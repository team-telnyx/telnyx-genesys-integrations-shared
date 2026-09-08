import { NextResponse } from "next/server";
import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import { downloadGenesysProfileImage } from "@/lib/genesys/profile-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  if (!auth.profileImageUri) {
    return NextResponse.json({ error: "Genesys profile picture is not configured" }, { status: 404 });
  }

  try {
    const image = await downloadGenesysProfileImage({
      imageUri: auth.profileImageUri,
      accessToken: auth.accessToken,
    });
    return new NextResponse(image.body, {
      status: 200,
      headers: {
        "content-type": image.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Genesys profile picture could not be loaded" }, { status: 502 });
  }
}
