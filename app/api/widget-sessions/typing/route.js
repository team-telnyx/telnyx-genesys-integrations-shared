import { NextResponse } from "next/server";
import { sendGenesysCustomerTyping } from "@/lib/genesys/widget-open-messaging";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken, touchWidgetSession } from "@/lib/widgets/sessions";
import {
  claimMessagingCustomerTyping,
  getMessagingHandoffBySession,
} from "@/lib/widgets/handoffs";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const session = await getWidgetSessionByToken(bearerToken(request));
    if (!session || session.channel !== "messaging") {
      return NextResponse.json({ error: "Chat session expired" }, { status: 401 });
    }
    if (!session.config.components.messages.agentTypingIndicator?.sendCustomerTyping) {
      return NextResponse.json({ accepted: true, sent: false });
    }
    const handoff = await getMessagingHandoffBySession(session.id);
    if (!handoff || handoff.status !== "connected") {
      return NextResponse.json({ accepted: true, sent: false });
    }
    const claimed = await claimMessagingCustomerTyping(handoff.id);
    if (!claimed) return NextResponse.json({ accepted: true, sent: false, throttled: true });

    await sendGenesysCustomerTyping({ handoff: claimed });
    const expiresAt = await touchWidgetSession(session);
    return NextResponse.json(
      { accepted: true, sent: true, expiresAt },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[widget-session-typing]", error);
    return NextResponse.json({ error: "Unable to send typing status" }, { status: 502 });
  }
}
