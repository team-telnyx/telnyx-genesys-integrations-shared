import { handleGenesysMessagingHandoffRequest } from "@/lib/genesys/widget-messaging-handoff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  return handleGenesysMessagingHandoffRequest(request);
}
