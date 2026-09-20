import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wizard } from "../deploy/lib/wizard.mjs";

function dialogue(answers) {
  const questions = [];
  return { questions, io: {
    ask: async (label, fallback, validate) => {
      questions.push(label);
      const value = String(answers[label] ?? fallback);
      if (validate) assert.equal(validate(value), true, label);
      return value;
    },
    select: async (label, values, fallback) => {
      questions.push(label);
      return answers[label] ?? fallback ?? values[0].value ?? values[0];
    },
    log: () => {},
  } };
}
const base = { "Public hostname": "genesys.example.com" };
test("fresh Azure dialogue collects every input and selects a VM family with quota", async t => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-wizard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, "test.pub");
  writeFileSync(key, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test\n");
  const id = "12345678-1234-1234-1234-123456789abc";
  const { io, questions } = dialogue({ ...base, "Your public IPv4 CIDR for SSH (for example 203.0.113.10/32)": "203.0.113.4/32", "Path to SSH PUBLIC key (supports ~/)": key });
  const config = await wizard("azure", {}, { io, query: (_cmd, args) => args.includes("account") ? [{ id, name: "Test", state: "Enabled", isDefault: true }] : args.includes("dns") ? [{ id: "zone-id", name: "example.com", resourceGroup: "dns-rg" }] : [
    { name: { value: "standardDSv5Family" }, limit: 0, currentValue: 0 },
    { name: { value: "standardDSv3Family" }, limit: 10, currentValue: 0 },
    { name: { value: "cores" }, limit: 10, currentValue: 0 },
  ] });
  assert.equal(config.subscription_id, id);
  assert.equal(config.dns_zone_name, "example.com");
  assert.equal(config.dns_zone_resource_group, "dns-rg");
  assert.equal(config.instance_type, "Standard_D2s_v3");
  assert.equal(config.disk_size_gb, 64);
  assert.match(config.ssh_public_key, /^ssh-rsa /);
  assert.ok(questions.includes("PostgreSQL SKU"));
});
test("GCP dialogue uses CLI project and supports changing saved sizing", async () => {
  const { io } = dialogue({ ...base, "VM machine type": "e2-standard-2" });
  const config = await wizard("gcp", { instance_type: "e2-medium" }, { io, query: () => ({ core: { project: "test-project" } }) });
  assert.equal(config.project_id, "test-project");
  assert.equal(config.zone, "europe-west1-b");
  assert.equal(config.instance_type, "e2-standard-2");
  assert.equal(config.db_deletion_protection, true);
});
test("AWS dialogue collects required infrastructure without FDE by default", async () => {
  const { io } = dialogue({ ...base, "Route53 hosted zone ID": "ZTEST", "Issued ACM certificate ARN in the selected region": "arn:aws:acm:us-east-2:123456789012:certificate/test", "Deployment owner email": "operator@example.com" });
  const config = await wizard("aws", {}, { io, query: () => { throw Error("unexpected cloud call"); } });
  assert.equal(config.route53_zone_id, "ZTEST");
  assert.equal(config.instance_type, "t3.medium");
  assert.equal(config.fde_enabled, undefined);
});
