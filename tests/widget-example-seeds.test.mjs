import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  WIDGET_EXAMPLE_SEEDS,
  seedWidgetExamples,
} from "../lib/widgets/example-seeds.js";
import {
  assertPublishableWidgetConfig,
  parseWidgetConfig,
} from "../lib/widgets/config.js";

const execFileAsync = promisify(execFile);

test("three example widgets have stable unique identities and valid draft configs", () => {
  assert.equal(WIDGET_EXAMPLE_SEEDS.length, 3);
  assert.equal(new Set(WIDGET_EXAMPLE_SEEDS.map((seed) => seed.widgetId)).size, 3);
  assert.equal(new Set(WIDGET_EXAMPLE_SEEDS.map((seed) => seed.publicId)).size, 3);

  for (const seed of WIDGET_EXAMPLE_SEEDS) {
    assert.equal(parseWidgetConfig(seed.config).schemaVersion, 2);
    assert.equal(seed.config.channels.messaging.assistantId, "");
    assert.equal(seed.config.channels.messaging.genesys.integrationId, "");
    assert.equal(seed.config.channels.messaging.genesys.queueId, "");
    assert.equal(seed.config.channels.voice.assistantId, "");
    assert.equal(seed.config.channels.voice.genesysTrunkId, "");
    assert.equal(seed.config.channels.voice.genesysSipUri, "");
    assert.equal(seed.config.decisions.rules.length, 5);
    assert.equal(seed.config.decisions.enabled, false);
    assert.throws(() => assertPublishableWidgetConfig(seed.config));
  }
});

test("examples demonstrate different layouts, colors, channel sets and feature flags", () => {
  const [emerald, midnight, sunset] = WIDGET_EXAMPLE_SEEDS.map((seed) => seed.config);
  assert.deepEqual(
    WIDGET_EXAMPLE_SEEDS.map((seed) => seed.config.theme.colors.primary),
    ["#00a67e", "#8b5cf6", "#e84a5f"]
  );
  assert.equal(emerald.dimensions.panelPosition, "bottom-right");
  assert.equal(emerald.dimensions.launcherPosition, "bottom-right");
  assert.equal(midnight.dimensions.panelPosition, "bottom-left");
  assert.equal(midnight.dimensions.launcherPosition, "bottom-left");
  assert.equal(midnight.features.emoji, false);
  assert.equal(midnight.components.messages.showTimestamps, false);
  assert.equal(midnight.behavior.persistSession, false);
  assert.equal(sunset.channels.voice.enabled, true);
  assert.equal(sunset.features.voiceTranscript, true);
  assert.equal(sunset.components.voice.waveform.enabled, true);
  assert.equal(sunset.components.voice.waveform.bars, 48);
});

test("widget example seeder defaults to a database-free dry run", async () => {
  const script = new URL("../scripts/seed-widget-examples.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [script.pathname], {
    env: { PATH: process.env.PATH },
  });
  assert.match(stdout, /dry run; no database connection or write was made/);
  assert.match(stdout, /Demo — Emerald Support/);
  assert.match(stdout, /Demo — Midnight Concierge/);
  assert.match(stdout, /Demo — Sunset Voice & Chat/);
});

test("startup seed mode leaves existing example widgets unchanged", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (String(sql).includes("FROM widgets")) {
        return {
          rows: WIDGET_EXAMPLE_SEEDS.map((seed) => ({
            id: seed.widgetId,
            public_id: seed.publicId,
          })),
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const result = await seedWidgetExamples({
    pool: { async connect() { return client; } },
    refreshExisting: false,
  });

  assert.deepEqual(
    { created: result.created, updated: result.updated, unchanged: result.unchanged },
    { created: 0, updated: 0, unchanged: 3 }
  );
  assert.equal(queries.some((sql) => String(sql).includes("INSERT INTO widgets")), false);
  assert.equal(queries.some((sql) => String(sql).includes("UPDATE widget_revisions")), false);
  assert.equal(queries.at(-1), "COMMIT");
});

test("refreshing examples discards an obsolete published revision and writes only a v2 draft", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("FROM widgets")) return { rows: [] };
      if (String(sql).includes("RETURNING id")) return { rows: [{ id: "draft" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  await seedWidgetExamples({ pool: { async connect() { return client; } } });

  assert.equal(queries.filter((sql) => sql.includes("published_revision_id = NULL")).length, 3);
  assert.equal(queries.filter((sql) => sql.includes("state = 'archived'")).length, 3);
  assert.equal(queries.filter((sql) => sql.includes("SET config = $2::jsonb")).length, 3);
});
