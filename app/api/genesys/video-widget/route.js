import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeVideoAgent, videoError } from "@/lib/genesys/video-conversation.mjs";
import { readGenesysAuthCookie, clearGenesysAccessTokenCookie } from "@/lib/genesys/auth-cookies.mjs";
import { requireSameOrigin } from "@/lib/genesys/admin-auth";
import { hydrateRuntimeSecrets } from "@/lib/genesys/encrypted-secret-store.mjs";
import { defaultRoomsClient } from "@/lib/video/rooms.mjs";
import { createVideoService } from "@/lib/video/service.mjs";
export const dynamic = "force-dynamic";
const actionSchema = z.object({ action: z.enum(["join", "token", "end"]), refreshToken: z.string().min(1).max(4096).optional() }).strict();
async function execute(request, mutation = false) {
  try {
    await hydrateRuntimeSecrets({ required: false });
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    const service = createVideoService();
    const row = await service.byConversation(conversationId);
    const auth = await authorizeVideoAgent({ conversationId, accessToken: readGenesysAuthCookie(request.cookies, "genesys_access_token"), allowCompleted: !mutation && row?.state === "ended" });
    if (!row) throw videoError("This interaction has no video session", 404);
    let data = await service.state(row.session_id);
    if (!mutation && new URL(request.url).searchParams.get("recordings") === "1") {
      if (row.state !== "ended") throw videoError("Recordings are available after the call ends", 409);
      const rooms = defaultRoomsClient();
      const recordings = [];
      if (row.composition_id) {
        const item = await rooms.getComposition(row.composition_id);
        if (item.download_url) recordings.push({ id: item.id, type: "video", url: item.download_url });
      } else if (row.composition_state === "audio_only") {
        for (const recording of row.recordings || []) {
          const item = await rooms.getRecording(recording.recording_id);
          if (item.download_url) recordings.push({ id: item.id, type: "audio", url: item.download_url });
        }
      }
      data.recordings = recordings;
      data.recordingState = recordings.length ? "ready" : row.recording_enabled ? "processing" : "disabled";
    }
    if (mutation) {
      const input = actionSchema.parse(await request.json());
      if (!auth.accepted) throw videoError("Accept the Genesys interaction before joining video", 409);
      if (input.action === "end") data = await service.end(row.session_id, "agent_ended");
      else {
        if (input.action === "token" && !input.refreshToken) throw videoError("Refresh token required", 400);
        data = await service.join(row.session_id, { owner: `agent:${auth.agent.id}`, agent: auth.agent,
          ...(input.action === "token" ? { refreshToken: input.refreshToken } : {}) });
      }
    }
    return NextResponse.json({ ...data, accepted: auth.accepted, agent: { id: auth.agent.id, name: auth.agent.name } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : Number(error.status || 500);
    if (status >= 500) console.error("[genesys-video]", error.message);
    const response = NextResponse.json({ error: status >= 500 ? "Video service unavailable" : error.message }, { status, headers: { "Cache-Control": "no-store" } });
    return status === 401 ? clearGenesysAccessTokenCookie(response) : response;
  }
}
export const GET = (request) => execute(request);
export async function POST(request) {
  const originError = await requireSameOrigin(request);
  return originError || execute(request, true);
}
