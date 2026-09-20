import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOutput, packageVersion, RELEASE_VERSION } from "./lib/build-info.mjs";

const REPOSITORY = "team-telnyx/telnyx-genesys-integrations";
const BADGE_START = "<!-- app-version:start -->";
const BADGE_END = "<!-- app-version:end -->";

/**
 * Every `## [version] - date` section of CHANGELOG.md, newest first.
 *
 * The changelog is the single source of release notes: the GitHub Release body
 * is generated from it, so an operator without repository access reads exactly
 * what a reviewer read. That only holds if the file cannot drift — hence the
 * validation here rather than a lenient parse.
 */
export function releaseSections(changelog) {
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)];
  const seen = new Set();
  return headings.map((match, index) => {
    const [, version, date] = match;
    if (!RELEASE_VERSION.test(version) || seen.has(version)) {
      throw new Error(`Invalid or duplicate release: ${version}`);
    }
    // Date.parse accepts 2026-02-30 and rolls it over to March; comparing the
    // round-trip rejects a day that does not exist.
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid release date: ${date}`);
    }
    seen.add(version);
    const tail = changelog.slice(match.index + match[0].length, headings[index + 1]?.index);
    // Unversioned history is kept in the changelog for readers but never ends
    // up in a release body, which describes one version only.
    const body = tail.split(/^## Historical changes/m)[0].trim();
    if (!body) throw new Error(`Release ${version} has no notes`);
    return { version, date, body };
  });
}

/**
 * Reconcile package.json, CHANGELOG.md and the README badge.
 *
 * With `check`, generated files are compared instead of written, so CI fails on
 * drift rather than committing a fix behind the author's back. With `tag`, the
 * release identity is additionally verified against the checked-out commit.
 */
export function syncReleaseFiles({ root = process.cwd(), check = false, tag = null } = {}) {
  const version = packageVersion(root);
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const releases = releaseSections(changelog);
  const current = releases.find((entry) => entry.version === version);
  if (!current || releases[0] !== current) {
    throw new Error("The first changelog release must match package.json");
  }
  if (tag && tag !== `v${version}`) throw new Error("Tag does not match package.json");

  const badge = `[![Version ${version}](https://img.shields.io/badge/version-${version.replaceAll("-", "--")}-00C389)](https://github.com/${REPOSITORY}/releases)`;
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  if (!readme.includes(BADGE_START)) throw new Error("README version marker is missing");
  const generated = {
    "README.md": readme.replace(
      new RegExp(`${BADGE_START}[\\s\\S]*?${BADGE_END}`),
      `${BADGE_START}\n${badge}\n${BADGE_END}`
    ),
  };

  for (const [path, expected] of Object.entries(generated)) {
    if (check) {
      if (readFileSync(resolve(root, path), "utf8") !== expected) {
        throw new Error(`${path} is out of date; run yarn release:sync`);
      }
    } else {
      writeFileSync(resolve(root, path), expected);
    }
  }

  if (tag) {
    // A published tag must describe source someone can check out again. A tag
    // pointing elsewhere, or a dirty tree, would ship an unreproducible build
    // under a version number people are expected to quote back.
    const commit = gitOutput(root, ["rev-parse", "HEAD"]);
    if (!commit || gitOutput(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit) {
      throw new Error("Release tag must point to the checked-out commit");
    }
    if (gitOutput(root, ["status", "--porcelain"]) !== "") {
      throw new Error("Release requires a clean working tree");
    }
  }

  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = "check", ...args] = process.argv.slice(2);
    const badArgs = args.length && (args.length !== 2 || args[0] !== "--tag" || !args[1]);
    if (!["sync", "check", "notes"].includes(command) || badArgs) {
      throw new Error("Usage: node scripts/release.mjs sync|check|notes [--tag vX.Y.Z]");
    }
    const release = syncReleaseFiles({ check: command !== "sync", tag: args[1] });
    console.log(
      command === "notes"
        ? `# Telnyx Genesys Integrations ${release.version}\n\n${release.body}`
        : `Release ${release.version}: ${command === "sync" ? "files synchronized" : "checks passed"}`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
