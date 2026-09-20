#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { cloudDeploy, run, validateConfig, terraformEnvironment } from "./lib/cloud.mjs";

import dotenv from "dotenv";
import { wizard, terminalIo } from "./lib/wizard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commands = ["up", "plan", "update", "status", "bootstrap", "destroy"];
const targets = ["local", "aws", "azure", "gcp"];

export function parseArguments(argv) {
  const options = { command: "up", target: undefined, yes: false, dryRun: false, localArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && commands.includes(arg)) options.command = arg;
    else if (["--target", "--config", "--ssh-key"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[{ "--target": "target", "--config": "config", "--ssh-key": "sshKey" }[arg]] = value === "google" && arg === "--target" ? "gcp" : value;
    } else if (["--yes", "-y"].includes(arg)) options.yes = true;
    else if (["--fde", "-fde"].includes(arg)) options.fde = true;
    else if (arg === "--configure") options.configure = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (["--help", "-h"].includes(arg)) options.help = true;
    else options.localArgs.push(arg);
  }
  if (options.target && !targets.includes(options.target)) throw new Error("--target must be local, aws, azure or gcp");
  if (options.fde) {
    options.target ??= "aws";
    if (options.target !== "aws") throw new Error("--fde is supported only for AWS");
  }
  return options;
}

async function ask(question, fallback = "") {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Use --target and --config for a non-interactive cloud deployment");
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  } finally { reader.close(); }
}
async function confirm(message, yes) {
  console.log(`[deploy] ${message}`);
  if (yes) return;
  if (!/^(y|yes)$/i.test(await ask("Continue? [y/N]"))) throw new Error("Cancelled");
}

function help() {
  console.log(`Usage: ./deploy/deploy [up|plan|update|status|bootstrap|destroy] [options]
       npm run deploy -- [options]

  --target local|aws|azure|gcp   Deployment target (interactive menu, or local without a TTY)
  --fde                        Enable optional AWS FDE discovery tags (-fde also accepted)
  --config PATH                JSON infrastructure inputs (default: deploy/<target>/config.json)
  --configure                  Edit saved inputs interactively (up or plan)
  --yes                        Accept apply/update/destroy confirmation
  --dry-run                    Show actions without writing files or calling Docker/cloud APIs
  --ssh-key PATH               Azure bootstrap SSH private-key path (otherwise uses SSH agent)
  --help                       Show this help

Local options are forwarded to scripts/deploy.mjs, including --mode bundled|external,
--env-file PATH, --skip-genesys, --build-only, --down and --remove-volumes.
No target plus local options retains the original local deployment behavior.
Cloud credentials come from the provider's standard CLI/SDK credential chain.
See deploy/README.md for prerequisites, DNS, bootstrap, backups and teardown.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { help(); return; }
  if (!options.target) {
    options.target = stdin.isTTY && !options.dryRun && !options.localArgs.length
      ? await terminalIo.select("Where do you want to deploy?", targets, "local") : "local";
  }
  if (!targets.includes(options.target)) throw new Error("Unknown deployment target");
  if (options.target === "local") {
    if (options.config || options.sshKey) throw new Error("--config and --ssh-key are cloud options; use --env-file locally");
    if (options.configure) throw new Error("Local configuration is collected during up; --configure is a cloud option");
    if (options.command === "up" && stdin.isTTY && stdout.isTTY && !options.yes && !options.dryRun && !options.localArgs.includes("--mode") && !options.localArgs.includes("--down") && !options.localArgs.includes("--build-only")) {
      const envIndex = options.localArgs.indexOf("--env-file");
      const envFile = resolve(envIndex >= 0 ? options.localArgs[envIndex + 1] : join(root, ".env"));
      const values = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
      const mode = await terminalIo.select("PostgreSQL database", [{ name: "Bundled Docker database", value: "bundled" }, { name: "External PostgreSQL", value: "external" }], values.DATABASE_URL ? "external" : "bundled");
      options.localArgs.push("--mode", mode);
    }
    const args = [...options.localArgs, ...(options.yes ? ["--yes"] : []), ...(options.dryRun ? ["--dry-run"] : [])];
    if (options.command === "status") {
      if (options.dryRun) { console.log("docker compose --profile bundled-db ps"); return; }
      run("docker", ["compose", "--profile", "bundled-db", "ps"], { cwd: root });
    } else if (options.command === "bootstrap") {
      if (options.dryRun) { console.log("docker compose --profile installer run --rm installer; restart app"); return; }
      if (options.localArgs.length) throw new Error("Local bootstrap uses .env; run local up with --env-file for a custom environment");
      run("docker", ["compose", "--profile", "installer", "run", "--rm", "installer"], { cwd: root });
      run("docker", ["compose", "restart", "app"], { cwd: root });
    } else {
      if (options.command === "plan" && !args.includes("--dry-run")) args.push("--dry-run");
      if (options.command === "destroy") args.push("--down");
      if (options.command === "update" && !args.includes("--skip-genesys")) args.push("--skip-genesys");
      run(process.execPath, ["--", join(root, "scripts/deploy.mjs"), ...args], { cwd: root });
    }
    return;
  }
  if (options.localArgs.length) throw new Error(`Unknown cloud arguments: ${options.localArgs.join(" ")}`);
  const configFile = resolve(options.config || join(root, "deploy", options.target, "config.json"));
  let config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : undefined;
  const interactive = stdin.isTTY && stdout.isTTY && !options.dryRun && !options.yes;
  const configurable = ["up", "plan"].includes(options.command);
  if (options.configure && !configurable) throw new Error("--configure is supported with up or plan");
  if (configurable && interactive) {
    const edit = !config || options.configure || await terminalIo.select("Saved deployment configuration", ["Reuse", "Edit"], "Reuse") === "Edit";
    if (edit) {
      config = await wizard(options.target, config);
      mkdirSync(dirname(configFile), { recursive: true });
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      chmodSync(configFile, 0o600);
      console.log(`[deploy] Saved infrastructure inputs to ${configFile}`);
    }
  } else if (options.configure) throw new Error("--configure requires an interactive terminal without --yes or --dry-run");
  if (config) config = validateConfig(options.target, config);
  else if (configurable || options.command === "destroy" || options.config) {
    throw new Error("Run npm run deploy -- plan --target " + options.target + " in a terminal to collect configuration, or pass --config for unattended runs");
  }
  if (options.target === "aws") {
    if (options.dryRun) {
      console.log(`[deploy] AWS ${options.command}: ${join(root, "deploy/aws/deploy.sh")} ${options.command}${options.fde || config?.fde_enabled ? " --fde" : ""}`);
      console.log(`[deploy] Inputs: ${configFile}; no files, AWS resources or containers changed`);
      return;
    }
    const env = terraformEnvironment(config || {});
    for (const [key, value] of Object.entries(config || {})) {
      env[key === "region" ? "AWS_REGION" : key.toUpperCase()] = typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    if (Array.isArray(config?.portainer_server_cidrs)) env.PORTAINER_SERVER_CIDRS = config.portainer_server_cidrs.join(",");
    run("bash", [join(root, "deploy/aws/deploy.sh"), options.command, ...(options.yes ? ["--yes"] : []), ...(options.fde ? ["--fde"] : [])], { env, cwd: root });
  } else {
    await cloudDeploy({ ...options, root, config, confirm });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[deploy] ${error.message}`); process.exitCode = 1; });
}
