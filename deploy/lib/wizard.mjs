import { input, select } from "@inquirer/prompts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { run, validateConfig } from "./cloud.mjs";

export const terminalIo = {
  ask: (message, value = "", validate = v => Boolean(v.trim()) || "Required") => input({ message, default: String(value), validate }),
  select: (message, values, value) => select({ message, choices: values.map(v => typeof v === "string" ? { name: v, value: v } : v), default: value }),
  log: message => console.log(`[deploy] ${message}`),
};
const json = (command, args) => JSON.parse(run(command, args, { capture: true, quiet: true }));
const slug = v => /^[a-z][a-z0-9-]{1,25}$/.test(v) || "Use a 2–26 character lowercase name";
const hostname = v => /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(v) || "Enter a public hostname without scheme or path";
const positive = v => /^\d+$/.test(v) && Number(v) > 0 || "Enter a positive integer";
const keyPath = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);

// Dependencies are injectable so the complete dialogue can be exercised without cloud access.
export async function wizard(target, saved = {}, { io = terminalIo, query = json } = {}) {
  const config = { ...saved };
  const field = async (key, label, fallback = "", validate) => {
    config[key] = await io.ask(label, config[key] ?? fallback, validate);
  };
  await field("deployment_name", "Deployment name", "genesys-integrations", slug);
  await field("domain", "Public hostname", "", hostname);
  await field("region", "Region", { aws: "us-east-2", azure: "westeurope", gcp: "europe-west1" }[target], v => /^[a-z][a-z0-9-]+$/.test(v) || "Enter a region name");
  if (target === "azure") {
    let accounts = [];
    try { accounts = query("az", ["account", "list", "--output", "json"]).filter(a => a.state === "Enabled"); }
    catch { io.log("Azure account discovery unavailable. Enter the subscription ID; authenticate with az login before provisioning."); }
    const manual = "manual";
    config.subscription_id = accounts.length ? await io.select("Azure subscription", [...accounts.map(a => ({ name: `${a.name} (${a.id})`, value: a.id })), { name: "Enter subscription ID", value: manual }], config.subscription_id ?? accounts.find(a => a.isDefault)?.id) : manual;
    if (config.subscription_id === manual) config.subscription_id = await io.ask("Azure subscription ID", saved.subscription_id ?? "", v => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v) || "Enter a UUID");
    let zones = [];
    try {
      zones = query("az", ["network", "dns", "zone", "list", "--subscription", config.subscription_id, "--output", "json"])
        .filter(z => config.domain === z.name || config.domain.endsWith(`.${z.name}`))
        .sort((a, b) => b.name.length - a.name.length);
    } catch { io.log("DNS zone discovery unavailable; you can enter the existing zone or manage DNS externally."); }
    const dns = await io.select("Public DNS management", [
      ...zones.map(z => ({ name: `Azure DNS: ${z.name} (${z.resourceGroup})`, value: z.id })),
      { name: "Enter existing Azure DNS zone", value: "manual" },
      { name: "Manage DNS externally", value: "external" },
    ], config.dns_zone_name ? zones.find(z => z.name === config.dns_zone_name && z.resourceGroup === config.dns_zone_resource_group)?.id ?? "manual" : zones[0]?.id ?? "external");
    if (dns === "external") {
      config.dns_zone_name = "";
      config.dns_zone_resource_group = "";
      io.log("After provisioning, create a DNS A record pointing this hostname to the printed VM IP. HTTPS requires that record.");
    } else if (dns === "manual") {
      await field("dns_zone_name", "Existing public Azure DNS zone", "", v => config.domain === v || config.domain.endsWith(`.${v}`) || "The hostname must belong to this zone");
      await field("dns_zone_resource_group", "DNS zone resource group");
    } else {
      const zone = zones.find(z => z.id === dns);
      config.dns_zone_name = zone.name;
      config.dns_zone_resource_group = zone.resourceGroup;
    }
    let usages = [];
    try { usages = query("az", ["vm", "list-usage", "--location", config.region, "--subscription", config.subscription_id, "--output", "json"]); }
    catch { io.log("Could not check VM quota; verify regional and VM-family quota before applying."); }
    const candidates = { Standard_D2s_v5: "standardDSv5Family", Standard_D2s_v3: "standardDSv3Family", Standard_D2as_v4: "standardDASv4Family" };
    const remaining = name => { const u = usages.find(u => u.name.value.toLowerCase() === name.toLowerCase()); return u ? u.limit - u.currentValue : undefined; };
    const available = Object.keys(candidates).find(s => remaining(candidates[s]) >= 2);
    for (;;) {
      await field("instance_type", "VM size (2 vCPU suggested for testing)", available ?? "Standard_D2s_v5");
      const family = candidates[config.instance_type];
      if (family && (remaining(family) < 2 || remaining("cores") < 2)) {
        io.log("This VM needs 2 free regional and family vCPUs. Choose another size, or cancel and change region/request quota.");
        delete config.instance_type;
        continue;
      }
      break;
    }
    await field("admin_cidr", "Your public IPv4 CIDR for SSH (for example 203.0.113.10/32)", "", v => {
      const p = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
      return Boolean(p && p.slice(1, 5).every(n => Number(n) <= 255) && +p[5] >= 24 && +p[5] <= 32) || "Use an IPv4 /24 through /32";
    });
    if (!config.ssh_public_key || await io.select("SSH public key", ["Reuse saved key", "Choose another key"], "Reuse saved key") === "Choose another key") {
      const suggested = ["id_rsa.pub", "id_ed25519.pub"].map(n => join(homedir(), ".ssh", n)).find(existsSync);
      const path = await io.ask("Path to SSH PUBLIC key (supports ~/)", suggested ?? "", v => {
        try { return /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: .*)?$/.test(readFileSync(keyPath(v), "utf8").trim()) || "Select a valid SSH public key"; }
        catch { return "Public key file cannot be read"; }
      });
      config.ssh_public_key = readFileSync(keyPath(path), "utf8").trim();
    }
    await field("db_instance_type", "PostgreSQL SKU", "B_Standard_B1ms");
    await field("disk_size_gb", "VM disk size (GB)", 64, positive);
    config.disk_size_gb = Number(config.disk_size_gb);
  } else if (target === "gcp") {
    let project = "";
    try { project = query("gcloud", ["config", "list", "--format=json"]).core?.project ?? ""; } catch { /* Manual entry remains available. */ }
    await field("project_id", "Google Cloud project ID", project, v => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v) || "Enter a valid project ID");
    await field("zone", "Zone", `${config.region}-b`, v => new RegExp(`^${config.region}-[a-z]$`).test(v) || "Zone must belong to the selected region");
    await field("instance_type", "VM machine type", "e2-medium");
    await field("db_instance_type", "Cloud SQL machine type", "db-custom-1-3840");
    await field("disk_size_gb", "VM disk size (GB)", 64, positive);
    config.disk_size_gb = Number(config.disk_size_gb);
    config.db_deletion_protection = await io.select("Protect Cloud SQL against deletion", [{ name: "Enabled", value: true }, { name: "Disabled", value: false }], config.db_deletion_protection ?? true);
  } else {
    await field("route53_zone_id", "Route53 hosted zone ID");
    await field("acm_certificate_arn", "Issued ACM certificate ARN in the selected region");
    await field("owner_email", "Deployment owner email", "", v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter an email address");
    await field("instance_type", "EC2 instance type", "t3.medium");
    await field("db_instance_class", "RDS instance class", "db.t4g.micro");
  }
  return validateConfig(target, config);
}
