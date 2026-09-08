import { NextResponse } from "next/server";

import { requireSameOrigin, requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  disableAdminComponentAndDiscardPlans,
  getAdminInventoryCache,
  listAdminComponentConfigs,
  saveAdminComponentConfig,
} from "@/lib/genesys/admin-console-store.mjs";
import { verifiedTtsConnectorProfiles } from "@/lib/genesys/tts-connector-profiles.mjs";
import { genesysTtsTestFlowName } from "@/lib/genesys/tts-connector-architect.mjs";
import { installationResourceNames } from "@/lib/genesys/installation-scope.mjs";

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const [components, cachedInventory] = await Promise.all([
    listAdminComponentConfigs(auth.actor.organizationId),
    getAdminInventoryCache(auth.actor.organizationId),
  ]);
  const ttsProfiles = verifiedTtsConnectorProfiles().map((profile) => ({
    id: profile.id,
    name: profile.displayName,
    provider: profile.provider,
    connectorName: profile.integrationName,
    testFlowName: genesysTtsTestFlowName(profile),
  }));
  return NextResponse.json({
    components,
    inventory: {
      ...(cachedInventory || {}),
      installation: installationResourceNames(),
      ttsProfiles,
      source: cachedInventory ? "cache" : "bootstrap",
    },
  });
}

export async function PATCH(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    if (body.enabled === false && body.discardPlans === true) {
      const result = await disableAdminComponentAndDiscardPlans({
        actor: auth.actor,
        component: body.component,
        config: body.config || {},
      });
      return NextResponse.json(result);
    }
    const component = await saveAdminComponentConfig({
      actor: auth.actor,
      component: body.component,
      enabled: body.enabled,
      config: body.config || {},
    });
    return NextResponse.json({ component });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
