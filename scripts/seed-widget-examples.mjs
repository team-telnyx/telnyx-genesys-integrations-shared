#!/usr/bin/env node

import "dotenv/config";
import { closePostgresPool } from "../lib/postgres.mjs";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";
import {
  WIDGET_EXAMPLE_SEEDS,
  seedWidgetExamples,
} from "../lib/widgets/example-seeds.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = args.has("--dry-run") || !apply;

if (args.has("--help")) {
  console.log(
    "Usage: npm run db:seed:widget-examples -- [--dry-run | --apply] [--allow-production]\n" +
      "Creates or refreshes three disabled example widget drafts. No Telnyx or Genesys resources are provisioned."
  );
  process.exit(0);
}

if (apply && args.has("--dry-run")) {
  console.error("[widget-seed] choose either --dry-run or --apply");
  process.exit(1);
}

if (apply && process.env.NODE_ENV === "production" && !args.has("--allow-production")) {
  console.error(
    "[widget-seed] production seeding requires explicit --allow-production together with --apply"
  );
  process.exit(1);
}

if (dryRun) {
  console.log("[widget-seed] dry run; no database connection or write was made");
  for (const seed of WIDGET_EXAMPLE_SEEDS) {
    const channels = [
      seed.config.channels.messaging.enabled && "messaging",
      seed.config.channels.voice.enabled && "voice",
    ].filter(Boolean);
    console.log(
      `- ${seed.name} (${seed.publicId}): ${channels.join(" + ")}; ${seed.description}`
    );
  }
  console.log("[widget-seed] add --apply to write these disabled drafts to the configured database");
  process.exit(0);
}

try {
  const schema = await ensurePostgresSchema();
  const result = await seedWidgetExamples();
  console.log(
    `[widget-seed] schema v${schema.version}; ${result.total} examples ready ` +
      `(${result.created} created, ${result.updated} refreshed)`
  );
  for (const widget of result.widgets) {
    console.log(`- ${widget.name}: ${widget.publicId}`);
  }
  console.log(
    "[widget-seed] all examples are disabled drafts; configure provider IDs, validate and publish them in the admin UI"
  );
} catch (error) {
  console.error("[widget-seed] failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await closePostgresPool().catch((error) => {
    console.error("[widget-seed] failed to close pool:", error?.message || error);
    process.exitCode = 1;
  });
}
