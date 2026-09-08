import { assertTtsConnectorProfile } from "./tts-connector-profiles.mjs";

const FLOW_MARKER = "managed-by=telnyx-genesys-tts-cli; resource=tts-test-flow";
export const DEFAULT_DELETE_ASSOCIATED_TEST_FLOWS = true;

export function genesysTtsTestFlowName(profile) {
  assertTtsConnectorProfile(profile);
  return `${profile.integrationName} - Test Flow`;
}

export function prepareGenesysTtsArchitectTargets(targets, providerCatalog) {
  const prepared = [];
  const skipped = [];
  for (const target of targets) {
    const profile = assertTtsConnectorProfile(target.profile);
    const catalog = providerCatalog?.get(profile.id);
    if (profile.voiceCatalog?.modelId && (!catalog?.exact || !catalog.voices.length)) {
      const detail = catalog?.error ? `: ${catalog.error}` : "";
      skipped.push({
        profileId: profile.id,
        name: genesysTtsTestFlowName(profile),
        reason: `The ${profile.displayName} model-filtered voice catalog is unavailable${detail}`,
      });
      continue;
    }
    prepared.push({
      ...target,
      catalogVoices: catalog?.architectVoices || catalog?.voices || [],
    });
  }
  return { targets: prepared, skipped };
}

function architectLocation(environment) {
  const locations = {
    "mypurecloud.com": "prod_us_east_1",
    "use2.us-gov-pure.cloud": "prod_us_east_1",
    "use2.pure.cloud": "prod_us_east_2",
    "usw2.pure.cloud": "prod_us_west_2",
    "mypurecloud.ie": "prod_eu_west_1",
    "euw1.pure.cloud": "prod_eu_west_1",
    "euw2.pure.cloud": "prod_eu_west_2",
    "mypurecloud.de": "prod_eu_central_1",
    "euc1.pure.cloud": "prod_eu_central_1",
    "euc2.pure.cloud": "prod_eu_central_2",
    "mypurecloud.jp": "prod_ap_northeast_1",
    "apne1.pure.cloud": "prod_ap_northeast_1",
    "apne2.pure.cloud": "prod_ap_northeast_1",
    "apne3.pure.cloud": "prod_ap_northeast_1",
    "aps1.pure.cloud": "prod_ap_south_1",
    "apse1.pure.cloud": "prod_ap_southeast_1",
    "mypurecloud.com.au": "prod_ap_southeast_2",
    "apse2.pure.cloud": "prod_ap_southeast_2",
    "mypurecloud.ca": "prod_ca_central_1",
    "cac1.pure.cloud": "prod_ca_central_1",
    "mypurecloud.com.br": "prod_sa_east_1",
    "sae1.pure.cloud": "prod_sa_east_1",
    "mec1.pure.cloud": "prod_me_central_1",
    "mxc1.pure.cloud": "prod_mx_central_1",
  };
  const normalized = String(environment || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const location = locations[normalized];
  if (!location) throw new Error(`Unsupported Genesys Architect environment: ${environment}`);
  return location;
}

export function genesysTtsTestFlowDescription(profile, integrationId) {
  assertTtsConnectorProfile(profile);
  return (
    `${profile.displayName} TTS connector test; ${FLOW_MARKER}; ` +
    `profile=${profile.id}; connector=${integrationId}`
  );
}

export function genesysTtsTestFlowIsOwnedByProfile(flow, profile) {
  const descriptionTokens = new Set(
    String(flow?.description || "")
      .split(";")
      .map((token) => token.trim())
      .filter(Boolean)
  );
  return (
    flow?.name === genesysTtsTestFlowName(profile) &&
    descriptionTokens.has("managed-by=telnyx-genesys-tts-cli") &&
    descriptionTokens.has("resource=tts-test-flow") &&
    descriptionTokens.has(`profile=${profile.id}`)
  );
}

function connectorIdFromFlow(flow) {
  return String(flow?.description || "").match(/(?:^|;\s*)connector=([^;\s]+)/i)?.[1] || "";
}

export async function listManagedGenesysTtsTestFlows(architectApi, profiles) {
  if (!architectApi) throw new Error("Genesys Architect API is required");
  const flows = [];
  const conflicts = [];
  const listings = await Promise.all((profiles || []).map(async (profile) => {
    assertTtsConnectorProfile(profile);
    const name = genesysTtsTestFlowName(profile);
    const listing = await architectApi.getFlows({
      type: ["INBOUNDCALL"],
      name,
      pageSize: 100,
    });
    return { profile, name, entities: listing.entities || [] };
  }));
  for (const { profile, name, entities } of listings) {
    for (const flow of entities.filter((entry) => entry.name === name)) {
      const candidate = {
        id: flow.id,
        name: flow.name,
        description: flow.description || "",
        profileId: profile.id,
        integrationId: connectorIdFromFlow(flow),
      };
      if (genesysTtsTestFlowIsOwnedByProfile(flow, profile) && candidate.integrationId) {
        flows.push(candidate);
      } else {
        conflicts.push(candidate);
      }
    }
  }
  return { flows, conflicts };
}

export function genesysTtsTestFlowIsManaged(flow, profile, integrationId) {
  const descriptionTokens = new Set(
    String(flow?.description || "")
      .split(";")
      .map((token) => token.trim())
      .filter(Boolean)
  );
  return (
    genesysTtsTestFlowIsOwnedByProfile(flow, profile) &&
    descriptionTokens.has(`connector=${integrationId}`)
  );
}

export async function findManagedGenesysTtsTestFlows(architectApi, targets) {
  if (!architectApi) throw new Error("Genesys Architect API is required");
  const flows = [];
  const conflicts = [];
  for (const target of targets || []) {
    const profile = assertTtsConnectorProfile(target.profile);
    const integrationId = String(target.integrationId || "").trim();
    if (!integrationId) throw new Error(`Connector ID is missing for ${profile.id}`);
    const name = genesysTtsTestFlowName(profile);
    const listing = await architectApi.getFlows({
      type: ["INBOUNDCALL"],
      name,
      pageSize: 100,
    });
    const matches = (listing.entities || []).filter((flow) => flow.name === name);
    for (const flow of matches) {
      const candidate = {
        id: flow.id,
        name: flow.name,
        description: flow.description || "",
        profileId: profile.id,
        integrationId,
      };
      if (genesysTtsTestFlowIsManaged(flow, profile, integrationId)) flows.push(candidate);
      else conflicts.push(candidate);
    }
  }
  return { flows, conflicts };
}

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function codeOf(error) {
  return String(
    error?.body?.code ||
      error?.response?.body?.code ||
      error?.response?.data?.code ||
      error?.code ||
      ""
  ).trim();
}

function isFlowAbsentError(error) {
  if (statusOf(error) === 404) return true;
  if (statusOf(error) !== 410) return false;
  return (
    codeOf(error) === "architect.flow.deleted" ||
    /\bflow\b.*\bhas been deleted\b/i.test(String(error?.message || ""))
  );
}

export async function deleteManagedGenesysTtsTestFlow(architectApi, target) {
  const profile = assertTtsConnectorProfile(target.profile);
  const integrationId = String(target.integrationId || "").trim();
  const flowId = String(target.id || "").trim();
  if (!integrationId || !flowId) throw new Error("Test flow delete target is incomplete");
  let current;
  try {
    current = await architectApi.getFlow(flowId);
  } catch (error) {
    if (isFlowAbsentError(error)) return { id: flowId, alreadyAbsent: true };
    throw error;
  }
  if (
    !genesysTtsTestFlowIsManaged(current, profile, integrationId) ||
    current.description !== target.description
  ) {
    throw new Error(`Architect test flow ${flowId} changed after selection`);
  }
  try {
    await architectApi.deleteFlow(flowId);
  } catch (error) {
    // A concurrent delete can make the mutation return the same terminal
    // response as a follow-up read. Continue to the authoritative read below.
    if (!isFlowAbsentError(error)) throw error;
  }
  try {
    const remaining = await architectApi.getFlow(flowId);
    if (!remaining?.deleted) {
      throw new Error(`Architect still returns active test flow ${flowId} after delete`);
    }
  } catch (error) {
    if (!isFlowAbsentError(error)) throw error;
  }
  return { id: flowId, name: target.name, deleted: true };
}

function normalizedLanguageTag(value) {
  return String(value?.tag || value || "")
    .trim()
    .replaceAll("_", "-")
    .toLowerCase();
}

function voiceExactlySupportsLanguage(voice, language) {
  if (typeof voice?.getLanguageSupport === "function") {
    try {
      const support = String(voice.getLanguageSupport(language) || "").toLowerCase();
      if (support) return support === "exact";
    } catch {
      // Fall through to the public supportedLanguage metadata.
    }
  }
  return (
    normalizedLanguageTag(voice?.supportedLanguage) === normalizedLanguageTag(language)
  );
}

function normalizedVoiceCatalogValue(value) {
  return String(value || "").trim().toLowerCase();
}

function catalogVoiceExactlySupportsLanguage(voice, language) {
  const expected = normalizedLanguageTag(language);
  const languages = Array.isArray(voice?.languages)
    ? voice.languages
    : [voice?.language, voice?.language_code, voice?.locale];
  return languages.some((value) => normalizedLanguageTag(value) === expected);
}

function voiceMatchesCatalog(voice, language, voiceCatalog, catalogVoices = []) {
  const modelId = normalizedVoiceCatalogValue(voiceCatalog?.modelId);
  if (!modelId) return true;
  const explicitModelId = normalizedVoiceCatalogValue(
    voice?.model_id || voice?.modelId
  );
  if (explicitModelId) return explicitModelId === modelId;

  // Genesys rewrites remote Telnyx voice IDs to connector-local IDs and does
  // not retain model_id. Match the Architect voice name against the model-
  // filtered catalog fetched directly from the Telnyx REST API instead.
  const architectName = normalizedVoiceCatalogValue(voice?.name);
  const architectId = normalizedVoiceCatalogValue(voice?.id);
  return catalogVoices.some((catalogVoice) => {
    if (!catalogVoiceExactlySupportsLanguage(catalogVoice, language)) return false;
    const catalogName = normalizedVoiceCatalogValue(catalogVoice?.name);
    const catalogId = normalizedVoiceCatalogValue(catalogVoice?.id);
    return (
      (architectName && architectName === catalogName) ||
      (architectId && architectId === catalogId)
    );
  });
}

export function selectExactGenesysTtsVoice(
  engine,
  language,
  voiceCatalog,
  catalogVoices = []
) {
  return [...engine.getVoicesForLanguage(language)]
    .filter((voice) => voiceMatchesCatalog(voice, language, voiceCatalog, catalogVoices))
    .filter((voice) => voiceExactlySupportsLanguage(voice, language))
    .sort((left, right) =>
      String(left.id || left.name).localeCompare(String(right.id || right.name))
    )[0];
}

export async function publishGenesysTtsTestFlows({
  environment,
  accessToken,
  architectApi,
  targets,
  scriptingSdk,
  onProgress = () => {},
}) {
  if (!String(accessToken || "").trim()) throw new Error("Genesys access token is unavailable");
  if (!architectApi) throw new Error("Genesys Architect API is required");
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error("At least one TTS test-flow target is required");
  }
  if (typeof onProgress !== "function") throw new Error("onProgress must be a function");

  const prepared = [];
  const names = new Set();
  for (const target of targets) {
    const profile = assertTtsConnectorProfile(target.profile);
    const integrationId = String(target.integrationId || "").trim();
    if (!integrationId) throw new Error(`Connector ID is missing for ${profile.id}`);
    const name = genesysTtsTestFlowName(profile);
    if (names.has(name)) throw new Error(`Duplicate test flow name ${name}`);
    names.add(name);
    const flows = await architectApi.getFlows({
      type: ["INBOUNDCALL"],
      name,
      pageSize: 100,
    });
    const matches = (flows.entities || []).filter((flow) => flow.name === name);
    if (matches.length > 1) throw new Error(`Multiple Architect flows are named ${name}`);
    const existingFlow = matches[0];
    if (existingFlow && !genesysTtsTestFlowIsOwnedByProfile(existingFlow, profile)) {
      throw new Error(`Refusing to overwrite unrelated Architect flow ${name}`);
    }
    prepared.push({
      profile,
      integrationId,
      name,
      existingFlow,
      catalogVoices: Array.isArray(target.catalogVoices) ? target.catalogVoices : [],
    });
  }

  const results = [];
  const skipped = [];
  let callbackError;
  let session;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const mutedConsole = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const emitProgress = (event) => {
    // The Architect SDK is intentionally muted, but installer progress must
    // remain visible while its authenticated session is running.
    Object.assign(console, originalConsole);
    try {
      onProgress(event);
    } finally {
      Object.assign(console, mutedConsole);
    }
  };

  Object.assign(console, mutedConsole);

  try {
    const scriptingModule = scriptingSdk ||
      await import("purecloud-flow-scripting-api-sdk-javascript");
    const scripting = scriptingModule.default || scriptingModule;
    session = scripting.environment.archSession;
    session.endTerminatesProcess = false;
    session.endExitCode = 0;
    await session.startWithAuthToken(
      scripting.enums.archEnums.LOCATIONS[architectLocation(environment)],
      async () => {
        try {
          if (!session.orgInfo.areTtsEnginesAndVoicesAvailable) {
            throw new Error("Architect TTS engine and voice metadata is unavailable");
          }
          for (const target of prepared) {
            const operation = target.existingFlow ? "UPDATE" : "CREATE";
            emitProgress({
              status: "active",
              label: `${operation} ${target.name}`,
              operation,
              name: target.name,
              profileId: target.profile.id,
            });
            try {
              const language = scripting.languages.archLanguages.getByLanguageTag(
                target.profile.probe.language
              );
              if (!language) {
                throw new Error(
                  `Architect language ${target.profile.probe.language} is unavailable`
                );
              }
              const engineId = `connector-${target.integrationId}`;
              const engine = language.ttsEngines.find((candidate) => candidate.id === engineId);
              if (!engine) throw new Error(`TTS engine ${engineId} is unavailable`);
              const voice = selectExactGenesysTtsVoice(
                engine,
                language,
                target.profile.voiceCatalog,
                target.catalogVoices
              );
              if (!voice) {
                const modelRequirement = target.profile.voiceCatalog?.modelId
                  ? ` ${target.profile.voiceCatalog.modelId}`
                  : "";
                throw new Error(
                  `TTS engine ${engineId} returned no${modelRequirement} voice with exact ` +
                    `${language.tag} locale; other models and language-only matches are not used`
                );
              }

              const flow = target.existingFlow
                ? await scripting.factories.archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync(
                    target.name,
                    scripting.enums.archEnums.FLOW_TYPES.inboundCall,
                    false,
                    "latest"
                  )
                : await scripting.factories.archFactoryFlows.createFlowInboundCallAsync(
                    target.name,
                    genesysTtsTestFlowDescription(target.profile, target.integrationId),
                    language
                  );
              if (
                target.existingFlow &&
                !genesysTtsTestFlowIsOwnedByProfile(flow, target.profile)
              ) {
                throw new Error(`Architect flow ${target.name} changed before checkout`);
              }

              flow.description = genesysTtsTestFlowDescription(
                target.profile,
                target.integrationId
              );
              const languageSettings =
                flow.settingsSupportedLanguages.findLanguageSettings(language) ||
                flow.settingsSupportedLanguages.addSupportedLanguage(language, true);
              languageSettings.setTtsEngine(engine);
              languageSettings.setTtsVoice(voice);
              flow.initialAudio.setDefaultCaseLiteralTTS(target.profile.probe.text);

              const task =
                flow.startUpObject ||
                scripting.factories.archFactoryTasks.addTask(
                  flow,
                  "Disconnect after TTS test",
                  true
                );
              task.name = "Disconnect after TTS test";
              for (const action of [...task.actions].reverse()) task.deleteAction(action);
              scripting.factories.archFactoryActions.addActionDisconnect(task, "Disconnect");

              const validation = await flow.validateAsync();
              if (validation.hasErrors) {
                throw new Error(`Architect validation failed: ${validation.getSummaryStr(true)}`);
              }
              await flow.publishAsync(true);
              results.push({
                id: flow.id,
                name: flow.name,
                profileId: target.profile.id,
                integrationId: target.integrationId,
                language: language.tag,
                engineId: engine.id,
                voiceId: voice.id,
                voiceName: voice.name,
                voiceLanguage: voice.supportedLanguage?.tag || language.tag,
                voiceModelId: target.profile.voiceCatalog?.modelId || null,
              });
              emitProgress({
                status: "success",
                label: `${target.name}: published`,
                operation,
                name: target.name,
                profileId: target.profile.id,
              });
            } catch (error) {
              const reason = error?.message || String(error);
              skipped.push({
                name: target.name,
                profileId: target.profile.id,
                integrationId: target.integrationId,
                reason,
              });
              emitProgress({
                status: "failure",
                label: `${target.name}: ${reason}`,
                operation,
                name: target.name,
                profileId: target.profile.id,
              });
            }
          }
        } catch (error) {
          callbackError = error;
          throw error;
        } finally {
          if (typeof session.end === "function") session.end(false);
        }
      },
      accessToken,
      undefined,
      true,
      {
        cacheEnabled: false,
        captureNetworkDiagnosticsOnFailure: false,
        logNetworkDiagnosticsOnFailure: false,
      }
    );
  } finally {
    Object.assign(console, originalConsole);
  }

  if (callbackError) throw callbackError;
  if (session.endExitCode !== 0) {
    throw new Error(`Architect scripting session failed with exit code ${session.endExitCode}`);
  }
  if (results.length + skipped.length !== prepared.length) {
    throw new Error("Architect did not account for every requested TTS test flow");
  }
  return { flows: results, skipped };
}
