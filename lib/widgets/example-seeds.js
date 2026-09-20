import { randomUUID } from "node:crypto";
import { getPostgresPool } from "../postgres.mjs";
import { normalizedManagedNameKey } from "../genesys/resource-naming.mjs";
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig } from "./config.js";

const SEED_ACTOR = "system:widget-example-seed";

function exampleConfig(overrides) {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  overrides(config);
  return parseWidgetConfig(config);
}

export const WIDGET_EXAMPLE_SEEDS = Object.freeze([
  Object.freeze({
    key: "emerald-support",
    widgetId: "10000000-0000-4000-8000-000000000001",
    revisionId: "20000000-0000-4000-8000-000000000001",
    publicId: "wgt_demo_emerald_support",
    name: "Demo — Emerald Support",
    description: "Jasny, klasyczny widget messaging z pełnym zestawem funkcji czatu.",
    config: exampleConfig((config) => {
      config.dimensions = {
        ...config.dimensions,
        panelPosition: "bottom-right",
        launcherPosition: "bottom-right",
        panelWidth: 400,
        panelHeight: 640,
        fabSize: 60,
      };
      config.theme.colors = { ...config.theme.colors, primary: "#00a67e", headerBackground: "#00a67e", surface: "#ffffff", text: "#102a24", customerBubble: "#d9fff5", customerText: "#102a24" };
      config.theme.shape.panelRadius = 18;
      config.components.launcher.backgroundColor = "#00a67e";
      config.content = {
        ...config.content,
        title: "Jak możemy pomóc?",
        messagingSubtitle: "Wsparcie dostępne przez całą dobę",
        welcomeMessage: "Dzień dobry! Jestem wirtualnym doradcą. W czym mogę pomóc?",
        chatLabel: "Napisz do nas",
        inputPlaceholder: "Wpisz swoją wiadomość…",
      };
      config.avatars = {
        customer: { type: "initials", value: "TY" },
        bot: { type: "icon", value: "bot" },
        human: { type: "icon", value: "headset" },
      };
      config.features = {
        ...config.features,
        emoji: true,
        attachmentsAfterHandoff: true,
      };
      config.components.messages.showTimestamps = true;
      config.components.voice.waveform = { ...config.components.voice.waveform, enabled: false, primaryColor: "#00a67e", bars: 32 };
      config.behavior = {
        ...config.behavior,
        persistSession: true,
        inactivityMinutes: 60,
        mobileFullscreen: true,
      };
    }),
  }),
  Object.freeze({
    key: "midnight-concierge",
    widgetId: "10000000-0000-4000-8000-000000000002",
    revisionId: "20000000-0000-4000-8000-000000000002",
    publicId: "wgt_demo_midnight_concierge",
    name: "Demo — Midnight Concierge",
    description: "Kompaktowy widget messaging w ciemnej kolorystyce i uproszczonym UI.",
    config: exampleConfig((config) => {
      config.dimensions = {
        ...config.dimensions,
        panelPosition: "bottom-left",
        launcherPosition: "bottom-left",
        panelWidth: 360,
        panelHeight: 560,
        fabSize: 52,
        panelOffsetX: 18,
        panelOffsetY: 18,
        launcherOffsetX: 18,
        launcherOffsetY: 18,
      };
      config.theme.colors = { ...config.theme.colors, primary: "#8b5cf6", headerBackground: "#8b5cf6", surface: "#111827", surfaceMuted: "#1f2937", text: "#f9fafb", mutedText: "#cbd5e1", border: "#374151", footerBackground: "#111827", footerText: "#f9fafb", inputBackground: "#1f2937", inputText: "#f9fafb", assistantBubble: "#1f2937", assistantText: "#f9fafb", customerBubble: "#312e81", customerText: "#f9fafb" };
      config.theme.shape.panelRadius = 28;
      config.components.launcher.backgroundColor = "#8b5cf6";
      config.content = {
        ...config.content,
        title: "Digital Concierge",
        messagingSubtitle: "Szybkie odpowiedzi bez zbędnych elementów",
        welcomeMessage: "Cześć! Powiedz krótko, czego potrzebujesz.",
        chatLabel: "Rozpocznij czat",
        inputPlaceholder: "Twoja wiadomość…",
      };
      config.avatars = {
        customer: { type: "initials", value: "JA" },
        bot: { type: "initials", value: "AI" },
        human: { type: "initials", value: "AG" },
      };
      config.features = {
        ...config.features,
        emoji: false,
        attachmentsAfterHandoff: false,
      };
      config.components.messages.showTimestamps = false;
      config.components.voice.waveform = { ...config.components.voice.waveform, enabled: false, primaryColor: "#8b5cf6", bars: 20 };
      config.behavior = {
        ...config.behavior,
        persistSession: false,
        inactivityMinutes: 20,
        mobileFullscreen: false,
      };
    }),
  }),
  Object.freeze({
    key: "sunset-voice-and-chat",
    widgetId: "10000000-0000-4000-8000-000000000003",
    revisionId: "20000000-0000-4000-8000-000000000003",
    publicId: "wgt_demo_sunset_voice_chat",
    name: "Demo — Sunset Voice & Chat",
    description: "Duży widget voice + messaging z transkrypcją i wizualizacją audio wave.",
    config: exampleConfig((config) => {
      config.channels.voice.enabled = true;
      config.channels.voice.region = "auto";
      config.dimensions = {
        ...config.dimensions,
        panelPosition: "bottom-right",
        launcherPosition: "bottom-right",
        panelWidth: 440,
        panelHeight: 720,
        fabSize: 68,
        panelOffsetX: 28,
        panelOffsetY: 28,
        launcherOffsetX: 28,
        launcherOffsetY: 28,
      };
      config.theme.colors = { ...config.theme.colors, primary: "#e84a5f", headerBackground: "#e84a5f", surface: "#fff7ed", text: "#431407", customerBubble: "#fed7aa", customerText: "#431407" };
      config.theme.shape.panelRadius = 12;
      config.components.launcher.backgroundColor = "#e84a5f";
      config.content = {
        ...config.content,
        title: "Porozmawiajmy",
        messagingSubtitle: "Napisz do asystenta lub konsultanta",
        voiceSubtitle: "Rozmowa głosowa z asystentem AI",
        welcomeMessage: "Witaj! Wybierz czat albo połączenie głosowe.",
        chatLabel: "Chat with us",
        callLabel: "Call us",
        startCallLabel: "Zadzwoń teraz",
        voiceReadyMessage: "Możesz rozpocząć rozmowę głosową.",
      };
      config.avatars = {
        customer: { type: "icon", value: "user" },
        bot: { type: "initials", value: "AI" },
        human: { type: "icon", value: "headset" },
      };
      config.features = {
        ...config.features,
        emoji: true,
        attachmentsAfterHandoff: true,
        voiceTextInput: true,
        voiceTranscript: true,
      };
      config.components.messages.showTimestamps = true;
      config.components.voice.waveform = { ...config.components.voice.waveform, enabled: true, style: "mirrored", primaryColor: "#e84a5f", secondaryColor: "#f59e0b", bars: 48 };
      config.behavior = {
        ...config.behavior,
        persistSession: true,
        inactivityMinutes: 90,
        mobileFullscreen: true,
      };
    }),
  }),
]);

function seedCollisionMessage(seed, row) {
  return (
    `Widget example seed collision for ${seed.key}: expected ` +
    `${seed.widgetId}/${seed.publicId}, found ${row.id}/${row.public_id}. ` +
    "No data was changed."
  );
}

export async function seedWidgetExamples({
  pool = getPostgresPool(),
  refreshExisting = true,
} = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [847221, 2]);

    const widgetIds = WIDGET_EXAMPLE_SEEDS.map((seed) => seed.widgetId);
    const publicIds = WIDGET_EXAMPLE_SEEDS.map((seed) => seed.publicId);
    const existingResult = await client.query(
      `SELECT id::text, public_id
         FROM widgets
        WHERE id = ANY($1::uuid[]) OR public_id = ANY($2::text[])
        FOR UPDATE`,
      [widgetIds, publicIds]
    );

    const existingKeys = new Set();
    for (const row of existingResult.rows) {
      const seed = WIDGET_EXAMPLE_SEEDS.find(
        (candidate) => candidate.widgetId === row.id || candidate.publicId === row.public_id
      );
      if (!seed || seed.widgetId !== row.id || seed.publicId !== row.public_id) {
        const expected = seed || { key: "unknown", widgetId: "-", publicId: "-" };
        throw new Error(seedCollisionMessage(expected, row));
      }
      existingKeys.add(seed.key);
    }

    for (const seed of WIDGET_EXAMPLE_SEEDS) {
      if (existingKeys.has(seed.key) && !refreshExisting) continue;

      await client.query(
        `INSERT INTO widgets (
           id, public_id, name, normalized_name, installation_key, enabled, genesys_organization_id,
           created_by_genesys_user_id, updated_by_genesys_user_id
         ) VALUES ($1, $2, $3, $4, 'seed', FALSE, NULL, $5, $5)
         ON CONFLICT (id) DO UPDATE SET
           public_id = EXCLUDED.public_id,
           name = EXCLUDED.name,
           normalized_name = EXCLUDED.normalized_name,
           installation_key = EXCLUDED.installation_key,
           enabled = FALSE,
           published_revision_id = NULL,
           genesys_organization_id = NULL,
           updated_by_genesys_user_id = EXCLUDED.updated_by_genesys_user_id,
           updated_at = NOW()`,
        [seed.widgetId, seed.publicId, seed.name, normalizedManagedNameKey(seed.name), SEED_ACTOR]
      );

      await client.query(
        `UPDATE widget_revisions
            SET state = 'archived'
          WHERE widget_id = $1 AND state = 'published'`,
        [seed.widgetId]
      );

      const configJson = JSON.stringify(seed.config);
      const draftResult = await client.query(
        `UPDATE widget_revisions
            SET config = $2::jsonb,
                created_by_genesys_user_id = $3
          WHERE widget_id = $1 AND state = 'draft'
        RETURNING id`,
        [seed.widgetId, configJson, SEED_ACTOR]
      );

      if (draftResult.rowCount === 0) {
        const versionResult = await client.query(
          "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM widget_revisions WHERE widget_id = $1",
          [seed.widgetId]
        );
        const version = Number(versionResult.rows[0]?.version || 1);
        const revisionId = version === 1 ? seed.revisionId : randomUUID();
        await client.query(
          `INSERT INTO widget_revisions (
             id, widget_id, version, state, config, created_by_genesys_user_id
           ) VALUES ($1, $2, $3, 'draft', $4::jsonb, $5)`,
          [revisionId, seed.widgetId, version, configJson, SEED_ACTOR]
        );
      }

      await client.query(
        `INSERT INTO widget_admin_audit_events (
           widget_id, genesys_organization_id, genesys_user_id, action, details
         ) VALUES ($1, NULL, $2, 'widget.example.seeded', $3::jsonb)`,
        [
          seed.widgetId,
          SEED_ACTOR,
          JSON.stringify({
            example: seed.key,
            result: existingKeys.has(seed.key) ? "updated" : "created",
            enabled: false,
            state: "draft",
          }),
        ]
      );
    }

    await client.query("COMMIT");
    return {
      total: WIDGET_EXAMPLE_SEEDS.length,
      created: WIDGET_EXAMPLE_SEEDS.filter((seed) => !existingKeys.has(seed.key)).length,
      updated: refreshExisting ? existingKeys.size : 0,
      unchanged: refreshExisting ? 0 : existingKeys.size,
      widgets: WIDGET_EXAMPLE_SEEDS.map(({ key, name, publicId, description }) => ({
        key,
        name,
        publicId,
        description,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
