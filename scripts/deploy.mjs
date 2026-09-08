#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import dotenv from "dotenv";
import { password, select } from "@inquirer/prompts";

function usage() {
  console.log(`Usage: node scripts/deploy.mjs [options]

Options:
  --mode bundled|external  PostgreSQL mode (default: bundled)
  --env-file PATH          Deployment env file (default: .env)
  --image NAME             Image name/tag (default: telnyx-genesys-integrations:local)
  --build-only             Build the application image without starting containers
  --down                   Stop the Compose deployment
  --remove-volumes         With --down, also delete all Compose data/state volumes
  --pull                   Pull base/service images before starting
  --no-wait                Do not wait for /api/health after startup
  --skip-genesys           Start containers without running interactive genesys:deploy
  --yes                    Continue without the interactive Y/N confirmation
  --allow-insecure-db      Permit disabled TLS for a remote external PostgreSQL host
  --dry-run                Validate and print commands without executing Docker
  --help                   Show this help
`);
}

function parseArguments(argv) {
  const options = {
    mode: "bundled",
    envFile: ".env",
    image: "telnyx-genesys-integrations:local",
    buildOnly: false,
    down: false,
    removeVolumes: false,
    pull: false,
    wait: true,
    runGenesys: true,
    yes: false,
    allowInsecureDb: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--mode") options.mode = argv[++index];
    else if (argument === "--env-file") options.envFile = argv[++index];
    else if (argument === "--image") options.image = argv[++index];
    else if (argument === "--build-only") options.buildOnly = true;
    else if (argument === "--down") options.down = true;
    else if (argument === "--remove-volumes") options.removeVolumes = true;
    else if (argument === "--pull") options.pull = true;
    else if (argument === "--no-wait") options.wait = false;
    else if (argument === "--skip-genesys") options.runGenesys = false;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--allow-insecure-db") options.allowInsecureDb = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!['bundled', 'external'].includes(options.mode)) {
    throw new Error("--mode must be bundled or external");
  }
  if (options.removeVolumes && !options.down) {
    throw new Error("--remove-volumes is allowed only together with --down");
  }
  return options;
}

function deploymentSummary(options) {
  const envFile = resolve(options.envFile);
  if (options.down) {
    return [
      "This command will stop the Docker Compose deployment.",
      options.removeVolumes
        ? "It will also permanently delete all Compose volumes: database, installer state and widget assets."
        : "The bundled PostgreSQL volume and deployment data will be preserved.",
      `Environment file: ${envFile}`,
    ];
  }
  if (options.buildOnly) {
    return [
      "This command will prepare the deployment environment and build the application Docker image.",
      "It will not start containers or change Genesys Cloud or Telnyx objects.",
      `Environment file: ${envFile}`,
      `Image: ${options.image}`,
    ];
  }
  return [
    "This command will prepare the deployment environment, build the application image and start Docker Compose.",
    options.mode === "bundled"
      ? "It will create or reuse the bundled PostgreSQL database and persistent deployment volumes."
      : "It will connect the application to the external PostgreSQL database configured in the environment file.",
    options.runGenesys
      ? "It will then run the interactive Genesys/Telnyx bootstrap and restart the application."
      : "It will not change Genesys Cloud or Telnyx objects (--skip-genesys).",
    "Missing database bootstrap values and the encryption master key may be generated in the environment file.",
    `Environment file: ${envFile}`,
    `Image: ${options.image}`,
  ];
}

async function confirmDeployment(options) {
  console.log("\nTelnyx Genesys Integrations deployment\n");
  for (const line of deploymentSummary(options)) console.log(`- ${line}`);
  console.log("");
  if (options.yes) {
    console.log("[deploy] Confirmation skipped with --yes.");
    return true;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive confirmation requires a terminal. Re-run with --yes to continue non-interactively.");
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = String(await prompt.question("Continue? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function updateEnvironmentSource(source, values) {
  const pending = new Map(Object.entries(values));
  const lines = String(source || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${match[1] === "DATABASE_URL" ? JSON.stringify(value) : value}`;
  });
  if (lines.length && lines.at(-1) !== "") lines.push("");
  for (const [name, value] of pending) lines.push(`${name}=${name === "DATABASE_URL" ? JSON.stringify(value) : value}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function bootstrapEnvironment(path, options) {
  const absolute = resolve(path);
  const source = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
  const parsed = dotenv.parse(source);
  const generated = {};
  if (options.mode === "external" && !options.down && stdin.isTTY && stdout.isTTY && !options.yes && !options.dryRun) {
    if (!parsed.DATABASE_URL) {
      generated.DATABASE_URL = await password({ message: "External PostgreSQL connection URL", mask: "*", validate: v => {
        try { const url = new URL(v); return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname) && !/[\r\n]/.test(v) || "Enter a PostgreSQL connection URL"; }
        catch { return "Enter a PostgreSQL connection URL"; }
      } });
    }
    if (!parsed.PGSSLMODE && !parsed.POSTGRES_SSLMODE) generated.PGSSLMODE = await select({ message: "PostgreSQL TLS mode", choices: ["verify-full", "require", "disable"].map(value => ({ value })), default: "verify-full" });

  }

  if (!String(parsed.ADMIN_SECRETS_MASTER_KEY || "").trim()) {
    generated.ADMIN_SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
  }
  if (options.mode === "bundled") {
    // Inside the Compose network the database is always addressed by its
    // service name. A copied .env.example commonly contains 127.0.0.1 for
    // host-side development, which is not reachable from the app container.
    generated.POSTGRES_HOST = "postgres";
    generated.POSTGRES_PORT = String(parsed.POSTGRES_PORT || "5432").trim() || "5432";
    generated.POSTGRES_DB = String(parsed.POSTGRES_DB || "telnyx_genesys").trim() || "telnyx_genesys";
    generated.POSTGRES_USER = String(parsed.POSTGRES_USER || "telnyx_genesys").trim() || "telnyx_genesys";
    if (String(parsed.POSTGRES_PASSWORD || "").length < 16) {
      generated.POSTGRES_PASSWORD = randomBytes(32).toString("base64url");
    }
    generated.PGSSLMODE = "disable";
  }
  generated.NODE_ENV = "production";
  generated.PORT = String(parsed.PORT || "3000").trim() || "3000";
  if (options.dryRun) {
    return { absolute, values: { ...process.env, ...parsed, ...generated } };
  }
  if (Object.keys(generated).some((name) => parsed[name] !== generated[name])) {
    writeFileSync(absolute, updateEnvironmentSource(source, generated), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(absolute, 0o600);
    console.log(`[deploy] Generated missing Docker bootstrap values in ${absolute}`);
  }
  const finalSource = readFileSync(absolute, "utf8");
  const finalParsed = dotenv.parse(finalSource);
  return { absolute, values: { ...process.env, ...finalParsed } };
}

function isLocalDatabase(hostname) {
  return ["localhost", "127.0.0.1", "::1", "postgres"].includes(hostname);
}

function validateEnvironment(options, env) {
  const masterKey = String(env.ADMIN_SECRETS_MASTER_KEY || "").trim();
  let decodedMasterKey;
  try {
    decodedMasterKey = /^[a-fA-F0-9]{64}$/.test(masterKey)
      ? Buffer.from(masterKey, "hex")
      : Buffer.from(masterKey, "base64");
  } catch {
    decodedMasterKey = Buffer.alloc(0);
  }
  if (decodedMasterKey.length !== 32) {
    throw new Error("ADMIN_SECRETS_MASTER_KEY must decode to exactly 32 bytes");
  }
  if (options.mode === "bundled") {
    if (String(env.POSTGRES_PASSWORD || "").length < 16) {
      throw new Error("Bundled PostgreSQL requires POSTGRES_PASSWORD with at least 16 characters");
    }
    return;
  }

  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("External PostgreSQL mode requires DATABASE_URL");
  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  const sslMode = String(env.PGSSLMODE || env.POSTGRES_SSLMODE || "").toLowerCase();
  if (!isLocalDatabase(hostname) && ["", "disable", "disabled"].includes(sslMode) && !options.allowInsecureDb) {
    throw new Error(
      "Remote external PostgreSQL requires TLS (for example PGSSLMODE=verify-full). " +
      "Use --allow-insecure-db only for an explicitly accepted private-network exception."
    );
  }
}

function printable(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function run(command, args, { env, dryRun }) {
  console.log(`[deploy] ${printable(command, args)}`);
  if (dryRun) return;
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (response.ok) {
        console.log(`[deploy] Application is healthy: ${url}`);
        return;
      }
    } catch {
      // Container and PostgreSQL may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Application did not become healthy within 90 seconds: ${url}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.dryRun && !await confirmDeployment(options)) {
    console.log("[deploy] Deployment cancelled. No changes were made.");
    return;
  }
  const deployment = await bootstrapEnvironment(options.envFile, options);
  if (!options.down && !options.buildOnly) {
    validateEnvironment(options, deployment.values);
  }
  const childEnvironment = {
    ...deployment.values,
    APP_ENV_FILE: deployment.absolute,
    APP_IMAGE: options.image,
  };
  const compose = ["compose", "--env-file", deployment.absolute, "-f", "compose.yaml"];

  if (options.down) {
    run("docker", [...compose, "--profile", "bundled-db", "down", ...(options.removeVolumes ? ["--volumes"] : [])], {
      env: childEnvironment,
      dryRun: options.dryRun,
    });
    return;
  }

  run("docker", ["version"], { env: childEnvironment, dryRun: options.dryRun });
  if (options.buildOnly) {
    run("docker", ["build", "--tag", options.image, "."], {
      env: childEnvironment,
      dryRun: options.dryRun,
    });
    return;
  }
  if (options.pull) {
    run("docker", [...compose, "--profile", "bundled-db", "pull"], {
      env: childEnvironment,
      dryRun: options.dryRun,
    });
  }
  const profiles = options.mode === "bundled" ? ["--profile", "bundled-db"] : [];
  run("docker", [...compose, ...profiles, "--profile", "installer", "build", "app", "installer"], {
    env: childEnvironment,
    dryRun: options.dryRun,
  });
  if (options.mode === "bundled") {
    run("docker", [...compose, ...profiles, "up", "--detach", "postgres"], {
      env: childEnvironment,
      dryRun: options.dryRun,
    });
  }
  run("docker", [...compose, ...profiles, "up", "--detach", "--build", "--remove-orphans", "app"], {
    env: childEnvironment,
    dryRun: options.dryRun,
  });
  if (options.wait && !options.dryRun) {
    await waitForHealth(Number(deployment.values.PORT || 3000));
  }
  if (options.runGenesys) {
    run("docker", [
      ...compose,
      ...profiles,
      "--profile", "installer",
      "run", "--rm", "installer",
    ], { env: childEnvironment, dryRun: options.dryRun });
    run("docker", [...compose, ...profiles, "restart", "app"], {
      env: childEnvironment,
      dryRun: options.dryRun,
    });
    if (options.wait && !options.dryRun) {
      await waitForHealth(Number(deployment.values.PORT || 3000));
    }
  }
  console.log("[deploy] Deployment complete. PostgreSQL schema is ensured by server.mjs before HTTP traffic is accepted.");
}

main().catch((error) => {
  console.error(`[deploy] ${error.message}`);
  process.exitCode = 1;
});
