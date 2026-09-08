import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Telnyx from "telnyx";

import {
  finishAdminDeploymentRun,
  startAdminDeploymentRun,
  updateAdminDeploymentStep,
} from "./admin-console-store.mjs";
import {
  ADMIN_COMPONENT_CATALOG,
  ADMIN_SHARED_TTS_WARNING,
  adminComponentPlanSummary,
  normalizeAdminComponentConfig,
} from "./admin-components.mjs";
import { hydrateRuntimeSecrets } from "./encrypted-secret-store.mjs";
import { loadAdminConsoleGenesysContext } from "./admin-console-installer.mjs";
import {
  buildTtsDeploymentInventory,
  resolveAdminTtsCredential,
} from "./admin-inventory.mjs";
import { loadTtsInventory } from "./tts-connector-genesys.mjs";
import { getTtsConnectorProfile } from "./tts-connector-profiles.mjs";
import {
  DEFAULT_MAX_PLAN_AGE_MS,
  inventorySnapshotHash,
} from "./tts-connector-manager.mjs";
import { checkTunnelHealth } from "./cloudflare-quick-tunnel.mjs";
import {
  normalizePublicApplicationOrigin,
  updateManagedPublicOrigin,
} from "./public-origin-manager.mjs";
import {
  ADMIN_SHARED_HANDOFF_TOOL_KEY,
  ADMIN_SHARED_HANGUP_TOOL_KEY,
  ADMIN_SHARED_INVITE_TOOL_KEY,
  ADMIN_SHARED_SKIP_TURN_TOOL_KEY,
  getAdminManagedTool,
  registerAdminManagedTelnyxTool,
} from "./admin-managed-tools.mjs";
import {
  registerAdminAudioObservedResources,
  registerAdminCallbackCampaignObservedResources,
} from "./admin-desired-state.mjs";
import { registerManagedResourceBatch } from "./managed-resource-registry.mjs";

const activeRuns = new Map();
const ADMIN_TTS_STATE_DIRECTORY = path.resolve(".genesys-admin", "tts");
export function assertSharedTtsPlanFresh(plan, now = Date.now()) {
  const createdAt = Date.parse(String(plan?.createdAt || ""));
  if (!Number.isFinite(createdAt) || now - createdAt > DEFAULT_MAX_PLAN_AGE_MS) {
    throw new Error(
      "The shared TTS plan is stale. Refresh the Genesys inventory and build a new plan before applying changes."
    );
  }
  if (plan?.scopeType !== "organization" || !String(plan?.organization?.id || "").trim()) {
    throw new Error("The shared TTS plan is missing its Genesys organization scope");
  }
}

export function sharedTtsInventoryFingerprint(live = {}, rawInventory = []) {
  const connectors = rawInventory.length
    ? rawInventory.map((entry) => ({
        integrationId: entry.integration?.id || null,
        name: entry.integration?.name || null,
        observedSnapshotHash: inventorySnapshotHash(entry),
      }))
    : (live.deployments || []).map((entry) => ({
        integrationId: entry.integrationId || null,
        profileId: entry.profileId || null,
        name: entry.name || null,
        managed: entry.managed === true,
        observedSnapshotHash: entry.observedSnapshotHash || null,
      }));
  connectors.sort((left, right) =>
    `${left.profileId || ""}\n${left.integrationId}`.localeCompare(
      `${right.profileId || ""}\n${right.integrationId}`
    )
  );
  const flows = (live.flows || []).map((entry) => ({
    id: entry.id || null,
    profileId: entry.profileId || null,
    integrationId: entry.integrationId || null,
    name: entry.name || null,
    description: entry.description || "",
  })).sort((left, right) =>
    `${left.profileId}\n${left.id}`.localeCompare(`${right.profileId}\n${right.id}`)
  );
  return createHash("sha256")
    .update(JSON.stringify({ connectors, flows }))
    .digest("hex");
}

async function registerAppliedAdminTools(run, result) {
  if (!["audio", "widget"].includes(run.component)) return [];
  const organizationId = String(
    run.plan?.installerPlan?.organization?.id || process.env.GC_ORGANIZATION_ID || ""
  ).trim();
  if (!organizationId) throw new Error("Genesys organization ID is unavailable for tool registry");
  const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
  if (run.component === "audio") {
    const resources = result?.run?.resources || {};
    return Promise.all([
      registerAdminManagedTelnyxTool({
        telnyx,
        organizationId,
        logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
        remoteToolId: resources.toolId,
        component: "audio",
        deploymentId: run.config?.deploymentId || "CECA32",
        assistantIds: resources.assistantIds || [],
      }),
      registerAdminManagedTelnyxTool({
        telnyx,
        organizationId,
        logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY,
        remoteToolId: resources.hangupToolId,
        component: "audio",
        deploymentId: run.config?.deploymentId || "CECA32",
        assistantIds: resources.hangupAssistantIds || [],
      }),
      // Invite and skip turn are unusable on an Audio Connector call, which
      // Architect has already bridged into Genesys. They are provisioned here
      // because this is where shared tools are created, so a Web Calls widget
      // can adopt them and any assistant can be given them later.
      ...(resources.inviteToolId ? [registerAdminManagedTelnyxTool({
        telnyx,
        organizationId,
        logicalKey: ADMIN_SHARED_INVITE_TOOL_KEY,
        remoteToolId: resources.inviteToolId,
        component: "audio",
        deploymentId: run.config?.deploymentId || "CECA32",
        assistantIds: [],
      })] : []),
      ...(resources.skipTurnToolId ? [registerAdminManagedTelnyxTool({
        telnyx,
        organizationId,
        logicalKey: ADMIN_SHARED_SKIP_TURN_TOOL_KEY,
        remoteToolId: resources.skipTurnToolId,
        component: "audio",
        deploymentId: run.config?.deploymentId || "CECA32",
        assistantIds: [],
      })] : []),
    ]);
  }
  return [await registerAdminManagedTelnyxTool({
    telnyx,
    organizationId,
    logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
    remoteToolId: result?.manifest?.resources?.telnyxHandoffToolId,
    component: "widget",
    deploymentId: "WEBCHAT",
    assistantIds: [],
  })];
}

async function materializeInstallerPlan(run) {
  const savedPath = String(run.installerPlanPath || "").trim();
  if (savedPath) {
    try {
      await access(savedPath);
      return savedPath;
    } catch {
      // A web node may restart or another replica may execute the accepted plan.
    }
  }
  const installerPlan = run.plan?.installerPlan;
  const planForDisk = installerPlan?.connectorPlan || installerPlan;
  if (!planForDisk?.planId) {
    throw new Error("The accepted installer plan is unavailable; create a fresh plan");
  }
  const directory = path.resolve(".genesys-admin", "plans");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = path.join(directory, `${run.id}.json`);
  await writeFile(outputPath, `${JSON.stringify(planForDisk, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  return outputPath;
}

function ttsActionLabel(action) {
  const verb = {
    CREATE: "Create",
    UPDATE: "Update",
    DELETE: "Delete",
    RETAIN: "Retain",
  }[action.action] || action.action;
  const resource = action.resource === "connector" ? "connector" : "test flow";
  return `${verb} ${resource} — ${action.profileName}`;
}

export function assignTtsOperationSteps(changes) {
  const actions = [{
    ordinal: 0,
    kind: "inventory-validate",
    label: "Load and validate the live Genesys TTS inventory",
  }];
  const changedProfiles = [...changes].sort((left, right) =>
    left.profileName.localeCompare(right.profileName)
  );
  for (const change of changedProfiles) {
    actions.push({
      ordinal: actions.length,
      kind: "provider-validate",
      profileId: change.profileId,
      profileName: change.profileName,
      label: `Validate current state — ${change.profileName}`,
    });
  }
  const phases = [
    ["connector", ["CREATE", "UPDATE"]],
    ["connector", ["DELETE"]],
    ["flow", ["DELETE"]],
    ["flow", ["CREATE", "UPDATE"]],
    ["flow", ["RETAIN"]],
  ];
  for (const [resource, allowedActions] of phases) {
    for (const change of changedProfiles) {
      const action = resource === "connector" ? change.connectorAction : change.flowAction;
      if (!allowedActions.includes(action)) continue;
      actions.push({
        ordinal: actions.length,
        kind: `${resource}-${action.toLowerCase()}`,
        resource,
        action,
        profileId: change.profileId,
        profileName: change.profileName,
        label: ttsActionLabel({ resource, action, profileName: change.profileName }),
      });
    }
  }
  actions.push({
    ordinal: actions.length,
    kind: "inventory-verify",
    label: "Verify the resulting Genesys TTS inventory",
  });
  return actions;
}

async function prepareAdminTtsReconcile(config) {
  const requestedProfileIds = new Set([...config.profiles, ...config.testFlowProfiles]);
  for (const profileId of requestedProfileIds) {
    const profile = getTtsConnectorProfile(profileId);
    if (!profile || profile.status !== "verified") {
      throw new Error(`Unknown or blocked TTS provider ${profileId}`);
    }
  }
  const context = await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  const rawInventory = await loadTtsInventory(context.integrationsApi);
  const live = await buildTtsDeploymentInventory({
    inventory: rawInventory,
    architectApi: context.architectApi,
  });
  const deploymentByProfile = new Map();
  for (const deployment of live.deployments) {
    if (deploymentByProfile.has(deployment.profileId)) {
      throw new Error(`Multiple TTS connectors are mapped to ${deployment.profileName}`);
    }
    deploymentByProfile.set(deployment.profileId, deployment);
  }
  const flowByProfile = new Map();
  for (const flow of live.flows) {
    if (flowByProfile.has(flow.profileId)) {
      throw new Error(`Multiple managed Architect test flows are mapped to ${flow.profileId}`);
    }
    flowByProfile.set(flow.profileId, flow);
  }
  const desiredConnectors = new Set(config.profiles);
  const desiredFlows = new Set(config.testFlowProfiles);
  for (const profileId of desiredFlows) {
    if (!desiredConnectors.has(profileId) && !flowByProfile.has(profileId)) {
      throw new Error(`A test flow for ${profileId} requires a connector`);
    }
  }

  const profilesToCreate = config.profiles.filter((profileId) =>
    !deploymentByProfile.has(profileId)
  );
  let connectorPrepared = null;
  if (profilesToCreate.length) {
    const { createTtsInstallationPlan } = await import("../../scripts/manage-genesys-telnyx-tts.mjs");
    const credential = await resolveAdminTtsCredential(context.integrationsApi, rawInventory);
    if (credential.mode === "conflict") {
      throw new Error(
        "Managed Telnyx TTS connectors use multiple Genesys credentials. Reconcile them to one credential before using the Web Admin desired-state editor."
      );
    }
    connectorPrepared = await createTtsInstallationPlan({
      profiles: profilesToCreate,
      credentialId: credential.mode === "existing" ? credential.id : "",
      createCredential: credential.mode === "create",
      credentialName: "Telnyx TTS credential",
      stateDirectory: ADMIN_TTS_STATE_DIRECTORY,
    });
  }
  const allProfileIds = new Set([
    ...deploymentByProfile.keys(),
    ...flowByProfile.keys(),
    ...desiredConnectors,
    ...desiredFlows,
  ]);
  const changes = [];
  for (const profileId of allProfileIds) {
    const profile = getTtsConnectorProfile(profileId);
    if (!profile) continue;
    const deployment = deploymentByProfile.get(profileId) || null;
    const flow = flowByProfile.get(profileId) || null;
    const connectorDesired = desiredConnectors.has(profileId);
    const flowDesired = desiredFlows.has(profileId);
    if (deployment && !deployment.managed && !connectorDesired) {
      throw new Error(`${profile.displayName} is not owned by this installer and cannot be deleted here`);
    }
    let connectorAction = "NONE";
    if (connectorDesired && !deployment) {
      connectorAction = "CREATE";
    } else if (!connectorDesired && deployment) {
      connectorAction = "DELETE";
    }
    let flowAction = "NONE";
    if (flowDesired && !flow) flowAction = "CREATE";
    else if (!flowDesired && flow) flowAction = "DELETE";
    else if (flowDesired && flow && connectorAction === "DELETE") flowAction = "RETAIN";
    else if (
      flowDesired && flow &&
      (connectorAction === "CREATE" ||
        (deployment && flow.integrationId !== deployment.integrationId))
    ) flowAction = "UPDATE";
    if (connectorAction === "NONE" && flowAction === "NONE") continue;
    changes.push({
      profileId,
      profileName: profile.displayName,
      connectorName: deployment?.name || profile.integrationName,
      connectorAction,
      flowName: flow?.name || `${profile.integrationName} - Test Flow`,
      flowAction,
      current: {
        connector: deployment ? {
          integrationId: deployment.integrationId,
          name: deployment.name,
          expectedSnapshotHash: deployment.observedSnapshotHash,
        } : null,
        flow,
      },
    });
  }
  if (!changes.length) throw new Error("The requested TTS state already matches Genesys Cloud");
  const operationSteps = assignTtsOperationSteps(changes);
  const connectorPlanRequired = changes.some((change) =>
    ["CREATE", "UPDATE"].includes(change.connectorAction)
  );
  const installerPlan = {
    schemaVersion: 1,
    planId: randomUUID(),
    operation: "reconcile",
    createdAt: new Date().toISOString(),
    environment: process.env.GC_ENVIRONMENT,
    organization: context.organization,
    scopeType: "organization",
    inventoryFingerprint: sharedTtsInventoryFingerprint(live, rawInventory),
    desiredState: config,
    changes,
    operationSteps,
    connectorPlanRequired,
    connectorPlan: connectorPrepared?.plan || null,
  };
  const resources = operationSteps
    .filter((step) => step.resource)
    .map((step) => {
      const change = changes.find((entry) => entry.profileId === step.profileId);
      return {
        action: step.action,
        type: step.resource === "connector" ? "Genesys TTS Connector" : "Genesys Architect test flow",
        name: step.resource === "connector" ? change.connectorName : change.flowName,
      };
    });
  return {
    config,
    installerPlan,
    installerPlanPath: connectorPlanRequired ? connectorPrepared?.outputPath || null : null,
    operation: "reconcile",
    summary: { target: context.organization, resources, warnings: [ADMIN_SHARED_TTS_WARNING] },
    steps: operationSteps.map((step) => step.label),
  };
}

export async function prepareAdminDeployment(component, inputConfig) {
  await hydrateRuntimeSecrets({ required: true });
  const config = normalizeAdminComponentConfig(component, inputConfig);
  if (component === "tts") {
    return prepareAdminTtsReconcile(config);
  }
  if (component === "audio") {
    const {
      audioInstallationStepLabels,
      connectGenesysAudio,
      createAudioInstallationPlan,
    } = await import("../../scripts/manage-genesys-audio.mjs");
    const context = await connectGenesysAudio();
    const [managedHandoffTool, managedHangupTool] = await Promise.all([
      getAdminManagedTool({
        organizationId: context.organization.id,
        logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
      }),
      getAdminManagedTool({
        organizationId: context.organization.id,
        logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY,
      }),
    ]);
    const prepared = await createAudioInstallationPlan(context, {
      applicationName: config.applicationName,
      deploymentId: config.deploymentId,
      queueIds: config.queueIds,
      defaultQueueId: config.defaultQueueId,
      widgetGroupIds: config.widgetGroupIds,
      assistantRoutes: config.routes,
      defaultAssistant: {
        enabled: config.createDefaultAssistant,
        name: config.assistantName,
        useCase: config.assistantUseCase,
        instructions: config.assistantInstructions,
        greeting: config.assistantGreeting,
      },
      managedHandoffTool,
      managedHangupTool,
    });
    return {
      config: {
        ...config,
        allowedQueues: prepared.plan.queues,
        defaultQueueName: prepared.plan.defaultQueue?.name || "",
      },
      installerPlan: prepared.plan,
      installerPlanPath: prepared.outputPath,
      summary: adminComponentPlanSummary(component, prepared.plan),
      steps: audioInstallationStepLabels(prepared.plan),
    };
  }
  if (component === "callbacks") {
    const { prepareCallbacksDeployment } = await import("./callbacks-manager.mjs");
    return prepareCallbacksDeployment(config);
  }
  const { createWidgetInfrastructurePlan } = await import("../../scripts/manage-genesys-widget.mjs");
  const managedHandoffTool = await getAdminManagedTool({
    organizationId: process.env.GC_ORGANIZATION_ID,
    logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
  });
  const prepared = await createWidgetInfrastructurePlan({
    queueIds: config.queueIds,
    defaultQueueId: config.defaultQueueId,
    managedHandoffTool,
  });
  return {
    config: {
      ...config,
      allowedQueues: prepared.plan.messaging.queues,
      defaultQueueName: prepared.plan.messaging.defaultQueue.name,
    },
    installerPlan: prepared.plan,
    installerPlanPath: prepared.outputPath,
    summary: adminComponentPlanSummary(component, prepared.plan),
    steps: ADMIN_COMPONENT_CATALOG[component].steps,
  };
}

export async function prepareAdminPublicOriginChange({ baseUrl } = {}) {
  await hydrateRuntimeSecrets({ required: true, force: true });
  const publicBaseUrl = normalizePublicApplicationOrigin(baseUrl);
  const previousBaseUrl = normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL);
  if (publicBaseUrl === previousBaseUrl) {
    throw new Error("The new public application URL is already configured");
  }
  const health = await checkTunnelHealth(publicBaseUrl, { timeoutMs: 10_000 });
  if (!health.ok) {
    throw new Error(
      `The new public URL did not return the expected application health response${health.error ? `: ${health.error}` : health.status ? ` (HTTP ${health.status})` : ""}`
    );
  }
  const context = await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  const [audioModule, widgetModule] = await Promise.all([
    import("../../scripts/manage-genesys-audio.mjs"),
    import("../../scripts/manage-genesys-widget.mjs"),
  ]);
  const [audioDeployments, widgetDeployments, widgetInfrastructure] = await Promise.all([
    audioModule.listManagedAudioDeployments(),
    widgetModule.listManagedWidgetDeployments(),
    widgetModule.readWidgetInfrastructureManifest(),
  ]);
  const progressSteps = [
    "Validate the new public application URL",
    ...audioDeployments.flatMap((deployment) => {
      const name = deployment.deployment.name;
      return [
        `Updating Telnyx tool for ${name}`,
        `Updating Genesys widget and OAuth for ${name}`,
        `Updating Genesys Audio Connector for ${name}`,
      ];
    }),
    ...widgetDeployments.map((deployment) =>
      `Updating widget deployment ${deployment.deployment.name}`
    ),
    ...(widgetInfrastructure ? ["Updating shared Web Chat infrastructure"] : []),
    "Save the encrypted public application URL",
  ];
  return {
    config: { baseUrl: publicBaseUrl },
    installerPlan: {
      schemaVersion: 1,
      planId: randomUUID(),
      operation: "public-origin",
      createdAt: new Date().toISOString(),
      organization: { id: context.organization.id, name: context.organization.name },
      previousBaseUrl,
      publicBaseUrl,
      audioDeploymentIds: audioDeployments.map((deployment) => deployment.deployment.id),
      widgetDeploymentIds: widgetDeployments.map((deployment) => deployment.deployment.id),
      widgetInfrastructure: Boolean(widgetInfrastructure),
    },
    installerPlanPath: null,
    operation: "public-origin",
    summary: {
      target: context.organization,
      resources: [
        ...audioDeployments.map((deployment) => ({
          action: "UPDATE",
          type: "Audio deployment public URLs",
          name: deployment.deployment.name,
        })),
        ...widgetDeployments.map((deployment) => ({
          action: "UPDATE",
          type: "Widget deployment public URLs",
          name: deployment.deployment.name,
        })),
        ...(widgetInfrastructure ? [{
          action: "UPDATE",
          type: "Web Chat infrastructure public URLs",
          name: widgetInfrastructure.deployment.name,
        }] : []),
        { action: "SAVE", type: "Encrypted runtime configuration", name: "GC_PUBLIC_BASE_URL" },
      ],
      warnings: ["If any remote update fails, the synchronizer attempts to restore the previous URL."],
      previousBaseUrl,
      publicBaseUrl,
    },
    steps: progressSteps,
  };
}

export async function prepareAdminTtsDestroy({
  integrationId,
  deleteAssociatedFlows = true,
} = {}) {
  await hydrateRuntimeSecrets({ required: true });
  const normalizedIntegrationId = String(integrationId || "").trim();
  if (!normalizedIntegrationId) throw new Error("TTS connector is required");
  const context = await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  const inventory = await loadTtsInventory(context.integrationsApi);
  const live = await buildTtsDeploymentInventory({
    inventory,
    architectApi: context.architectApi,
  });
  const deployment = live.deployments.find(
    (entry) => entry.integrationId === normalizedIntegrationId
  );
  if (!deployment) throw new Error("The selected Telnyx TTS connector no longer exists");
  if (!deployment.managed) {
    throw new Error("Only connectors managed by this installer can be destroyed from the admin console");
  }
  const flows = deleteAssociatedFlows ? deployment.testFlows : [];
  const installerPlan = {
    schemaVersion: 1,
    planId: randomUUID(),
    operation: "destroy",
    createdAt: new Date().toISOString(),
    environment: process.env.GC_ENVIRONMENT,
    organization: context.organization,
    scopeType: "organization",
    target: {
      integrationId: deployment.integrationId,
      name: deployment.name,
      profileId: deployment.profileId,
      expectedSnapshotHash: deployment.observedSnapshotHash,
    },
    deleteAssociatedFlows: Boolean(deleteAssociatedFlows),
    testFlows: flows,
  };
  return {
    config: {
      integrationId: deployment.integrationId,
      deleteAssociatedFlows: Boolean(deleteAssociatedFlows),
    },
    installerPlan,
    installerPlanPath: null,
    operation: "destroy",
    summary: {
      target: context.organization,
      resources: [
        { action: "DELETE", type: "Genesys TTS Connector", name: deployment.name },
        ...flows.map((flow) => ({
          action: "DELETE",
          type: "Genesys Architect test flow",
          name: flow.name,
        })),
        ...(!deleteAssociatedFlows && deployment.testFlows.length ? [{
          action: "RETAIN",
          type: "Genesys Architect test flow",
          name: deployment.testFlows.map((flow) => flow.name).join(", "),
        }] : []),
      ],
      warnings: [
        ADMIN_SHARED_TTS_WARNING,
        "This operation removes shared organization resources and can affect every installation using them.",
      ],
    },
    steps: [
      "Revalidate the connector and ownership markers",
      "Disable and delete the Genesys TTS Connector",
      deleteAssociatedFlows
        ? "Delete associated managed Architect test flows"
        : "Retain associated Architect test flows",
      "Verify the resulting Genesys inventory",
    ],
  };
}

function ttsPlanStep(plan, kind, profileId) {
  return plan.operationSteps.find((step) =>
    step.kind === kind && (!profileId || step.profileId === profileId)
  );
}

async function applyPreparedTtsReconcile(run) {
  const plan = run.plan.installerPlan;
  let activeOrdinal = 0;
  const executeStep = async (step, runningDetail, operation) => {
    if (!step) throw new Error(`TTS execution step is missing for ${runningDetail}`);
    activeOrdinal = step.ordinal;
    await updateAdminDeploymentStep(run.id, step.ordinal, "running", runningDetail);
    try {
      const result = await operation();
      await updateAdminDeploymentStep(run.id, step.ordinal, "succeeded", result?.detail || runningDetail);
      return result?.value ?? result;
    } catch (error) {
      await updateAdminDeploymentStep(run.id, step.ordinal, "failed", error?.message || String(error));
      error.adminStepOrdinal = step.ordinal;
      throw error;
    }
  };

  let live;
  await executeStep(
    ttsPlanStep(plan, "inventory-validate"),
    "Loading the current connector and Architect flow inventory",
    async () => {
      const context = await loadAdminConsoleGenesysContext({
        environment: process.env.GC_ENVIRONMENT,
        clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
        clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
      });
      if (context.organization.id !== plan.organization.id) {
        throw new Error("The accepted TTS plan belongs to another Genesys organization");
      }
      const inventory = await loadTtsInventory(context.integrationsApi);
      live = await buildTtsDeploymentInventory({ inventory, architectApi: context.architectApi });
      const fingerprint = sharedTtsInventoryFingerprint(live, inventory);
      if (!plan.inventoryFingerprint || fingerprint !== plan.inventoryFingerprint) {
        throw new Error(
          "The organization-wide TTS connector or managed-flow inventory changed after plan review; create a fresh plan"
        );
      }
      return { detail: `Loaded ${inventory.length} TTS connector instance(s)` };
    }
  );

  const liveDeploymentByProfile = new Map(live.deployments.map((entry) => [entry.profileId, entry]));
  const liveFlowByProfile = new Map(live.flows.map((entry) => [entry.profileId, entry]));
  for (const change of plan.changes) {
    await executeStep(
      ttsPlanStep(plan, "provider-validate", change.profileId),
      `Comparing ${change.profileName} with the accepted plan`,
      async () => {
        const deployment = liveDeploymentByProfile.get(change.profileId) || null;
        const flow = liveFlowByProfile.get(change.profileId) || null;
        if (change.current.connector) {
          if (!deployment || deployment.integrationId !== change.current.connector.integrationId) {
            throw new Error(`${change.profileName} connector changed or disappeared after plan review`);
          }
          if (deployment.observedSnapshotHash !== change.current.connector.expectedSnapshotHash) {
            throw new Error(`${change.profileName} connector configuration changed after plan review`);
          }
        } else if (deployment) {
          throw new Error(`${change.profileName} connector appeared after plan review`);
        }
        if (change.current.flow) {
          if (!flow || flow.id !== change.current.flow.id || flow.description !== change.current.flow.description) {
            throw new Error(`${change.profileName} Architect test flow changed after plan review`);
          }
        } else if (flow) {
          throw new Error(`${change.profileName} Architect test flow appeared after plan review`);
        }
        return { detail: `${change.profileName} matches the reviewed inventory snapshot` };
      }
    );
  }

  const {
    applyTtsInstallationPlan,
    deleteTtsArchitectTestFlows,
    destroyTtsIntegrations,
    publishTtsArchitectTestFlows,
  } = await import("../../scripts/manage-genesys-telnyx-tts.mjs");
  const result = { connectors: null, deletedConnectors: [], flows: [], deletedFlows: [] };
  if (plan.connectorPlanRequired) {
    let progressChain = Promise.resolve();
    let providerFailure;
    let connectorEventOrdinal = null;
    const firstConnectorStep = plan.operationSteps.find((step) =>
      step.resource === "connector" && ["CREATE", "UPDATE"].includes(step.action)
    );
    try {
      result.connectors = await applyTtsInstallationPlan(run.installerPlanPath, {
        stateDirectory: ADMIN_TTS_STATE_DIRECTORY,
        onProgress(event) {
          if (event?.phase !== "provider" || !event.profileId) return;
          const change = plan.changes.find((entry) => entry.profileId === event.profileId);
          if (!change || !["CREATE", "UPDATE"].includes(change.connectorAction)) return;
          const step = ttsPlanStep(plan, `connector-${change.connectorAction.toLowerCase()}`, change.profileId);
          if (!step) return;
          activeOrdinal = step.ordinal;
          connectorEventOrdinal = step.ordinal;
          const status = event.status === "success"
            ? "succeeded"
            : event.status === "failure"
              ? "failed"
              : "running";
          if (status === "failed") providerFailure = event.label;
          progressChain = progressChain.then(() =>
            updateAdminDeploymentStep(run.id, step.ordinal, status, event.label || "Applying connector change")
          );
        },
      });
    } catch (error) {
      await progressChain;
      const ordinal = connectorEventOrdinal ?? firstConnectorStep?.ordinal ?? 0;
      await updateAdminDeploymentStep(run.id, ordinal, "failed", error?.message || String(error));
      error.adminStepOrdinal = ordinal;
      throw error;
    }
    await progressChain;
    if (providerFailure) {
      const error = new Error(providerFailure);
      error.adminStepOrdinal = activeOrdinal;
      throw error;
    }
  }

  const connectorResultByProfile = new Map(
    (result.connectors?.results || []).map((entry) => [entry.profileId, entry])
  );
  for (const change of plan.changes.filter((entry) => entry.connectorAction === "DELETE")) {
    const step = ttsPlanStep(plan, "connector-delete", change.profileId);
    const deleted = await executeStep(step, `Disabling and deleting ${change.connectorName}`, async () => {
      const outcome = await destroyTtsIntegrations(
        [{
          integrationId: change.current.connector.integrationId,
          expectedSnapshotHash: change.current.connector.expectedSnapshotHash,
        }],
        { expectedOrganizationId: plan.organization.id }
      );
      return { value: outcome, detail: `${change.connectorName} deleted` };
    });
    result.deletedConnectors.push(...(deleted.deleted || []));
  }

  for (const change of plan.changes.filter((entry) => entry.flowAction === "DELETE")) {
    const step = ttsPlanStep(plan, "flow-delete", change.profileId);
    const deleted = await executeStep(step, `Deleting ${change.flowName}`, async () => {
      const outcome = await deleteTtsArchitectTestFlows([change.current.flow]);
      return { value: outcome, detail: `${change.flowName} deleted` };
    });
    result.deletedFlows.push(...(deleted.deleted || []));
  }

  for (const change of plan.changes.filter((entry) => ["CREATE", "UPDATE"].includes(entry.flowAction))) {
    const step = ttsPlanStep(plan, `flow-${change.flowAction.toLowerCase()}`, change.profileId);
    await executeStep(step, `Publishing ${change.flowName}`, async () => {
      const connectorResult = connectorResultByProfile.get(change.profileId);
      const integrationId = connectorResult?.integrationId ||
        liveDeploymentByProfile.get(change.profileId)?.integrationId;
      if (!integrationId) throw new Error(`Connector ID is unavailable for ${change.profileName}`);
      const outcome = await publishTtsArchitectTestFlows([{
        integrationId,
        profile: getTtsConnectorProfile(change.profileId),
      }]);
      if (outcome.skipped.length) throw new Error(outcome.skipped[0].reason);
      result.flows.push(...outcome.flows);
      return { detail: `${change.flowName} published` };
    });
  }

  for (const change of plan.changes.filter((entry) => entry.flowAction === "RETAIN")) {
    await executeStep(
      ttsPlanStep(plan, "flow-retain", change.profileId),
      `Retaining ${change.flowName}`,
      async () => ({ detail: `${change.flowName} retained without modification` })
    );
  }

  await executeStep(
    ttsPlanStep(plan, "inventory-verify"),
    "Refreshing and verifying the resulting Genesys state",
    async () => {
      const context = await loadAdminConsoleGenesysContext({
        environment: process.env.GC_ENVIRONMENT,
        clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
        clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
      });
      const inventory = await loadTtsInventory(context.integrationsApi);
      const finalState = await buildTtsDeploymentInventory({ inventory, architectApi: context.architectApi });
      const actualConnectors = new Set(finalState.deployments.map((entry) => entry.profileId));
      const actualFlows = new Set(finalState.flows.map((entry) => entry.profileId));
      const expectedConnectors = new Set(plan.desiredState.profiles);
      const expectedFlows = new Set(plan.desiredState.testFlowProfiles);
      const connectorMismatch = [...new Set([...actualConnectors, ...expectedConnectors])]
        .find((profileId) => actualConnectors.has(profileId) !== expectedConnectors.has(profileId));
      const flowMismatch = [...new Set([...actualFlows, ...expectedFlows])]
        .find((profileId) => actualFlows.has(profileId) !== expectedFlows.has(profileId));
      if (connectorMismatch || flowMismatch) {
        throw new Error(`Genesys inventory does not match the requested state for ${connectorMismatch || flowMismatch}`);
      }
      return {
        detail: `${actualConnectors.size} connector(s) and ${actualFlows.size} managed test flow(s) verified`,
      };
    }
  );
  return { result, activeOrdinal };
}

function publicOriginProgressKey(label) {
  return String(label || "").replace(/^(?:Updating|Updated)\s+/i, "").trim().toLowerCase();
}

function sameIdSet(left = [], right = []) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

async function applyPreparedPublicOrigin(run) {
  let currentStep = 0;
  let progressChain = Promise.resolve();
  try {
    await hydrateRuntimeSecrets({ required: true, force: true });
    const plan = run.plan?.installerPlan;
    if (plan?.operation !== "public-origin") throw new Error("Public URL plan is invalid");
    const currentBaseUrl = normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL);
    if (currentBaseUrl !== plan.previousBaseUrl) {
      throw new Error("GC_PUBLIC_BASE_URL changed after plan review; create a fresh plan");
    }
    await updateAdminDeploymentStep(run.id, 0, "running", `Checking ${plan.publicBaseUrl}/api/health`);
    const health = await checkTunnelHealth(plan.publicBaseUrl, { timeoutMs: 10_000 });
    if (!health.ok) {
      throw new Error(
        `The new public URL is unavailable${health.error ? `: ${health.error}` : health.status ? ` (HTTP ${health.status})` : ""}`
      );
    }
    const [audioModule, widgetModule] = await Promise.all([
      import("../../scripts/manage-genesys-audio.mjs"),
      import("../../scripts/manage-genesys-widget.mjs"),
    ]);
    const [audioDeployments, widgetDeployments] = await Promise.all([
      audioModule.listManagedAudioDeployments(),
      widgetModule.listManagedWidgetDeployments(),
    ]);
    if (
      !sameIdSet(audioDeployments.map((entry) => entry.deployment.id), plan.audioDeploymentIds) ||
      !sameIdSet(widgetDeployments.map((entry) => entry.deployment.id), plan.widgetDeploymentIds)
    ) {
      throw new Error("Managed deployment inventory changed after plan review; create a fresh plan");
    }
    await updateAdminDeploymentStep(run.id, 0, "succeeded", "Public application health and managed deployment inventory verified");

    const stepByKey = new Map(
      run.steps.slice(1, -1).map((step) => [publicOriginProgressKey(step.label), step.ordinal])
    );
    const onProgress = (event) => {
      const ordinal = stepByKey.get(publicOriginProgressKey(event?.label));
      if (!Number.isInteger(ordinal)) return;
      currentStep = ordinal;
      const status = event?.status === "success"
        ? "succeeded"
        : event?.status === "failure"
          ? "failed"
          : "running";
      progressChain = progressChain.then(() =>
        updateAdminDeploymentStep(run.id, ordinal, status, event?.detail || event?.label || "Updating public URL")
      );
    };
    const result = await updateManagedPublicOrigin({
      baseUrl: plan.publicBaseUrl,
      previousBaseUrl: plan.previousBaseUrl,
      onProgress,
    });
    await progressChain;
    currentStep = run.steps.at(-1).ordinal;
    await updateAdminDeploymentStep(
      run.id,
      currentStep,
      "succeeded",
      `GC_PUBLIC_BASE_URL saved in the encrypted store as ${plan.publicBaseUrl}`
    );
    await finishAdminDeploymentRun(run.id, { status: "succeeded", result });
  } catch (error) {
    await progressChain.catch(() => undefined);
    await updateAdminDeploymentStep(run.id, currentStep, "failed", error?.message || String(error));
    await finishAdminDeploymentRun(run.id, {
      status: "failed",
      error: String(error?.message || error).slice(0, 4000),
    });
  }
}

async function applyPreparedRun(run) {
  let currentStep = 0;
  let progressChain = Promise.resolve();
  const progress = (event) => {
    const detail = event?.detail || event?.label || "";
    let ordinal = Number.isInteger(event?.ordinal) ? event.ordinal : currentStep;
    if (!Number.isInteger(event?.ordinal) && run.component === "audio" && event?.label) {
      const matchingStep = run.steps.find((step) => step.label === event.label);
      if (matchingStep) ordinal = matchingStep.ordinal;
    }
    currentStep = ordinal;
    const status = event?.status === "failure"
      ? "failed"
      : event?.status === "success"
        ? "succeeded"
        : "running";
    progressChain = progressChain.then(() =>
      updateAdminDeploymentStep(
        run.id,
        ordinal,
        status,
        detail
      )
    );
  };
  try {
    await hydrateRuntimeSecrets({ required: true });
    if (run.plan?.operation === "public-origin") {
      await applyPreparedPublicOrigin(run);
      return;
    }
    if (run.component === "tts") {
      assertSharedTtsPlanFresh(run.plan?.installerPlan);
    }
    if (run.component === "tts" && run.plan?.operation === "reconcile") {
      try {
        const reconciled = await applyPreparedTtsReconcile(run);
        await finishAdminDeploymentRun(run.id, { status: "succeeded", result: reconciled.result });
      } catch (error) {
        const ordinal = Number.isInteger(error.adminStepOrdinal) ? error.adminStepOrdinal : 0;
        await updateAdminDeploymentStep(run.id, ordinal, "failed", error?.message || String(error));
        await finishAdminDeploymentRun(run.id, {
          status: "failed",
          error: String(error?.message || error).slice(0, 4000),
        });
      }
      return;
    }
    await updateAdminDeploymentStep(run.id, 0, "running", "Revalidating live provider inventory");
    let result;
    if (run.component === "tts") {
      const {
        applyTtsInstallationPlan,
        destroyTtsIntegrations,
        publishTtsArchitectTestFlows,
      } = await import("../../scripts/manage-genesys-telnyx-tts.mjs");
      if (run.plan?.operation === "destroy") {
        const plan = run.plan.installerPlan;
        const profile = getTtsConnectorProfile(plan.target.profileId);
        if (!profile) throw new Error(`Unknown TTS provider ${plan.target.profileId}`);
        await updateAdminDeploymentStep(run.id, 0, "succeeded", "Connector ownership and snapshot selected for revalidation");
        currentStep = 1;
        await updateAdminDeploymentStep(run.id, currentStep, "running", "Destroying the selected TTS connector");
        result = await destroyTtsIntegrations(
          [plan.target],
          {
            expectedOrganizationId: plan.organization.id,
            testFlows: (plan.testFlows || []).map((flow) => ({ ...flow, profile })),
            onProgress: progress,
          }
        );
        await progressChain;
        await updateAdminDeploymentStep(run.id, currentStep, "succeeded", "TTS connector deleted");
        currentStep = 2;
        if (result.flowFailures?.length) {
          throw new Error(
            `The connector was deleted, but ${result.flowFailures.length} associated Architect test flow(s) could not be deleted`
          );
        }
        await updateAdminDeploymentStep(
          run.id,
          currentStep,
          plan.deleteAssociatedFlows ? "succeeded" : "skipped",
          plan.deleteAssociatedFlows
            ? `${result.deletedFlows?.length || 0} managed Architect test flow(s) deleted`
            : "Associated Architect test flows retained"
        );
        currentStep = 3;
        await updateAdminDeploymentStep(run.id, currentStep, "succeeded", "Destroy operation completed; client inventory will refresh");
        await finishAdminDeploymentRun(run.id, { status: "succeeded", result });
        return;
      }
      await updateAdminDeploymentStep(run.id, 0, "succeeded", "Plan and current Genesys state validated");
      currentStep = 1;
      await updateAdminDeploymentStep(run.id, currentStep, "running", "Applying the TTS installer plan");
      result = await applyTtsInstallationPlan(run.installerPlanPath, {
        onProgress: progress,
        stateDirectory: ADMIN_TTS_STATE_DIRECTORY,
      });
      await progressChain;
      await updateAdminDeploymentStep(run.id, currentStep, "succeeded", "TTS connector apply completed");
      const requestedFlowProfiles = new Set(run.config?.testFlowProfiles || []);
      currentStep = 2;
      const flowTargets = (result.results || [])
        .filter((entry) => entry.integrationId && requestedFlowProfiles.has(entry.profileId))
        .map((entry) => ({
          integrationId: entry.integrationId,
          profile: getTtsConnectorProfile(entry.profileId),
        }))
        .filter((entry) => entry.profile?.status === "verified");
      if (flowTargets.length) {
        await updateAdminDeploymentStep(run.id, currentStep, "running", "Publishing selected Architect test flows");
        result.testFlows = await publishTtsArchitectTestFlows(flowTargets, { onProgress: progress });
        await progressChain;
        if (result.testFlows.skipped.length) {
          throw new Error(
            `TTS connectors were applied, but ${result.testFlows.skipped.length} selected Architect test flow(s) could not be published`
          );
        }
        await updateAdminDeploymentStep(
          run.id,
          currentStep,
          "succeeded",
          `${result.testFlows.flows.length} Architect test flow(s) published`
        );
      } else {
        await updateAdminDeploymentStep(run.id, currentStep, "skipped", "No Architect test flows selected");
      }
      currentStep = 3;
      await updateAdminDeploymentStep(run.id, currentStep, "succeeded", "Connector and test-flow operations completed");
      const credentialKey = "tts_credential";
      await registerManagedResourceBatch({
        organizationId: run.plan?.installerPlan?.organization?.id || process.env.GC_ORGANIZATION_ID,
        aggregate: {
          kind: "tts",
          name: "default",
          scopeType: "organization",
          desiredConfig: { profiles: run.config?.profiles || [] },
        },
        resources: [
          {
            key: credentialKey, provider: "genesys", resourceType: "integration_credential",
            remoteId: result.credential?.id, displayName: result.credential?.name,
            logicalKey: "tts_credential", scopeType: "organization", scopeId: "genesys",
            ownership: result.credential?.mode === "existing" ? "external" : "managed",
          },
          ...(result.results || []).map((entry) => ({
            key: `tts_connector:${entry.profileId}`, provider: "genesys", resourceType: "tts_connector",
            remoteId: entry.integrationId,
            displayName: getTtsConnectorProfile(entry.profileId)?.integrationName || entry.profileId,
            logicalKey: `tts_connector:${entry.profileId}`, scopeType: "organization", scopeId: entry.profileId,
          })),
          ...((result.testFlows?.flows || []).map((flow) => ({
            key: `tts_flow:${flow.profileId || flow.id}`, provider: "genesys",
            resourceType: "architect_tts_test_flow", remoteId: flow.id,
            displayName: flow.name, logicalKey: `tts_flow:${flow.profileId || flow.id}`,
            scopeType: "organization", scopeId: flow.profileId || "tts",
          }))),
        ],
        dependencies: (result.results || []).map((entry) => ({
          resource: `tts_connector:${entry.profileId}`,
          dependsOn: credentialKey,
          relationship: "uses_credential",
        })),
      });
    } else if (run.component === "audio") {
      const { applyAudioInstallationPlan } = await import("../../scripts/manage-genesys-audio.mjs");
      await updateAdminDeploymentStep(run.id, 0, "succeeded", "Audio Connector plan loaded");
      currentStep = 1;
      result = await applyAudioInstallationPlan(run.installerPlanPath, {
        ui: { printProgress: (status, label, detail) => progress({ status, label, detail }) },
      });
    } else if (run.component === "callbacks") {
      const { applyCallbacksDeployment } = await import("./callbacks-manager.mjs");
      await updateAdminDeploymentStep(run.id, 0, "succeeded", "Callbacks deployment plan loaded");
      currentStep = 1;
      result = await applyCallbacksDeployment(run.plan.installerPlan, {
        onProgress: async ({ ordinal, status, detail }) => {
          currentStep = ordinal;
          await updateAdminDeploymentStep(run.id, ordinal, status, detail);
        },
      });
    } else {
      const { applyWidgetInfrastructurePlan } = await import("../../scripts/manage-genesys-widget.mjs");
      await updateAdminDeploymentStep(run.id, 0, "succeeded", "Web Chat infrastructure plan loaded");
      currentStep = 1;
      result = await applyWidgetInfrastructurePlan(run.installerPlanPath, {
        onProgress: progress,
      });
    }
    await progressChain;
    await updateAdminDeploymentStep(run.id, currentStep, "succeeded", "Installer apply completed");
    for (let ordinal = currentStep + 1; ordinal < run.steps.length; ordinal += 1) {
      await updateAdminDeploymentStep(run.id, ordinal, "succeeded", "Completed by the shared installer engine");
    }
    await registerAppliedAdminTools(run, result);
    if (run.component === "audio") {
      await registerAdminAudioObservedResources({
        organizationId: run.plan?.installerPlan?.organization?.id || process.env.GC_ORGANIZATION_ID,
        result,
        config: run.config,
      });
    } else if (run.component === "callbacks") {
      await registerAdminCallbackCampaignObservedResources({
        organizationId: run.plan?.installerPlan?.organization?.id || process.env.GC_ORGANIZATION_ID,
        result,
      });
    }
    await finishAdminDeploymentRun(run.id, { status: "succeeded", result });
  } catch (error) {
    await progressChain.catch(() => undefined);
    await updateAdminDeploymentStep(run.id, currentStep, "failed", error?.message || String(error));
    await finishAdminDeploymentRun(run.id, {
      status: "failed",
      error: String(error?.message || error).slice(0, 4000),
    });
  }
}

export async function startPreparedAdminDeployment(run) {
  if (activeRuns.has(run.id)) return false;
  if (run.component === "audio") {
    await hydrateRuntimeSecrets({ required: true });
    const { assertAudioInstallationPlanSnapshot } = await import("../../scripts/manage-genesys-audio.mjs");
    await assertAudioInstallationPlanSnapshot(run.plan?.installerPlan);
  }
  const installerPlanPath = await (run.plan?.operation === "destroy" ||
    run.plan?.operation === "public-origin" ||
    run.component === "callbacks" ||
    (run.plan?.operation === "reconcile" && !run.plan?.installerPlan?.connectorPlanRequired)
    ? Promise.resolve(null)
    : materializeInstallerPlan(run));
  const executableRun = { ...run, installerPlanPath };
  const claimed = await startAdminDeploymentRun(run.id, installerPlanPath);
  if (!claimed) return false;
  const promise = applyPreparedRun(executableRun).finally(() => activeRuns.delete(run.id));
  activeRuns.set(run.id, promise);
  return true;
}
