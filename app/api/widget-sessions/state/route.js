import { NextResponse } from "next/server";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken, touchWidgetSession } from "@/lib/widgets/sessions";
import {
  claimHandoffAgentLookup,
  getMessagingHandoffBySession,
  listHandoffMessages,
  markMessagingHandoffAssigned,
  markMessagingHandoffConnected,
  markMessagingHandoffDisconnected,
  serializeMessagingHandoff,
} from "@/lib/widgets/handoffs";
import { resolveGenesysConversationAgent } from "@/lib/genesys/widget-open-messaging";

export const dynamic = "force-dynamic";

// Open Messaging webhooks deliver messages and ephemeral typing events, but an
// agent being offered the conversation or accepting it is otherwise invisible.
// The conversation's participants carry both steps and are read while pending.
async function refreshHandoffAgentPresence(handoff) {
  if (!handoff || !(await claimHandoffAgentLookup(handoff.id))) return handoff;
  let agent;
  try {
    agent = await resolveGenesysConversationAgent({
      conversationId: handoff.genesys_conversation_id,
      fallbackName: handoff.agent_name,
    });
  } catch (error) {
    console.warn("[widget-session-state] agent presence lookup failed:", error.message);
    return handoff;
  }
  if (!agent?.userId) return handoff;
  const details = { agentUserId: agent.userId, agentImageUri: agent.imageUri };
  if (agent.state === "connected") await markMessagingHandoffConnected(handoff.id, agent.name, details);
  else if (agent.state === "alerting") await markMessagingHandoffAssigned(handoff.id, agent.name, details);
  else if (agent.state === "disconnected") await markMessagingHandoffDisconnected(handoff.id, agent.name);
  else return handoff;
  return getMessagingHandoffBySession(handoff.session_id);
}

export async function GET(request) {
  try {
    const session = await getWidgetSessionByToken(bearerToken(request));
    if (!session || session.channel !== "messaging") {
      return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
    }
    const handoff = await refreshHandoffAgentPresence(
      await getMessagingHandoffBySession(session.id)
    );
    const afterValue = new URL(request.url).searchParams.get("after");
    let after = null;
    if (afterValue) {
      const parsed = new Date(afterValue);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "Invalid after timestamp" }, { status: 400 });
      }
      after = parsed.toISOString();
    }
    const messages = handoff ? await listHandoffMessages(handoff.id, after, session.id) : [];
    const expiresAt = await touchWidgetSession(session);
    return NextResponse.json(
      { handoff: serializeMessagingHandoff(handoff), messages, expiresAt },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[widget-session-state]", error);
    return NextResponse.json({ error: "Unable to load chat state" }, { status: 500 });
  }
}
