import { NextResponse } from "next/server";
import { widgetIconSvgMarkup } from "@/lib/widgets/icon-svg";
import {
  isWidgetOriginAllowed,
  publicWidgetConfig,
} from "@/lib/widgets/config";
import { getPublishedWidget, widgetOrganizationId } from "@/lib/widgets/store";
import { createWidgetBootstrapToken } from "@/lib/widgets/session-tokens";
import { normalizeTelnyxWebCallerNumber } from "@/lib/genesys/sip-transfer-tool.mjs";
import { getAdminCallbacksConfig, getAdminWebCallerNumber } from "@/lib/genesys/admin-console-store.mjs";

function responseHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function callerOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const requestOrigin = new URL(request.url).origin;
  const referer = request.headers.get("referer");
  if (!referer) return requestOrigin;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

async function loadAllowedWidget(request, publicId) {
  const widget = await getPublishedWidget(publicId);
  if (!widget) return { status: 404, error: "Widget not found or not published" };

  const origin = callerOrigin(request);
  const serverOrigin = new URL(request.url).origin;
  const sameOrigin = origin === serverOrigin;
  if (!origin || (!sameOrigin && !isWidgetOriginAllowed(origin, widget.config.allowedOrigins))) {
    return { status: 403, error: "Embedding origin is not allowed", origin };
  }
  return { widget, origin };
}

export async function GET(request, { params }) {
  const { publicId } = await params;
  const result = await loadAllowedWidget(request, publicId);
  if (!result.widget) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: result.origin ? responseHeaders(result.origin) : undefined }
    );
  }

  const organizationId = widgetOrganizationId(result.widget);
  let runtimeConfig = result.widget.config;
  let voiceCallerNumber = "";
  if (runtimeConfig.channels.voice.enabled) {
    try {
      // Web Calls owns this number; the environment value only keeps deployments
      // installed by the standalone CLI working until they save that profile.
      voiceCallerNumber = normalizeTelnyxWebCallerNumber(
        (await getAdminWebCallerNumber(organizationId)) || process.env.TELNYX_WIDGET_CALLER_NUMBER
      );
    } catch (error) {
      console.error(
        "[widget-bootstrap] Voice channel disabled for this response; select a WebRTC caller ID on the Web Calls page:",
        error.message
      );
      runtimeConfig = structuredClone(runtimeConfig);
      runtimeConfig.channels.voice.enabled = false;
    }
  }
  const callbackInfrastructure = result.widget.config.callbacks?.enabled
    ? await getAdminCallbacksConfig(organizationId)
    : null;
  const callbackExperience = result.widget.config.callbacks;
  return NextResponse.json(
    {
      widget: {
        id: result.widget.public_id,
        name: result.widget.name,
        revision: result.widget.version,
        bootstrapToken: createWidgetBootstrapToken({
          publicId: result.widget.public_id,
          revisionId: result.widget.revision_id,
          origin: result.origin,
        }),
        launcherIconSvg: widgetIconSvgMarkup(result.widget.config.components.launcher.icon),
        config: publicWidgetConfig(runtimeConfig, { voiceCallerNumber }),
        callbacks: callbackInfrastructure && callbackExperience?.enabled
          ? { ...callbackExperience, enabled: true }
          : { enabled: false },
      },
    },
    { headers: responseHeaders(result.origin) }
  );
}

export async function OPTIONS(request, context) {
  const { publicId } = await context.params;
  const result = await loadAllowedWidget(request, publicId);
  if (!result.widget) {
    return new NextResponse(null, { status: result.status });
  }
  return new NextResponse(null, { status: 204, headers: responseHeaders(result.origin) });
}
