import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";

export function serializeInstallerEnvironmentValue(value) {
  const normalized = String(value);
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error("Environment values must be non-empty single-line strings");
  }
  return /^[A-Za-z0-9_./:+\-=]+$/.test(normalized)
    ? normalized
    : JSON.stringify(normalized);
}

export async function readInstallerEnvironmentFile(envFile = path.resolve(".env")) {
  try {
    const metadata = await lstat(envFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${envFile} must be a regular file, not a symlink`);
    }
    return await readFile(envFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function mergeInstallerEnvironmentFile(
  source,
  values,
  { allowedNames, replaceNames = [], mayReplace } = {}
) {
  const allowed = new Set(allowedNames || []);
  const replacements = new Set(replaceNames || []);
  const lines = String(source || "").split(/\r?\n/);
  const additions = [];

  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name)) {
      throw new Error(`Refusing to write unsupported environment variable ${name}`);
    }
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
    const matches = lines
      .map((line, index) => ({ line, index, match: line.match(pattern) }))
      .filter(({ match }) => match);
    if (matches.length > 1) {
      throw new Error(`Refusing to update duplicate ${name} entries in .env`);
    }
    if (matches.length === 1) {
      const current = String(parseDotenv(matches[0].line)[name] || "").trim();
      if (current && current !== String(value).trim()) {
        const explicitlyReplaceable = replacements.has(name);
        const conditionallyReplaceable = mayReplace?.(name, current, String(value)) === true;
        if (!explicitlyReplaceable && !conditionallyReplaceable) {
          throw new Error(`Refusing to overwrite existing ${name} in .env`);
        }
      }
      if (current === String(value).trim()) continue;
      lines[matches[0].index] = `${name}=${serializeInstallerEnvironmentValue(value)}`;
    } else {
      additions.push(`${name}=${serializeInstallerEnvironmentValue(value)}`);
    }
  }

  while (lines.length && lines.at(-1) === "") lines.pop();
  if (additions.length) {
    if (lines.length) lines.push("");
    lines.push("# Managed by the Genesys integration installer", ...additions);
  }
  return `${lines.join("\n")}\n`;
}

export async function saveInstallerEnvironmentValues({
  values,
  allowedNames,
  replaceNames = [],
  mayReplace,
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  const source = await readInstallerEnvironmentFile(envFile);
  const output = mergeInstallerEnvironmentFile(source, values, {
    allowedNames,
    replaceNames,
    mayReplace,
  });
  const temporary = `${envFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, envFile);
    await chmod(envFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  Object.assign(environment, values);
  return { saved: Object.keys(values), envFile };
}

export function removeInstallerEnvironmentValues(source, names) {
  const removals = new Set(names || []);
  const lines = String(source || "").split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !removals.has(match[1]);
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

export async function deleteInstallerEnvironmentValues({
  names,
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  const source = await readInstallerEnvironmentFile(envFile);
  const output = removeInstallerEnvironmentValues(source, names);
  const temporary = `${envFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, envFile);
    await chmod(envFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  for (const name of names || []) delete environment[name];
  return { deleted: [...(names || [])], envFile };
}
