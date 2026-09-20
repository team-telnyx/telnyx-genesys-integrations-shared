import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInfoFromSource,
  createBuildInfo,
  dockerBuildMetadata,
  packageVersion,
} from "../scripts/lib/build-info.mjs";
import { releaseSections, syncReleaseFiles } from "../scripts/release.mjs";
import { versionInfoText } from "../lib/app-version.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const now = new Date("2026-09-20T12:34:56.000Z");
const dirs = [];

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// --allow-empty: several cases only need HEAD to move past the tag, with no
// file change to make.
const commit = (root, message) =>
  git(root, "-c", "user.name=Version Test", "-c", "user.email=version@example.test", "commit", "--allow-empty", "-qm", message);
const read = (relativePath) => readFileSync(resolve(repoRoot, relativePath), "utf8");

function fixture(version = "1.0.0", withGit = true) {
  const root = mkdtempSync(join(tmpdir(), "gi-version-test-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  if (withGit) {
    git(root, "init", "-q");
    git(root, "add", "package.json");
    commit(root, "Initial source");
  }
  return root;
}

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a clean matching tag is a stable release, and later commits are development builds", () => {
  const root = fixture();
  git(root, "tag", "v1.0.0");

  const info = createBuildInfo({ root, env: {}, now });
  assert.equal(info.channel, "stable");
  assert.equal(info.displayVersion, "1.0.0");
  assert.equal(info.tag, "v1.0.0");
  assert.equal(info.commit, git(root, "rev-parse", "HEAD"));
  assert.equal(info.dirty, false);
  assert.equal(info.builtAt, now.toISOString());

  commit(root, "Next change");
  const next = createBuildInfo({ root, env: {}, now });
  assert.equal(next.channel, "development");
  assert.equal(next.displayVersion, "1.0.0-dev");
  assert.equal(next.tag, null);
  assert.notEqual(next.commit, info.commit);
});

test("tracked and untracked local changes cannot masquerade as the tagged release", () => {
  for (const path of ["package.json", "new-feature.js"]) {
    const root = fixture();
    git(root, "tag", "v1.0.0");
    writeFileSync(join(root, path), path === "package.json" ? '{"version":"1.0.0","changed":true}' : "new work");
    const info = createBuildInfo({ root, env: {}, now });
    assert.equal(info.channel, "development", path);
    assert.equal(info.dirty, true, path);
    assert.equal(info.tag, null, path);
    assert.match(info.buildId, /\.dirty$/, path);
  }
});

test("candidate tags keep their SemVer and report the prerelease channel", () => {
  const root = fixture("1.1.0-rc.1");
  git(root, "tag", "v1.1.0-rc.1");
  const info = createBuildInfo({ root, env: {}, now });
  assert.equal(info.channel, "prerelease");
  assert.equal(info.displayVersion, "1.1.0-rc.1");
});

test("every build has its own identity and a host recapture ignores an exported snapshot", () => {
  const root = fixture();
  git(root, "tag", "v1.0.0");
  const first = createBuildInfo({ root, env: {}, now });
  const later = createBuildInfo({ root, env: {}, now: new Date(now.getTime() + 1_000) });
  assert.notEqual(first.buildId, later.buildId);

  // scripts/build-info.mjs must describe the checkout it runs in, never repeat
  // a snapshot left in the environment by an earlier build.
  writeFileSync(join(root, "new-feature.js"), "local work");
  const fresh = JSON.parse(
    execFileSync(process.execPath, [resolve(repoRoot, "scripts/build-info.mjs")], {
      cwd: root,
      env: { ...process.env, GI_BUILD_INFO: JSON.stringify(first) },
      encoding: "utf8",
    })
  );
  assert.equal(fresh.dirty, true);
  assert.equal(fresh.channel, "development");
  assert.equal(fresh.tag, null);
});

test("a source archive without Git never invents a revision or a stable channel", () => {
  const info = createBuildInfo({ root: fixture("1.0.0", false), env: {}, now });
  assert.equal(info.channel, "development");
  assert.equal(info.commit, null);
  assert.equal(info.dirty, null);
  assert.match(info.buildId, /\+unknown\.build\./);
});

test("Docker metadata round-trips through an allowlist and is validated against package.json", () => {
  const root = fixture();
  git(root, "tag", "v1.0.0");
  const original = createBuildInfo({ root, env: {}, now });

  // The build context has no .git; the snapshot arrives as a build argument.
  const context = fixture("1.0.0", false);
  const info = createBuildInfo({
    root: context,
    env: { GI_BUILD_INFO: JSON.stringify({ ...original, secret: "never expose" }) },
  });
  assert.deepEqual({ ...info }, { ...original });
  assert.equal(Object.hasOwn(info, "secret"), false);

  const docker = dockerBuildMetadata(info);
  assert.equal(docker.labels["org.opencontainers.image.version"], "1.0.0");
  assert.equal(docker.labels["org.opencontainers.image.revision"], original.commit);
  assert.deepEqual(JSON.parse(docker.args.GI_BUILD_INFO), { ...info });

  // A snapshot from a different version must not label this source.
  writeFileSync(join(context, "package.json"), '{"version":"1.1.0"}');
  assert.throws(
    () => createBuildInfo({ root: context, env: { GI_BUILD_INFO: JSON.stringify(original) } }),
    /does not match/
  );
});

test("contradictory metadata fails instead of silently mislabelling a release", () => {
  const base = { version: "1.0.0", commit: "a".repeat(40), tag: "v1.0.0", dirty: false, builtAt: now.toISOString() };
  for (const invalid of [
    { version: "01.0.0" },
    { version: "1.0.0-01" },
    { version: "1.0.0+custom" },
    { commit: "not-a-sha" },
    { tag: "v2.0.0" },
    { dirty: true },
    { commit: null },
    { builtAt: "bad date" },
  ]) {
    assert.throws(() => buildInfoFromSource({ ...base, ...invalid }), JSON.stringify(invalid));
  }
});

test("the runtime accessor freezes at import and ignores later environment changes", async () => {
  const root = fixture();
  git(root, "tag", "v1.0.0");
  const info = createBuildInfo({ root, env: {}, now });
  const previous = process.env.NEXT_PUBLIC_GI_BUILD_INFO;
  process.env.NEXT_PUBLIC_GI_BUILD_INFO = JSON.stringify(info);
  try {
    // Next inlines this value at compile time; here the module is imported once
    // and the binding is frozen, which is the property the app depends on.
    const accessor = await import(`../lib/app-version.mjs?frozen=${Date.now()}`);
    assert.deepEqual({ ...accessor.APP_BUILD }, { ...info });
    assert.equal(Object.isFrozen(accessor.APP_BUILD), true);

    process.env.NEXT_PUBLIC_GI_BUILD_INFO = JSON.stringify({ ...info, version: "99.0.0" });
    assert.equal(accessor.APP_BUILD.version, "1.0.0");
    assert.match(accessor.versionInfoText(), new RegExp(info.commit));
    assert.match(accessor.versionInfoText(), /Channel: stable/);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_GI_BUILD_INFO;
    else process.env.NEXT_PUBLIC_GI_BUILD_INFO = previous;
  }
});

test("copyable version text is complete, and unknown information stays explicit", () => {
  const info = createBuildInfo({ root: fixture("1.0.0", false), env: {}, now });
  assert.match(versionInfoText(info), /Commit: Unavailable/);
  assert.match(versionInfoText(info), /Working tree: Unknown/);
  assert.match(versionInfoText(info), /Channel: development/);
  assert.match(versionInfoText(null), /unavailable/);
});

function releaseFixture() {
  const root = fixture();
  writeFileSync(join(root, "README.md"), "# Product\n<!-- app-version:start -->\n<!-- app-version:end -->\n");
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [1.0.0] - 2026-09-20\n\n### Added\n\n- Version information.\n\n## Historical changes\n\nOld notes.\n"
  );
  syncReleaseFiles({ root });
  git(root, "add", ".");
  commit(root, "Release notes");
  return root;
}

test("release notes have one source, keep history in the file, and reject generated drift", () => {
  const root = releaseFixture();
  const release = syncReleaseFiles({ root, check: true });
  assert.match(release.body, /Version information/);
  // Unversioned history stays readable in the changelog but never ends up in a
  // release body, which describes exactly one version.
  assert.doesNotMatch(release.body, /Old notes/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /badge\/version-1\.0\.0/);

  writeFileSync(join(root, "README.md"), "# Product\n<!-- app-version:start -->\nstale\n<!-- app-version:end -->\n");
  assert.throws(() => syncReleaseFiles({ root, check: true }), /out of date/);
});

test("publishing requires the exact matching tag at the checked-out clean commit", () => {
  const root = releaseFixture();
  git(root, "tag", "v1.0.0");
  assert.equal(syncReleaseFiles({ root, check: true, tag: "v1.0.0" }).version, "1.0.0");
  assert.throws(() => syncReleaseFiles({ root, check: true, tag: "v2.0.0" }), /does not match/);

  commit(root, "Moved on");
  assert.throws(() => syncReleaseFiles({ root, check: true, tag: "v1.0.0" }), /checked-out commit/);
});

test("invalid dates, duplicate versions, and missing notes are rejected", () => {
  for (const text of [
    "## [1.0.0] - 2026-02-30\nNotes",
    "## [1.0.0] - 2026-09-20\n",
    "## [1.0.0] - 2026-09-20\nNotes\n## [1.0.0] - 2026-09-21\nNotes",
  ]) {
    assert.throws(() => releaseSections(text), text);
  }
  const root = releaseFixture();
  writeFileSync(join(root, "package.json"), '{"version":"1.1.0"}');
  assert.throws(() => syncReleaseFiles({ root, check: true }), /first changelog release/);
});

test("every build path passes the captured identity into the image", () => {
  // The build context excludes .git, so an image that is not handed a snapshot
  // can only call itself a development build. Each of these is a place a
  // deployable image is produced; leaving one out ships a release that reports
  // itself as unreleased.
  //
  // The first version of this test checked the Dockerfile, Compose and the two
  // AWS paths and declared the job done — while scripts/deploy.mjs (local) and
  // deploy/lib/cloud.mjs (Azure, GCP) built images with no snapshot at all. A
  // test that enumerates "every path" has to enumerate every path, so the list
  // below is checked against the builders actually present in the tree.
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ARG GI_BUILD_INFO/);
  assert.match(dockerfile, /ENV GI_BUILD_INFO=\$GI_BUILD_INFO/);

  const compose = read("compose.yaml");
  assert.match(compose, /GI_BUILD_INFO: \$\{GI_BUILD_INFO:-\}/);

  const workflow = read(".github/workflows/build-s3-image-artifact.yml");
  assert.match(workflow, /node scripts\/build-info\.mjs/);
  assert.match(workflow, /--build-arg GI_BUILD_INFO=/);
  assert.match(workflow, /org\.opencontainers\.image\.version/);
  // The FDE CLI reads the manifest to label an artifact; without the version it
  // can only show a commit. Asserted as displayVersion by its own test below.
  assert.match(workflow, /"version": build\["displayVersion"\]/);

  const awsDeploy = read("deploy/aws/deploy.sh");
  assert.match(awsDeploy, /node scripts\/build-info\.mjs/);
  assert.match(awsDeploy, /--build-arg GI_BUILD_INFO=/);

  // Local Compose deployment.
  const localDeploy = read("scripts/deploy.mjs");
  assert.match(localDeploy, /createBuildInfo/);
  assert.match(localDeploy, /GI_BUILD_INFO: JSON\.stringify\(createBuildInfo\(\{ env: \{\} \}\)\)/);
  // The direct --build-only invocation needs the argument, not just the
  // environment: Docker does not turn an env var into a Dockerfile ARG.
  assert.match(localDeploy, /"build", "--build-arg", `GI_BUILD_INFO=/);

  // Azure and GCP.
  const cloudDeploy = read("deploy/lib/cloud.mjs");
  assert.match(cloudDeploy, /createBuildInfo/);
  assert.match(cloudDeploy, /--build-arg", `GI_BUILD_INFO=/);
});

test("no builder invokes docker without handing it the identity", () => {
  // The enumeration above only proves the paths it names. This finds the
  // builders instead: every `docker build` and every Compose build in the tree
  // has to be accompanied by the snapshot, so a new deployment target cannot
  // quietly ship images that call themselves development builds.
  const builders = [
    "deploy/aws/deploy.sh",
    "deploy/lib/cloud.mjs",
    "scripts/deploy.mjs",
  ];
  for (const path of builders) {
    const source = read(path);
    const buildsImages = /docker(",| )\s*(build|\[|compose)/.test(source) || /"build"/.test(source);
    if (!buildsImages) continue;
    assert.match(source, /GI_BUILD_INFO/, `${path} builds an image without GI_BUILD_INFO`);
  }
});

test("host-side capture ignores a snapshot left in the environment", () => {
  // createBuildInfo() reads process.env by default, which is correct inside the
  // Docker build — that is how the snapshot crosses into the image. It is wrong
  // on the host: docs/VERSIONING.md tells operators to `export GI_BUILD_INFO`
  // for a direct build, and a value left over from an earlier build of the same
  // version would then be stamped onto the next one. An untagged checkout would
  // claim the old commit and its release tag.
  const root = fixture();
  const stale = {
    version: "1.0.0",
    commit: "a".repeat(40),
    tag: "v1.0.0",
    dirty: false,
    builtAt: "2020-01-01T00:00:00.000Z",
  };
  const inherited = createBuildInfo({ root, env: { GI_BUILD_INFO: JSON.stringify(stale) }, now });
  assert.equal(inherited.channel, "stable", "the inherited snapshot is what crosses into a Docker build");

  const captured = createBuildInfo({ root, env: {}, now });
  assert.equal(captured.channel, "development");
  assert.notEqual(captured.commit, stale.commit);
  assert.equal(captured.tag, null);

  // Every host-side capture must ask for the empty environment.
  for (const path of ["scripts/build-info.mjs", "scripts/deploy.mjs", "deploy/lib/cloud.mjs"]) {
    assert.match(read(path), /createBuildInfo\(\{[^)]*env: \{\}/, `${path} must capture with env: {}`);
  }
});

test("artifact manifests label the build with displayVersion, not the bare package version", () => {
  // An untagged build has version "1.0.0" and displayVersion "1.0.0-dev".
  // Writing the former into the manifest's top-level label presents a
  // development build as a release wherever an artifact is listed.
  for (const path of [".github/workflows/build-s3-image-artifact.yml", "deploy/aws/deploy.sh"]) {
    const source = read(path);
    assert.match(source, /"version": build\["displayVersion"\]/, path);
    assert.doesNotMatch(source, /"version": build\["version"\]/, path);
  }
});

test("release tags follow the pattern the deployment tooling discovers", () => {
  // fde-infra-cli lists release tags with /^v\d+\.\d+\.\d+/ and offers them as
  // build refs. A tag shaped differently is invisible there, so the documented
  // tag name and the published version have to agree.
  const version = packageVersion(repoRoot);
  assert.match(`v${version}`, /^v\d+\.\d+\.\d+/);
  assert.match(read("docs/VERSIONING.md"), /git tag -a v/);
  assert.match(read(".github/workflows/release.yml"), /tags: \["v\*"\]/);
});

test("the repository's own release files are synchronized", () => {
  assert.equal(syncReleaseFiles({ root: repoRoot, check: true }).version, packageVersion(repoRoot));
});
