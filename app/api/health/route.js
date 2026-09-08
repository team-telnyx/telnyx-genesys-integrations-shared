import { NextResponse } from "next/server";
import { missingGenesysAudioRuntimeVariables } from "@/lib/genesys/audio-connector-server.mjs";
import { checkPostgresStatus, isPostgresConfigured } from "@/lib/postgres.mjs";

/**
 * GET /api/health
 * Health check endpoint
 */
export async function GET() {
  const missingAudioConfiguration = missingGenesysAudioRuntimeVariables();
  const widgetConfigured = isPostgresConfigured();
  const database = widgetConfigured
    ? await checkPostgresStatus()
    : { ready: false, status: "disabled" };
  // PostgreSQL backs the widget, encrypted administration state and deployment
  // inventory. Reporting healthy without it lets a broken runtime env pass the
  // deployment health gate while every stateful endpoint returns 500.
  const serviceReady = widgetConfigured && database.ready;
  return NextResponse.json({
    status: serviceReady ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    service: "telnyx-genesys-integrations",
    audioConnector: {
      configured: missingAudioConfiguration.length === 0,
    },
    telnyxWebhooks: {
      signatureVerificationConfigured: Boolean(
        String(process.env.TELNYX_PUBLIC_KEY || "").trim()
      ),
    },
    database,
    widget: { configured: widgetConfigured, ready: widgetConfigured && database.ready },
  }, { status: serviceReady ? 200 : 503 });
}
