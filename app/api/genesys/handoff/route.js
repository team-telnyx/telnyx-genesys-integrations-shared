import { handleGenesysHandoffRequest } from "@/lib/genesys/handoff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  return handleGenesysHandoffRequest(request);
}
