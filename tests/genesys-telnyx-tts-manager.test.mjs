import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getTtsConnectorProfile,
  selectTtsConnectorProfiles,
  verifiedTtsConnectorProfiles,
} from "../lib/genesys/tts-connector-profiles.mjs";
import {
  assertApplicablePlan,
  buildDesiredConfig,
  buildTtsPlan,
  canonicalJson,
  classifyAppliedRollbackCandidate,
  classifyInterruptedCreateLookup,
  configMatchesProfile,
  inventorySnapshotHash,
  isTelnyxTtsInventoryEntry,
  managedCredentialCreationName,
  managedIntegrationCreationName,
  managedNotes,
  profileDefinitionHash,
  profileOwnershipConflicts,
  redactSecrets,
  restorableSnapshotHash,
  sha256,
  snapshotInventoryEntry,
} from "../lib/genesys/tts-connector-manager.mjs";
import {
  inspectTelnyxAudio,
  parsePcmWav,
  probeTelnyxTtsProfile,
  selectProbeVoice,
} from "../lib/genesys/telnyx-tts-audio-probe.mjs";
import {
  DEFAULT_DELETE_UNUSED_TTS_CREDENTIALS,
  connectGenesys,
  createTtsIntegrationSafely,
  createTelnyxCredential,
  deleteGenesysCredentialSafely,
  deleteTtsIntegrationSafely,
  findGenesysCredentialReferences,
  findTtsIntegrationsByName,
  hardenGenesysSdkClient,
  listAllTtsIntegrations,
  normalizeGenesysEnvironment,
  pollIntegrationState,
} from "../lib/genesys/tts-connector-genesys.mjs";
import {
  loadTtsProviderCatalog,
  providerCountLabel,
  staticProviderCatalog,
} from "../lib/genesys/tts-provider-catalog.mjs";
import {
  DEFAULT_DELETE_ASSOCIATED_TEST_FLOWS,
  deleteManagedGenesysTtsTestFlow,
  findManagedGenesysTtsTestFlows,
  genesysTtsTestFlowDescription,
  genesysTtsTestFlowName,
  listManagedGenesysTtsTestFlows,
  prepareGenesysTtsArchitectTargets,
  publishGenesysTtsTestFlows,
  selectExactGenesysTtsVoice,
} from "../lib/genesys/tts-connector-architect.mjs";

const credential = {
  id: "credential-1",
  name: "Telnyx TTS",
  type: { name: "userDefined" },
  selfUri: "/api/v2/integrations/credentials/credential-1",
};

function inventoryEntry(profile, {
  id = `integration-${profile.id}`,
  intendedState = "ENABLED",
  reportedCode = "ACTIVE",
  managed = true,
  credentialId = credential.id,
  version = 2,
  integrationName = profile.integrationName,
} = {}) {
  const current = { id: "current", version };
  const config = buildDesiredConfig({
    profile,
    currentConfig: current,
    credential: { ...credential, id: credentialId },
  });
  if (!managed) {
    config.notes = "Human-managed connector";
  }
  return {
    integration: {
      id,
      name: integrationName,
      integrationType: { id: "genesys-tts-connector" },
      notes: managed ? managedNotes(profile, credentialId) : "Human-managed connector",
      intendedState,
      reportedState: { code: reportedCode },
    },
    config,
  };
}

function planInput(overrides = {}) {
  return {
    environment: "euw2.pure.cloud",
    organization: { id: "org-1", name: "Example" },
    integrationType: { id: "genesys-tts-connector", maxInstances: 10 },
    inventory: [],
    profiles: [getTtsConnectorProfile("naturalhd-pcm")],
    credential: {
      mode: "existing",
      id: credential.id,
      name: credential.name,
      type: "userDefined",
    },
    now: new Date("2026-08-10T10:00:00Z"),
    planId: "plan-1",
    ...overrides,
  };
}

function wavPcm({ sampleRate = 8000, channels = 1, bitsPerSample = 16, samples = 800 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

test("registry exposes eleven verified profiles and blocks providers without 8 kHz PCM", () => {
  assert.equal(verifiedTtsConnectorProfiles().length, 11);
  assert.deepEqual(
    selectTtsConnectorProfiles("aws-pcm,murfai-wav,ultra-mp3,azure-mp3").map(
      (profile) => profile.id
    ),
    ["aws-polly-pcm", "murfai-pcm", "ultra-pcm", "azure-pcm"]
  );
  for (const blockedId of [
    "bayan-16khz",
    "sukhan-mp3",
    "humain-24khz",
  ]) {
    assert.throws(() => selectTtsConnectorProfiles(blockedId), /blocked/i);
  }
});

test("connector names use the Telnyx TTS provider-or-model convention without audio formats", () => {
  assert.deepEqual(
    verifiedTtsConnectorProfiles().map((profile) => profile.integrationName),
    [
      "Telnyx TTS - AWS Polly",
      "Telnyx TTS - xAI",
      "Telnyx TTS - Inworld Mini",
      "Telnyx TTS - MiniMax",
      "Telnyx TTS - Rime Coda",
      "Telnyx TTS - NaturalHD",
      "Telnyx TTS - Resemble",
      "Telnyx TTS - FishAudio",
      "Telnyx TTS - MurfAI",
      "Telnyx TTS - Ultra",
      "Telnyx TTS - Azure",
    ]
  );
});

test("Architect test-flow names derive from connector names without a pinned voice", () => {
  assert.equal(
    genesysTtsTestFlowName(getTtsConnectorProfile("aws-polly-pcm")),
    "Telnyx TTS - AWS Polly - Test Flow"
  );
  for (const profile of verifiedTtsConnectorProfiles()) {
    assert.equal(genesysTtsTestFlowName(profile), `${profile.integrationName} - Test Flow`);
  }
});

test("Architect test flows prefer an exact en-US voice over earlier language-only matches", () => {
  const language = { tag: "en-US" };
  const enInVoice = {
    id: "01-en-in-aditi",
    name: "en-in, Aditi",
    supportedLanguage: { tag: "en-IN" },
    getLanguageSupport() {
      return "languageOnly";
    },
  };
  const hiInVoice = {
    id: "02-hi-in-aanya",
    name: "hi-in, Aanya",
    supportedLanguage: { tag: "hi-IN" },
    getLanguageSupport() {
      return "none";
    },
  };
  const enUsVoice = {
    id: "99-en-us-joanna",
    name: "en-us, Joanna",
    supportedLanguage: { tag: "en-US" },
    getLanguageSupport() {
      return "exact";
    },
  };
  const selected = selectExactGenesysTtsVoice(
    {
      getVoicesForLanguage() {
        return [enInVoice, hiInVoice, enUsVoice];
      },
    },
    language
  );
  assert.equal(selected, enUsVoice);
});

test("Architect test flows do not fall back to a different English locale", () => {
  const language = { tag: "en-US" };
  assert.equal(
    selectExactGenesysTtsVoice(
      {
        getVoicesForLanguage() {
          return [
            { id: "en-in", supportedLanguage: { tag: "en-IN" } },
            { id: "en-gb", supportedLanguage: { tag: "en_GB" } },
          ];
        },
      },
      language
    ),
    undefined
  );
});

test("Architect test flows select the configured Telnyx model from the direct REST catalog", () => {
  const language = { tag: "en-US" };
  const naturalHdVoice = {
    id: "connector-naturalhd/astra-en-us",
    name: "astra",
    type: "ArchTtsVoice",
    supportedLanguage: { tag: "en-US" },
    getLanguageSupport() {
      return "exact";
    },
  };
  const selected = selectExactGenesysTtsVoice(
    {
      getVoicesForLanguage() {
        return [
          {
            id: "connector-naturalhd/aaa-en-us",
            name: "aaa",
            supportedLanguage: { tag: "en-US" },
            getLanguageSupport() {
              return "exact";
            },
          },
          {
            id: "connector-naturalhd/aarohi-hi-in",
            name: "aarohi",
            supportedLanguage: { tag: "hi-IN" },
            getLanguageSupport() {
              return "none";
            },
          },
          naturalHdVoice,
        ];
      },
    },
    language,
    { provider: "telnyx", modelId: "NaturalHD" },
    [
      { id: "Telnyx.NaturalHD.aarohi", name: "aarohi", languages: ["hi-IN"] },
      { id: "Telnyx.NaturalHD.astra", name: "astra", languages: ["en-US"] },
    ]
  );
  assert.equal(selected, naturalHdVoice);
});

test("Architect catalog matching requires the voice name and exact locale together", () => {
  const language = { tag: "en-US" };
  const connectorVoice = {
    id: "connector-other-model/astra-en-us",
    name: "astra",
    supportedLanguage: { tag: "en-US" },
    getLanguageSupport() {
      return "exact";
    },
  };
  const selected = selectExactGenesysTtsVoice(
    { getVoicesForLanguage: () => [connectorVoice] },
    language,
    { provider: "telnyx", modelId: "NaturalHD" },
    [{ id: "Telnyx.NaturalHD.astra", name: "astra", languages: ["en-GB"] }]
  );
  assert.equal(selected, undefined);
});

test("an unavailable model catalog skips only its own Architect target", async () => {
  const naturalHd = getTtsConnectorProfile("naturalhd-pcm");
  const minimax = getTtsConnectorProfile("minimax-pcm");
  const result = prepareGenesysTtsArchitectTargets(
    [
      { profile: naturalHd, integrationId: "naturalhd" },
      { profile: minimax, integrationId: "minimax" },
    ],
    new Map([
      [naturalHd.id, { exact: false, voices: [], error: "HTTP 503" }],
      [minimax.id, { exact: true, voices: [{ id: "minimax-voice" }] }],
    ])
  );
  assert.deepEqual(result.targets.map((target) => target.profile.id), ["minimax-pcm"]);
  assert.deepEqual(result.skipped.map((target) => target.profileId), ["naturalhd-pcm"]);
  assert.match(result.skipped[0].reason, /HTTP 503/);
});

test("Architect test flows do not infer a Telnyx model from connector-local IDs", () => {
  const language = { tag: "en-US" };
  assert.equal(
    selectExactGenesysTtsVoice(
      {
        getVoicesForLanguage() {
          return [{
            id: "connector-naturalhd/atrium-en-us",
            name: "atrium",
            supportedLanguage: { tag: "en-US" },
            getLanguageSupport() {
              return "exact";
            },
          }];
        },
      },
      language,
      { provider: "telnyx", modelId: "NaturalHD" },
      []
    ),
    undefined
  );
});

test("Architect publishes compatible test flows and isolates an engine without language voices", async () => {
  const xai = getTtsConnectorProfile("xai-pcm");
  const minimax = getTtsConnectorProfile("minimax-pcm");
  const language = { tag: "en-US", ttsEngines: [] };
  const xaiEngine = {
    id: "connector-xai-integration",
    getVoicesForLanguage() {
      return [];
    },
  };
  const minimaxVoice = {
    id: "minimax-voice",
    name: "English voice",
    supportedLanguage: { tag: "en-US" },
    getLanguageSupport() {
      return "exact";
    },
  };
  const minimaxLanguageOnlyVoice = {
    id: "aaa-minimax-en-in",
    name: "en-in, Aditi",
    supportedLanguage: { tag: "en-IN" },
    getLanguageSupport() {
      return "languageOnly";
    },
  };
  const minimaxEngine = {
    id: "connector-minimax-integration",
    getVoicesForLanguage() {
      return [minimaxLanguageOnlyVoice, minimaxVoice];
    },
  };
  language.ttsEngines.push(xaiEngine, minimaxEngine);

  const published = [];
  let architectSessionEndCalls = 0;
  const scriptingSdk = {
    environment: {
      archSession: {
        orgInfo: { areTtsEnginesAndVoicesAvailable: true },
        endTerminatesProcess: true,
        endExitCode: 0,
        async startWithAuthToken(_location, callback) {
          await callback();
        },
        end(processPendingAsyncWork) {
          assert.equal(processPendingAsyncWork, false);
          architectSessionEndCalls += 1;
        },
      },
    },
    enums: {
      archEnums: {
        LOCATIONS: { prod_eu_west_2: "prod_eu_west_2" },
        FLOW_TYPES: { inboundCall: "INBOUNDCALL" },
      },
    },
    languages: {
      archLanguages: {
        getByLanguageTag(tag) {
          return tag === "en-US" ? language : undefined;
        },
      },
    },
    factories: {
      archFactoryFlows: {
        async createFlowInboundCallAsync(name, description) {
          const settings = {
            setTtsEngine(engine) {
              assert.equal(engine, minimaxEngine);
            },
            setTtsVoice(voice) {
              assert.equal(voice, minimaxVoice);
            },
          };
          return {
            id: "flow-minimax",
            name,
            description,
            settingsSupportedLanguages: {
              findLanguageSettings() {
                return settings;
              },
              addSupportedLanguage() {
                return settings;
              },
            },
            initialAudio: { setDefaultCaseLiteralTTS() {} },
            startUpObject: { name: "Start", actions: [], deleteAction() {} },
            async validateAsync() {
              return { hasErrors: false };
            },
            async publishAsync() {
              published.push(name);
            },
          };
        },
      },
      archFactoryTasks: { addTask() { throw new Error("unexpected task creation"); } },
      archFactoryActions: { addActionDisconnect() {} },
    },
  };

  const progress = [];
  const outcome = await publishGenesysTtsTestFlows({
    environment: "euw2.pure.cloud",
    accessToken: "test-token",
    architectApi: {
      async getFlows() {
        return { entities: [] };
      },
    },
    targets: [
      { profile: xai, integrationId: "xai-integration" },
      { profile: minimax, integrationId: "minimax-integration" },
    ],
    scriptingSdk,
    onProgress(event) {
      progress.push(event);
    },
  });

  assert.deepEqual(published, ["Telnyx TTS - MiniMax - Test Flow"]);
  assert.deepEqual(outcome.flows.map((flow) => flow.profileId), ["minimax-pcm"]);
  assert.equal(outcome.flows[0].voiceId, "minimax-voice");
  assert.equal(outcome.flows[0].voiceLanguage, "en-US");
  assert.equal(architectSessionEndCalls, 1);
  assert.deepEqual(outcome.skipped.map((flow) => flow.profileId), ["xai-pcm"]);
  assert.match(outcome.skipped[0].reason, /returned no voice with exact en-US locale/);
  assert.deepEqual(
    progress.map(({ status, operation, profileId }) => ({ status, operation, profileId })),
    [
      { status: "active", operation: "CREATE", profileId: "xai-pcm" },
      { status: "failure", operation: "CREATE", profileId: "xai-pcm" },
      { status: "active", operation: "CREATE", profileId: "minimax-pcm" },
      { status: "success", operation: "CREATE", profileId: "minimax-pcm" },
    ]
  );
  assert.equal(progress[2].label, "CREATE Telnyx TTS - MiniMax - Test Flow");
  assert.equal(progress[3].label, "Telnyx TTS - MiniMax - Test Flow: published");
});

test("Destroy discovers and safely deletes only the managed flow for the exact connector", async () => {
  const profile = getTtsConnectorProfile("aws-polly-pcm");
  const integrationId = "integration-aws";
  const managed = {
    id: "flow-managed",
    name: genesysTtsTestFlowName(profile),
    description: genesysTtsTestFlowDescription(profile, integrationId),
  };
  const unrelated = {
    id: "flow-unrelated",
    name: managed.name,
    description: "Human-managed flow",
  };
  const discovery = await findManagedGenesysTtsTestFlows(
    {
      async getFlows() {
        return { entities: [managed, unrelated] };
      },
    },
    [{ profile, integrationId }]
  );
  assert.deepEqual(discovery.flows.map((flow) => flow.id), ["flow-managed"]);
  assert.deepEqual(discovery.conflicts.map((flow) => flow.id), ["flow-unrelated"]);
  assert.equal(DEFAULT_DELETE_ASSOCIATED_TEST_FLOWS, true);

  const allManaged = await listManagedGenesysTtsTestFlows(
    {
      async getFlows() {
        return { entities: [managed, unrelated] };
      },
    },
    [profile]
  );
  assert.deepEqual(allManaged.flows.map((flow) => ({
    id: flow.id,
    integrationId: flow.integrationId,
  })), [{ id: "flow-managed", integrationId }]);

  const deceptive = {
    ...managed,
    id: "flow-deceptive",
    description: `${managed.description}-different`,
  };
  const deceptiveDiscovery = await findManagedGenesysTtsTestFlows(
    {
      async getFlows() {
        return { entities: [deceptive] };
      },
    },
    [{ profile, integrationId }]
  );
  assert.deepEqual(deceptiveDiscovery.flows, []);
  assert.deepEqual(deceptiveDiscovery.conflicts.map((flow) => flow.id), ["flow-deceptive"]);

  let reads = 0;
  let deletedId;
  const deletion = await deleteManagedGenesysTtsTestFlow(
    {
      async getFlow() {
        reads += 1;
        if (reads === 1) return managed;
        throw {
          response: { status: 410 },
          code: "architect.flow.deleted",
          message: `Flow '${managed.name}' has been deleted.`,
        };
      },
      async deleteFlow(flowId) {
        deletedId = flowId;
      },
    },
    { ...managed, profile, profileId: profile.id, integrationId }
  );
  assert.equal(deletedId, "flow-managed");
  assert.equal(deletion.deleted, true);

  const alreadyAbsent = await deleteManagedGenesysTtsTestFlow(
    {
      async getFlow() {
        throw {
          response: { status: 410 },
          body: { code: "architect.flow.deleted" },
          message: `Flow '${managed.name}' has been deleted.`,
        };
      },
      async deleteFlow() {
        assert.fail("An already deleted flow must not be deleted again");
      },
    },
    { ...managed, profile, profileId: profile.id, integrationId }
  );
  assert.equal(alreadyAbsent.alreadyAbsent, true);
});

test("connector profiles only use static voices when provider metadata cannot map safely", () => {
  for (const profile of verifiedTtsConnectorProfiles()) {
    assert.equal(profile.smoke, undefined);
    assert.equal(profile.probe?.voiceId, undefined);
    assert.ok(profile.probe?.language);
    assert.ok(profile.probe?.text);
    if (!["xai-pcm", "fishaudio-pcm", "murfai-pcm"].includes(profile.id)) {
      assert.deepEqual(profile.advanced?.voices, undefined);
    }
  }
  const xai = getTtsConnectorProfile("xai-pcm");
  assert.equal(xai.version, 2);
  assert.equal(xai.properties.ttsConnectorVoicesURI, null);
  assert.equal(xai.properties.voiceIdAttribute, "id");
  assert.deepEqual(xai.advanced.voices.map((voice) => voice.id), [
    "XAI.eve",
    "XAI.ara",
    "XAI.rex",
    "XAI.sal",
    "XAI.leo",
  ]);
  assert.deepEqual(xai.advanced.voices.map((voice) => voice.name), [
    "XAI.eve",
    "XAI.ara",
    "XAI.rex",
    "XAI.sal",
    "XAI.leo",
  ]);
  assert.ok(xai.advanced.voices.every((voice) => voice.language === "en-US"));
  const fishAudio = getTtsConnectorProfile("fishaudio-pcm");
  assert.equal(fishAudio.version, 3);
  assert.equal(fishAudio.properties.ttsConnectorVoicesURI, null);
  assert.equal(fishAudio.properties.voiceIdAttribute, "id");
  assert.equal(fishAudio.properties.voiceTypeAttribute, "model_id");
  assert.equal(fishAudio.advanced.voices.length, 7);
  assert.ok(
    fishAudio.advanced.voices.every(
      (voice) =>
        voice.id.startsWith("FishAudio.s2.1-pro.") &&
        voice.name === voice.id &&
        voice.model_id === "s2.1-pro" &&
        voice.language === "en-US"
    )
  );
  const murf = getTtsConnectorProfile("murfai-pcm");
  assert.equal(murf.version, 2);
  assert.equal(murf.properties.ttsConnectorVoicesURI, null);
  assert.equal(murf.properties.voiceTypeAttribute, "model_id");
  assert.deepEqual(murf.advanced.voices, [
    {
      id: "murfai.FALCON.Alicia",
      name: "murfai.FALCON.Alicia",
      gender: "female",
      language: "en-US",
      model_id: "FALCON",
    },
  ]);
  assert.equal(getTtsConnectorProfile("aws-polly-pcm").displayName, "AWS Polly");
  assert.deepEqual(getTtsConnectorProfile("naturalhd-pcm").voiceCatalog, {
    provider: "telnyx",
    modelId: "NaturalHD",
  });
  assert.deepEqual(getTtsConnectorProfile("ultra-pcm").voiceCatalog, {
    provider: "telnyx",
    modelId: "Ultra",
  });
  const naturalHdVoicesUrl = new URL(
    getTtsConnectorProfile("naturalhd-pcm").properties.ttsConnectorVoicesURI
  );
  assert.equal(naturalHdVoicesUrl.searchParams.get("provider"), "telnyx");
  assert.equal(naturalHdVoicesUrl.searchParams.get("model"), "NaturalHD");
  const ultraVoicesUrl = new URL(
    getTtsConnectorProfile("ultra-pcm").properties.ttsConnectorVoicesURI
  );
  assert.equal(ultraVoicesUrl.searchParams.get("provider"), "telnyx");
  assert.equal(ultraVoicesUrl.searchParams.get("model"), "Ultra");
  assert.equal(getTtsConnectorProfile("azure-pcm").properties.voiceTypeAttribute, "provider");
  assert.equal(getTtsConnectorProfile("aws-polly-pcm").description, "AWS Polly");
});

test("verified profiles only target allowlisted Telnyx HTTPS endpoints and binary 8 kHz audio", () => {
  for (const profile of verifiedTtsConnectorProfiles()) {
    assert.equal(new URL(profile.properties.ttsConnectorSynthesizeURI).origin, "https://api.telnyx.com");
    if (profile.properties.ttsConnectorVoicesURI) {
      assert.equal(new URL(profile.properties.ttsConnectorVoicesURI).origin, "https://api.telnyx.com");
    } else {
      assert.ok(profile.advanced.voices.length > 0);
    }
    assert.equal(profile.advanced.synthesizeBody.output_type, "binary_output");
    assert.equal(profile.responseContract.sampleRate, 8000);
    assert.equal(profile.responseContract.channels, 1);
    assert.equal(profile.responseContract.bitsPerSample, 16);
    assert.ok(profile.advanced.outputFormatMapping["audio/L16"]);
  }
});

test("provider-specific casing and scalar types remain part of the versioned contract", () => {
  const aws = getTtsConnectorProfile("aws-polly-pcm");
  const resemble = getTtsConnectorProfile("resemble-wav");
  const murf = getTtsConnectorProfile("murfai-pcm");
  const inworld = getTtsConnectorProfile("inworld-pcm");
  const ultra = getTtsConnectorProfile("ultra-pcm");
  const azure = getTtsConnectorProfile("azure-pcm");
  assert.equal(aws.advanced.synthesizeBody.voice_settings.sample_rate, "8000");
  assert.equal(resemble.advanced.synthesizeBody.voice_settings.sample_rate, "8000");
  assert.equal(murf.advanced.synthesizeBody.voice_settings.format, "PCM");
  assert.deepEqual(murf.advanced.outputFormatMapping, {
    "audio/L16": { "8000": "pcm", "*": "pcm" },
  });
  assert.equal(inworld.advanced.synthesizeBody.voice_settings.encoding, "LINEAR16");
  assert.deepEqual(ultra.advanced.synthesizeBody.voice_settings, {
    response_format: "pcm",
    sampling_rate: 8000,
  });
  assert.deepEqual(azure.advanced.synthesizeBody.voice_settings, {
    output_format: "raw-8khz-16bit-mono-pcm",
  });
  assert.deepEqual(azure.advanced.outputFormatMapping, {
    "audio/L16": {
      "8000": "raw-8khz-16bit-mono-pcm",
      "*": "raw-8khz-16bit-mono-pcm",
    },
  });
  assert.equal(getTtsConnectorProfile("ultra-mp3").id, "ultra-pcm");
  assert.equal(getTtsConnectorProfile("azure-mp3").id, "azure-pcm");
  assert.notEqual(sha256({ sample_rate: "8000" }), sha256({ sample_rate: 8000 }));
});

test("Genesys OAuth environment is normalized only from the official SDK region allowlist", async () => {
  assert.equal(normalizeGenesysEnvironment("EUW2.PURE.CLOUD"), "euw2.pure.cloud");
  assert.equal(
    normalizeGenesysEnvironment("https://api.euw2.pure.cloud/"),
    "euw2.pure.cloud"
  );
  for (const malicious of [
    "evil.example",
    "http://euw2.pure.cloud",
    "https://api.euw2.pure.cloud.evil.example",
    "https://api.euw2.pure.cloud@evil.example",
    "euw2.pure.cloud/path",
  ]) {
    assert.throws(() => normalizeGenesysEnvironment(malicious), /GC_ENVIRONMENT/);
  }

  let oauthCalls = 0;
  const sdk = {
    PureCloudRegionHosts: { eu_west_2: "euw2.pure.cloud" },
    ApiClient: {
      instance: {
        setEnvironment() {},
        async loginClientCredentialsGrant() {
          oauthCalls += 1;
        },
      },
    },
  };
  await assert.rejects(
    connectGenesys({
      environment: "evil.example",
      clientId: "client-id",
      clientSecret: "must-not-be-sent",
      sdk,
    }),
    /official Genesys Cloud region host/
  );
  assert.equal(oauthCalls, 0);
});

test("Genesys SDK hardening removes inherited gateway and all logging transports", () => {
  let previousLoggerClosed = false;
  const logger = {
    logLevelEnum: { level: { LNone: "none" } },
    log_level: "trace",
    log_request_body: true,
    log_response_body: true,
    log_to_console: true,
    log_file_path: "/tmp/unsafe-genesys.log",
    logger: {
      transports: [{ type: "file" }],
      close() {
        previousLoggerClosed = true;
      },
    },
    setLogger() {
      this.logger = { transports: [] };
    },
  };
  const config = {
    live_reload_config: true,
    configPath: "/tmp/inherited-config",
    gateway: { host: "evil.example" },
    logger,
    setConfigPath(value) {
      this.configPath = value;
    },
    setGateway(value) {
      this.gateway = value;
    },
  };
  hardenGenesysSdkClient({ config });
  assert.equal(config.live_reload_config, false);
  assert.equal(config.configPath, "");
  assert.equal(config.gateway, undefined);
  assert.equal(logger.log_level, "none");
  assert.equal(logger.log_request_body, false);
  assert.equal(logger.log_response_body, false);
  assert.equal(logger.log_to_console, false);
  assert.equal(logger.log_file_path, undefined);
  assert.deepEqual(logger.logger.transports, []);
  assert.equal(previousLoggerClosed, true);
});

test("recursive redaction removes secrets from keys and embedded Bearer values", () => {
  const value = redactSecrets({
    nested: {
      credentialFields: { Authorization: "Bearer telnyx-secret" },
      message: "request failed with Authorization=Bearer telnyx-secret",
      basicMessage: "Authorization: Basic dXNlcjpzZWNyZXQ=",
    },
    safeCredentialId: "credential-1",
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /telnyx-secret/);
  assert.doesNotMatch(serialized, /dXNlcjpzZWNyZXQ/);
  assert.match(serialized, /credential-1/);
});

test("planner creates, no-ops, adopts by immutable ID, and detects unmanaged name conflicts", () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const createPlan = buildTtsPlan(planInput());
  assert.equal(createPlan.operations[0].action, "CREATE");

  const existing = inventoryEntry(profile);
  const noopPlan = buildTtsPlan(planInput({ inventory: [existing] }));
  assert.equal(noopPlan.operations[0].action, "NOOP");
  assert.equal(noopPlan.operations[0].expectedSnapshotHash, inventorySnapshotHash(existing));
  assert.ok(configMatchesProfile(existing, profile, credential.id));

  const staticProfile = getTtsConnectorProfile("xai-pcm");
  const normalizedStatic = inventoryEntry(staticProfile);
  delete normalizedStatic.config.properties.ttsConnectorVoicesURI;
  assert.ok(
    configMatchesProfile(normalizedStatic, staticProfile, credential.id),
    "Genesys may omit a null static voice-catalog URI after persisting it"
  );

  const unmanaged = inventoryEntry(profile, {
    id: "legacy-1",
    managed: false,
    integrationName: "Legacy NaturalHD",
  });
  const adoptedPlan = buildTtsPlan(
    planInput({ inventory: [unmanaged], adoptions: { "naturalhd-pcm": "legacy-1" } })
  );
  assert.equal(adoptedPlan.operations[0].action, "UPDATE");
  assert.equal(adoptedPlan.operations[0].integrationId, "legacy-1");
  assert.equal(adoptedPlan.operations[0].adopted, true);

  const unrelated = inventoryEntry(getTtsConnectorProfile("rime-pcm"), {
    id: "unrelated-1",
    managed: false,
    integrationName: "Unrelated",
  });
  const refusedRepurpose = buildTtsPlan(
    planInput({ inventory: [unrelated], adoptions: { "naturalhd-pcm": "unrelated-1" } })
  );
  assert.equal(refusedRepurpose.operations[0].action, "CONFLICT");
  assert.match(refusedRepurpose.operations[0].reasons[0], /does not exactly match/);

  const nameConflict = inventoryEntry(profile, { id: "human-1", managed: false });
  const conflictPlan = buildTtsPlan(planInput({ inventory: [nameConflict] }));
  assert.equal(conflictPlan.operations[0].action, "CONFLICT");
  assert.ok(conflictPlan.blockers.length);

  const errorState = inventoryEntry(profile, { reportedCode: "ERROR" });
  const repairPlan = buildTtsPlan(planInput({ inventory: [errorState] }));
  assert.equal(repairPlan.operations[0].action, "UPDATE");

  const future = structuredClone(existing);
  future.integration.notes = future.integration.notes.replace(
    /profile=naturalhd-pcm@\d+/,
    "profile=naturalhd-pcm@2"
  );
  future.config.notes = future.config.notes.replace(
    /profile=naturalhd-pcm@\d+/,
    "profile=naturalhd-pcm@2"
  );
  const downgradePlan = buildTtsPlan(planInput({ inventory: [future] }));
  assert.equal(downgradePlan.operations[0].action, "CONFLICT");
  assert.match(downgradePlan.operations[0].reasons[0], /refusing downgrade/);

  const duplicateName = inventoryEntry(profile, { id: "duplicate-name", managed: false });
  const duplicatePlan = buildTtsPlan(planInput({ inventory: [existing, duplicateName] }));
  assert.equal(duplicatePlan.operations[0].action, "CONFLICT");
  assert.match(duplicatePlan.operations[0].reasons.join(" "), /Another connector already uses name/);

  const invalidMarker = structuredClone(existing);
  invalidMarker.integration.name = "Renamed invalid connector";
  invalidMarker.config.name = "Renamed invalid connector";
  invalidMarker.config.notes = invalidMarker.config.notes.replace(
    /profile=naturalhd-pcm@\d+/,
    "profile=naturalhd-pcm@999"
  );
  const invalidMarkerPlan = buildTtsPlan(planInput({ inventory: [invalidMarker] }));
  assert.equal(invalidMarkerPlan.operations[0].action, "BLOCKED");
  assert.match(invalidMarkerPlan.blockers.join(" "), /invalid or inconsistent managed marker/);
});

test("snapshots hash lossless state and reject inline secret-like rollback data", () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const first = inventoryEntry(profile);
  const second = structuredClone(first);
  first.config.advanced.token = "secret-a";
  second.config.advanced.token = "secret-b";
  assert.notEqual(inventorySnapshotHash(first), inventorySnapshotHash(second));
  assert.throws(() => snapshotInventoryEntry(first), /cannot be stored losslessly/);
});

test("planner counts disabled integrations against the Genesys instance limit", () => {
  const filler = Array.from({ length: 10 }, (_, index) => ({
    integration: {
      id: `filler-${index}`,
      name: `Filler ${index}`,
      integrationType: { id: "genesys-tts-connector" },
      notes: "unmanaged",
      intendedState: "DISABLED",
      reportedState: { code: "INACTIVE" },
    },
    config: {
      id: "current",
      name: `Filler ${index}`,
      version: 1,
      properties: {},
      advanced: {},
      notes: "unmanaged",
      credentials: {},
    },
  }));
  const plan = buildTtsPlan(planInput({ inventory: filler }));
  assert.equal(plan.operations[0].action, "BLOCKED");
  assert.match(plan.blockers[0], /only 0 of 10 are free/);
});

test("plan is bound to region, organization, expiry and profile definition", () => {
  const plan = buildTtsPlan(planInput());
  assert.equal(
    assertApplicablePlan(plan, {
      environment: "euw2.pure.cloud",
      organizationId: "org-1",
      now: new Date("2026-08-10T10:30:00Z"),
    }),
    plan
  );
  assert.throws(
    () => assertApplicablePlan(plan, { environment: "usw2.pure.cloud", organizationId: "org-1" }),
    /targets euw2/
  );
  assert.throws(
    () =>
      assertApplicablePlan(plan, {
        environment: "euw2.pure.cloud",
        organizationId: "other-org",
      }),
    /organization/
  );
  assert.throws(
    () =>
      assertApplicablePlan(plan, {
        environment: "euw2.pure.cloud",
        organizationId: "org-1",
        now: new Date("2026-08-10T12:00:00Z"),
      }),
    /expired/
  );
  assert.equal(plan.operations[0].profileDefinitionHash, profileDefinitionHash(getTtsConnectorProfile("naturalhd-pcm")));
});

test("plan validation rejects malformed expiry, duplicate operations and edited intent hashes", () => {
  const plan = buildTtsPlan(planInput());
  const validationContext = {
    environment: "euw2.pure.cloud",
    organizationId: "org-1",
    now: new Date("2026-08-10T10:30:00Z"),
  };

  const invalidExpiry = structuredClone(plan);
  invalidExpiry.expiresAt = "not-a-date";
  assert.throws(
    () => assertApplicablePlan(invalidExpiry, validationContext),
    /invalid observedAt or expiresAt/
  );

  const duplicate = structuredClone(plan);
  duplicate.operations.push(structuredClone(duplicate.operations[0]));
  assert.throws(
    () => assertApplicablePlan(duplicate, validationContext),
    /duplicate profile/
  );

  const editedHash = structuredClone(plan);
  editedHash.operations[0].desiredConfigHash = "0".repeat(64);
  assert.throws(
    () => assertApplicablePlan(editedHash, validationContext),
    /Desired config hash/
  );
});

test("canonical JSON sorts object keys but preserves array order and scalar types", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.notEqual(canonicalJson({ values: [1, 2] }), canonicalJson({ values: [2, 1] }));
  assert.notEqual(canonicalJson({ value: 8000 }), canonicalJson({ value: "8000" }));
});

test("rollback classification is idempotent across a crash after restore or disable", () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const before = inventoryEntry(profile, {
    managed: false,
    integrationName: "Legacy NaturalHD",
  });
  const after = inventoryEntry(profile);
  const updateResult = {
    created: false,
    beforeSnapshot: snapshotInventoryEntry(before),
    afterSnapshotHash: inventorySnapshotHash(after),
  };
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: updateResult,
      current: after,
      profile,
      credentialId: credential.id,
    }),
    "restore-existing"
  );
  const restoredWithNewConfigVersion = structuredClone(before);
  restoredWithNewConfigVersion.config.version += 10;
  assert.notEqual(
    inventorySnapshotHash(restoredWithNewConfigVersion),
    inventorySnapshotHash(before)
  );
  assert.equal(
    restorableSnapshotHash(restoredWithNewConfigVersion),
    restorableSnapshotHash(before)
  );
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: updateResult,
      current: restoredWithNewConfigVersion,
      profile,
      credentialId: credential.id,
    }),
    "already-original"
  );

  const createResult = {
    created: true,
    afterSnapshotHash: inventorySnapshotHash(after),
  };
  const disabled = inventoryEntry(profile, {
    intendedState: "DISABLED",
    reportedCode: "INACTIVE",
  });
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: createResult,
      current: after,
      profile,
      credentialId: credential.id,
    }),
    "disable-created"
  );
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: createResult,
      current: disabled,
      profile,
      credentialId: credential.id,
    }),
    "already-disabled"
  );

  const initialCreatedState = structuredClone(disabled);
  initialCreatedState.integration.name = "Telnyx TTS pending naturalhd-pcm run-1";
  initialCreatedState.integration.notes = "";
  initialCreatedState.config.name = initialCreatedState.integration.name;
  initialCreatedState.config.notes = "";
  initialCreatedState.config.properties = {};
  initialCreatedState.config.advanced = {};
  initialCreatedState.config.credentials = {};
  const createdWithSnapshot = {
    ...createResult,
    beforeSnapshot: snapshotInventoryEntry(initialCreatedState),
  };
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: createdWithSnapshot,
      current: after,
      profile,
      credentialId: credential.id,
    }),
    "restore-created"
  );
  const restoredCreatedState = structuredClone(initialCreatedState);
  restoredCreatedState.config.version += 1;
  assert.equal(
    classifyAppliedRollbackCandidate({
      result: createdWithSnapshot,
      current: restoredCreatedState,
      profile,
      credentialId: credential.id,
    }),
    "already-created-original"
  );
});

test("profile ownership detects concurrent pending config and final-name conflicts", () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const self = inventoryEntry(profile, { id: "self" });
  const pending = inventoryEntry(profile, {
    id: "other-pending",
    integrationName: "Telnyx TTS pending naturalhd-pcm another-run",
  });
  pending.integration.notes = "";
  const finalName = inventoryEntry(profile, { id: "other-final", managed: false });
  assert.deepEqual(
    profileOwnershipConflicts([self, pending, finalName], profile, "self").map(
      (entry) => entry.integration.id
    ),
    ["other-pending", "other-final"]
  );
});

test("raw PCM inspection rejects MP3, gzip, JSON, WAV headers and odd sample bytes", () => {
  const contract = getTtsConnectorProfile("naturalhd-pcm").responseContract;
  const valid = inspectTelnyxAudio(Buffer.alloc(3200), contract, {
    "content-type": "audio/L16",
  });
  assert.equal(valid.estimatedDurationMs, 200);
  assert.throws(() => inspectTelnyxAudio(Buffer.from("ID3payload"), contract), /MP3/);
  assert.throws(() => inspectTelnyxAudio(Buffer.from([0x1f, 0x8b, 0x00, 0x00]), contract), /gzip/);
  assert.throws(() => inspectTelnyxAudio(Buffer.from('{"audio":"x"}'), contract), /JSON/);
  assert.throws(() => inspectTelnyxAudio(wavPcm(), contract), /WAV container/);
  assert.throws(() => inspectTelnyxAudio(Buffer.alloc(161), contract), /odd byte/);
});

test("WAV inspection validates integer PCM, mono, 8 kHz and 16-bit data", () => {
  const contract = getTtsConnectorProfile("resemble-wav").responseContract;
  const parsed = parsePcmWav(wavPcm());
  assert.deepEqual(
    {
      audioFormat: parsed.audioFormat,
      channels: parsed.channels,
      sampleRate: parsed.sampleRate,
      bitsPerSample: parsed.bitsPerSample,
    },
    { audioFormat: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16 }
  );
  const inspected = inspectTelnyxAudio(wavPcm(), contract, {
    "content-type": "audio/wav",
  });
  assert.equal(inspected.wav.sampleRate, 8000);
  assert.throws(() => inspectTelnyxAudio(wavPcm({ sampleRate: 16000 }), contract), /16000/);
});

test("Telnyx probe selects a catalog voice dynamically and validates actual response bytes", async () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "GET") {
      return new Response(
        JSON.stringify({
          voices: [
            {
              id: "Telnyx.Ultra.aaa",
              name: "Wrong model",
              language: "en-US",
              model_id: "Ultra",
            },
            {
              id: "Telnyx.NaturalHD.aarohi",
              name: "Wrong locale",
              language: "hi-IN",
              model_id: "NaturalHD",
            },
            {
              id: "Telnyx.NaturalHD.astra",
              name: "Astra",
              type: "catalogVoice",
              language: "en-US",
              model_id: "NaturalHD",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(Buffer.alloc(3200), {
      status: 200,
      headers: { "content-type": "audio/L16" },
    });
  };
  const result = await probeTelnyxTtsProfile(profile, {
    apiKey: "test-key",
    fetchImpl,
  });
  assert.equal(result.audio.sampleRate, 8000);
  assert.equal(result.audio.container, "raw");
  assert.equal(result.voice.id, "Telnyx.NaturalHD.astra");
  assert.equal(JSON.parse(requests[1].options.body).voice, "Telnyx.NaturalHD.astra");
  assert.equal(JSON.parse(requests[1].options.body).output_type, "binary_output");
  assert.equal(requests[1].options.headers["Accept-Encoding"], "identity");
});

test("Telnyx probe does not fall back to another model or locale", () => {
  const voices = [
    { id: "Telnyx.Ultra.aura", model_id: "Ultra", language: "en-US" },
    { id: "Telnyx.NaturalHD.aarohi", model_id: "NaturalHD", language: "hi-IN" },
  ];
  assert.equal(
    selectProbeVoice(voices, "en-US", { provider: "telnyx", modelId: "NaturalHD" }),
    undefined
  );
});

test("provider catalog reports live voice and language counts per Telnyx provider", async () => {
  const profiles = [
    getTtsConnectorProfile("naturalhd-pcm"),
    getTtsConnectorProfile("bayan-16khz"),
    getTtsConnectorProfile("ultra-pcm"),
    getTtsConnectorProfile("azure-pcm"),
    getTtsConnectorProfile("xai-pcm"),
  ];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization });
    const requestUrl = new URL(url);
    const provider = requestUrl.searchParams.get("provider");
    const model = requestUrl.searchParams.get("model");
    const telnyxVoices = [
          {
            id: "Telnyx.NaturalHD.astra",
            name: "Astra",
            language: "en-US",
            model_id: "NaturalHD",
          },
          {
            id: "Telnyx.NaturalHD.orion",
            name: "Orion",
            language: "en-GB",
            model_id: "NaturalHD",
          },
          {
            id: "Telnyx.Natural.astra",
            name: "Astra",
            language: "en-US",
            model_id: "Natural",
          },
          {
            id: "Telnyx.NaturalHD.mislabeled",
            name: "Mislabeled",
            language: "en-US",
            model_id: "Ultra",
          },
          {
            id: "Telnyx.Ultra.asher",
            name: "Asher",
            language: "en-US",
            model_id: "Ultra",
          },
          {
            id: "Telnyx.Bayan.Eman",
            name: "Eman",
            language: "ar-SA",
            model_id: "Bayan",
          },
        ];
    const voices = provider === "telnyx"
      ? telnyxVoices.filter((voice) => !model || voice.model_id === model)
      : provider === "azure"
        ? [
            {
              id: "Azure.en-US-AvaMultilingualNeural",
              name: "Ava Multilingual",
              language: "en-US",
              gender: "Female",
              provider: "azure",
            },
          ]
      : [
          { id: "XAI.eve", name: "Eve", language: "en-US" },
          { id: "XAI.rex", name: "Rex", languages: ["en-US", "en-GB"] },
        ];
    return new Response(JSON.stringify({ voices }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const catalog = await loadTtsProviderCatalog(profiles, {
    apiKey: "catalog-key",
    fetchImpl,
  });
  assert.equal(requests.length, 4, "each Telnyx model should use its own server-side query");
  assert.ok(requests.every((request) => request.authorization === "Bearer catalog-key"));
  assert.deepEqual(
    requests
      .map((request) => {
        const url = new URL(request.url);
        return [url.searchParams.get("provider"), url.searchParams.get("model")];
      })
      .sort(),
    [
      ["azure", null],
      ["telnyx", "Bayan"],
      ["telnyx", "NaturalHD"],
      ["telnyx", "Ultra"],
    ]
  );
  assert.equal(catalog.get("naturalhd-pcm").voiceCount, 2);
  assert.deepEqual(catalog.get("naturalhd-pcm").languages, ["en-GB", "en-US"]);
  assert.deepEqual(
    catalog.get("naturalhd-pcm").architectVoices.map((voice) => voice.id),
    ["Telnyx.NaturalHD.astra", "Telnyx.NaturalHD.orion"]
  );
  assert.equal(catalog.get("bayan-16khz").voiceCount, 1);
  assert.deepEqual(catalog.get("bayan-16khz").languages, ["ar-SA"]);
  assert.equal(catalog.get("ultra-pcm").voiceCount, 2);
  assert.deepEqual(catalog.get("ultra-pcm").languages, ["en-US"]);
  assert.equal(catalog.get("azure-pcm").voiceCount, 1);
  assert.deepEqual(catalog.get("azure-pcm").languages, ["en-US"]);
  assert.equal(catalog.get("xai-pcm").voiceCount, 5);
  assert.deepEqual(catalog.get("xai-pcm").languages, ["en-US"]);
  assert.match(providerCountLabel(catalog.get("xai-pcm")), /5 voices, 1 language/);

  const fallback = staticProviderCatalog(getTtsConnectorProfile("xai-pcm"));
  assert.equal(fallback.source, "profile");
  assert.equal(fallback.voiceCount, 5);
});

test("Telnyx destroy scope requires the TTS integration type and allowlisted endpoints", () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const entry = inventoryEntry(profile, { managed: false });
  assert.equal(isTelnyxTtsInventoryEntry(entry), true);

  const malicious = structuredClone(entry);
  malicious.config.properties.ttsConnectorSynthesizeURI =
    "https://api.telnyx.com.evil.example/v2/text-to-speech/speech";
  assert.equal(isTelnyxTtsInventoryEntry(malicious), false);

  const wrongType = structuredClone(entry);
  wrongType.integration.integrationType.id = "custom-rest-actions";
  assert.equal(isTelnyxTtsInventoryEntry(wrongType), false);
});

test("safe Genesys delete verifies absence and reconciles an ambiguous response", async () => {
  let deleteCalls = 0;
  let getCalls = 0;
  const notFound = () => Object.assign(new Error("not found"), { response: { status: 404 } });
  const deleted = await deleteTtsIntegrationSafely(
    {
      async deleteIntegration(id) {
        deleteCalls += 1;
        assert.equal(id, "integration-1");
      },
      async getIntegration() {
        getCalls += 1;
        throw notFound();
      },
    },
    "integration-1",
    { sleepImpl: async () => {} }
  );
  assert.equal(deleted.deleted, true);
  assert.equal(deleteCalls, 1);
  assert.equal(getCalls, 1);

  const ambiguous = await deleteTtsIntegrationSafely(
    {
      async deleteIntegration() {
        throw Object.assign(new Error("gateway timeout"), { response: { status: 503 } });
      },
      async getIntegration() {
        throw notFound();
      },
    },
    "integration-2",
    { sleepImpl: async () => {} }
  );
  assert.equal(ambiguous.deleted, true);
  assert.equal(ambiguous.reconciledAfterAmbiguousDelete, true);
});

test("credential cleanup is opt-in, detects external references, and verifies deletion", async () => {
  assert.equal(DEFAULT_DELETE_UNUSED_TTS_CREDENTIALS, false);
  const credentialId = "credential-unused-after-destroy";
  const api = {
    async getIntegrations() {
      return {
        entities: [
          { id: "selected-connector", name: "Telnyx TTS - AWS Polly" },
          { id: "other-integration", name: "Other integration" },
        ],
        pageCount: 1,
      };
    },
    async getIntegrationConfigCurrent(integrationId) {
      return integrationId === "selected-connector"
        ? { credentials: { basicAuth: { id: credentialId } } }
        : { credentials: { basicAuth: { id: "different-credential" } } };
    },
  };
  const safeReferences = await findGenesysCredentialReferences(api, [credentialId], {
    excludeIntegrationIds: ["selected-connector"],
  });
  assert.deepEqual(safeReferences[credentialId], []);

  api.getIntegrationConfigCurrent = async () => ({
    credentials: { basicAuth: { id: credentialId } },
  });
  const blockedReferences = await findGenesysCredentialReferences(api, [credentialId], {
    excludeIntegrationIds: ["selected-connector"],
  });
  assert.deepEqual(blockedReferences[credentialId].map((entry) => entry.id), [
    "other-integration",
  ]);

  let deleteCalls = 0;
  const deletion = await deleteGenesysCredentialSafely(
    {
      async deleteIntegrationsCredential(id) {
        deleteCalls += 1;
        assert.equal(id, credentialId);
      },
      async getIntegrationsCredential() {
        throw Object.assign(new Error("not found"), { response: { status: 404 } });
      },
    },
    credentialId,
    { sleepImpl: async () => {} }
  );
  assert.equal(deleteCalls, 1);
  assert.equal(deletion.deleted, true);
});

test("Genesys integration listing paginates until nextUri is exhausted", async () => {
  const calls = [];
  const api = {
    async getIntegrations(options) {
      calls.push(options.pageNumber);
      return options.pageNumber === 1
        ? { entities: [{ id: "1" }], nextUri: "/next", pageCount: 2 }
        : { entities: [{ id: "2" }], pageCount: 2 };
    },
  };
  const result = await listAllTtsIntegrations(api);
  assert.deepEqual(result.map((entry) => entry.id), ["1", "2"]);
  assert.deepEqual(calls, [1, 2]);
});

test("ambiguous CREATE reconciliation only accepts the journaled temporary name", async () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const creationName = "Telnyx TTS pending naturalhd-pcm run-123";
  const foreignFinal = { id: "foreign-final", name: profile.integrationName };
  const requestBodies = [];
  const apiWith = (entities) => ({
    async postIntegrations(options) {
      requestBodies.push(options.body);
      const error = new Error("socket timed out after request write");
      error.code = "ETIMEDOUT";
      throw error;
    },
    async getIntegrations() {
      return { entities, pageCount: 1 };
    },
  });

  await assert.rejects(
    createTtsIntegrationSafely(apiWith([foreignFinal]), profile, creationName),
    (error) => {
      assert.equal(error.createMayHaveSucceeded, true);
      assert.match(error.message, /socket timed out/);
      return true;
    }
  );

  const ownPending = { id: "own-pending", name: creationName };
  const reconciled = await createTtsIntegrationSafely(
    apiWith([foreignFinal, ownPending]),
    profile,
    creationName
  );
  assert.equal(reconciled.id, "own-pending");
  assert.equal(reconciled.reconciledAfterAmbiguousCreate, true);
  assert.deepEqual(
    requestBodies.map((body) => body.name),
    [creationName, creationName]
  );

  assert.equal(
    classifyInterruptedCreateLookup({ createMayHaveSucceeded: false }, []),
    "not-created"
  );
  assert.equal(
    classifyInterruptedCreateLookup({ createMayHaveSucceeded: true }, []),
    "ambiguous"
  );
  assert.equal(classifyInterruptedCreateLookup({}, []), "ambiguous");
  assert.equal(classifyInterruptedCreateLookup({}, [ownPending]), "found");

  let listingCalls = 0;
  const eventuallyVisible = await findTtsIntegrationsByName(
    {
      async getIntegrations() {
        listingCalls += 1;
        return {
          entities: listingCalls === 1 ? [] : [foreignFinal, ownPending],
          pageCount: 1,
        };
      },
    },
    creationName,
    { attempts: 3, sleepImpl: async () => {} }
  );
  assert.deepEqual(eventuallyVisible.map((entry) => entry.id), ["own-pending"]);
  assert.equal(listingCalls, 2);
});

test("first TTS connector creation explains when AppFoundry enablement is still required", async () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  await assert.rejects(
    createTtsIntegrationSafely(
      {
        async postIntegrations() {
          const error = new Error("forbidden");
          error.status = 403;
          throw error;
        },
      },
      profile,
      "Telnyx TTS pending naturalhd-pcm run-123"
    ),
    (error) => {
      assert.equal(error.createMayHaveSucceeded, false);
      assert.match(error.message, /Enable Genesys TTS Connector.*AppFoundry/);
      return true;
    }
  );
});

test("credential CREATE and reconciliation use a run-unique name", async () => {
  const firstRun = "11111111-1111-4111-8111-111111111111";
  const secondRun = "22222222-2222-4222-8222-222222222222";
  const firstName = managedCredentialCreationName(firstRun);
  const secondName = managedCredentialCreationName(secondRun);
  assert.notEqual(firstName, secondName);
  assert.equal(
    managedIntegrationCreationName("naturalhd-pcm", firstRun),
    `Telnyx TTS pending naturalhd-pcm ${firstRun}`
  );

  const foreign = {
    id: "foreign-credential",
    name: "Shared Telnyx TTS",
    type: { name: "userDefined" },
  };
  const own = {
    id: "own-credential",
    name: firstName,
    type: { name: "userDefined" },
  };
  const requestNames = [];
  const apiWith = (eventualEntities) => {
    let listingCall = 0;
    return {
      async getIntegrationsCredentialsListing() {
        listingCall += 1;
        return { entities: listingCall === 1 ? [] : eventualEntities };
      },
      async postIntegrationsCredentials(options) {
        requestNames.push(options.body.name);
        throw new Error("credential POST timed out");
      },
    };
  };

  await assert.rejects(
    createTelnyxCredential(apiWith([foreign]), {
      name: firstName,
      apiKey: "test-api-key",
    }),
    /timed out/
  );
  const reconciled = await createTelnyxCredential(apiWith([foreign, own]), {
    name: firstName,
    apiKey: "test-api-key",
  });
  assert.equal(reconciled.id, "own-credential");
  assert.deepEqual(requestNames, [firstName, firstName]);
});

test("Genesys state polling waits for terminal state and rejects ERROR", async () => {
  let clock = 0;
  const states = ["ACTIVATING", "ACTIVE"];
  const api = {
    async getIntegration() {
      return { reportedState: { code: states.shift() || "ACTIVE" } };
    },
  };
  const result = await pollIntegrationState(api, "integration-1", "ACTIVE", {
    now: () => clock,
    sleepImpl: async (delay) => {
      clock += delay;
    },
  });
  assert.equal(result.reportedState.code, "ACTIVE");

  await assert.rejects(
    pollIntegrationState(
      {
        async getIntegration() {
          return { reportedState: { code: "ERROR", detail: { message: "bad config" } } };
        },
      },
      "integration-2",
      "ACTIVE",
      { now: () => 0, sleepImpl: async () => {} }
    ),
    /bad config/
  );
});

test("TTS manager is a Web Admin library without a process CLI entrypoint", () => {
  const source = readFileSync("scripts/manage-genesys-telnyx-tts.mjs", "utf8");
  assert.doesNotMatch(source, /process\.argv|function parseCli|function printHelp/);
  assert.match(source, /export async function createTtsInstallationPlan/);
  assert.match(source, /export function applyTtsInstallationPlan/);
});

test("Web Admin can override the TTS state directory for plans and journals", () => {
  const manager = readFileSync("scripts/manage-genesys-telnyx-tts.mjs", "utf8");
  const runner = readFileSync("lib/genesys/admin-deployment-runner.mjs", "utf8");
  assert.match(manager, /stateDirectory \? \{ "state-dir": stateDirectory \} : \{\}/);
  assert.match(runner, /ADMIN_TTS_STATE_DIRECTORY = path\.resolve\("\.genesys-admin", "tts"\)/);
  assert.match(
    runner,
    /createTtsInstallationPlan\(\{[\s\S]*?stateDirectory: ADMIN_TTS_STATE_DIRECTORY/,
  );
  assert.match(
    runner,
    /applyTtsInstallationPlan\([\s\S]*?stateDirectory: ADMIN_TTS_STATE_DIRECTORY/,
  );
});

test("interactive Quit explicitly terminates lingering Genesys SDK handles", () => {
  const source = readFileSync("scripts/manage-genesys-telnyx-tts.mjs", "utf8");
  assert.match(source, /if \(action === "quit"\) \{[\s\S]*?process\.exit\(0\);[\s\S]*?\}/u);
});
