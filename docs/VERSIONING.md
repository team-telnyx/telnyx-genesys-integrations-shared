# Application versioning and releases

`package.json` is the source of the application version. `CHANGELOG.md` is the
source of release notes. `yarn release:sync` regenerates the README version
badge from both; `yarn release:check` verifies it without writing, which is what
CI runs. GitHub Releases publishes the same notes, so an operator without
repository access reads exactly what a reviewer read.

## Compatibility policy

Releases follow [SemVer](https://semver.org/):

- PATCH (`1.0.1`): backward-compatible fixes.
- MINOR (`1.1.0`): backward-compatible features and deprecations.
- MAJOR (`2.0.0`): incompatible changes to the supported integration contracts —
  the documented HTTP and webhook endpoints, the Open Messaging and AudioHook
  protocol surfaces, the widget embed contract (`public/widget/v1/loader.js` and
  the widget configuration `schemaVersion`), documented installer configuration,
  or the supported upgrade path.
- Pre-release (`1.1.0-rc.1`): a candidate for acceptance testing, marked as a
  pre-release on GitHub and reported as the `prerelease` channel in the app.

The supported contract is the documented endpoints and webhooks that
integrations call, the documented environment settings, and the persisted
configuration that a supported upgrade accepts. Internal functions, the
PostgreSQL schema, installer plan internals and visual layout are not public
APIs. Backward-compatible automatic migrations (`lib/postgres-schema.mjs`) can
accompany a minor or patch release; an incompatible upgrade, or one needing
manual conversion, belongs in a major release and must be described in its
notes. Managed Genesys and Telnyx resource names are covered by
`lib/genesys/installation-scope.mjs` and its legacy fallbacks — renaming a
managed resource is a major change, because existing installations track
resources by name and immutable ID.

Version 1.0.0 establishes the first compatibility baseline.

## Build identity

`GET /api/version`, the admin console header and the artifact manifest all read
one snapshot, embedded in the server and browser bundles during `next build`. It
contains the package version, full and short commit SHA, build identifier, UTC
build timestamp, matching release tag, channel and working-tree status — no
secrets and no deployment addresses. The endpoint is public, sends
`Cache-Control: no-store`, and reads no database, so it keeps answering while
`/api/health` reports degraded. (`server.mjs` still applies migrations before it
serves anything, so a process that cannot reach PostgreSQL does not start.)

A clean checkout exactly at `v1.0.0` reports `1.0.0`. An untagged or modified
checkout reports `1.0.0-dev`, and its build ID carries the SHA and, where it
applies, `dirty`. The build ID also carries the UTC build timestamp, so two
compilations of the same commit are distinguishable. The development suffix
identifies unreleased code built from that source version; it is not an
update-availability signal, and there is no automatic update check.

Changing a runtime environment variable, moving a branch, or publishing a newer
GitHub Release does not change an existing bundle's embedded version. Rebuild to
change it. Under `yarn dev` the metadata is captured when the dev server starts;
restart it to refresh the identity after further local edits.

## Docker builds

The Docker context excludes `.git`, so an image cannot work out its own
identity. The build host captures a snapshot and passes it as the
`GI_BUILD_INFO` build argument; `next.config.mjs` validates the version in it
against the `package.json` that actually ships. Without the argument the image
is labelled a development build, which is what an unidentified build is.

Every path that produces a deployable image supplies it:
`.github/workflows/build-s3-image-artifact.yml`, `deploy/aws/deploy.sh`, and
`compose.yaml` (from the `GI_BUILD_INFO` environment variable). Artifact
manifests include the full snapshot, and images carry
`org.opencontainers.image.version`, `.revision` and `.created` labels.

For a direct Compose build from the repository root:

```bash
export GI_BUILD_INFO="$(node scripts/build-info.mjs)"
docker compose build app
unset GI_BUILD_INFO
```

For a direct Docker build:

```bash
docker build --build-arg GI_BUILD_INFO="$(node scripts/build-info.mjs)" -t telnyx-genesys-integrations:local .
```

These only build an image. With no Git checkout and no supplied metadata the
package version is still known, but the commit is not and the channel is
development. Never claim a stable identity for a source archive nobody can
verify.

## Publishing a release

1. Choose the next version and update `package.json`. Add its dated section at
   the top of `CHANGELOG.md` — changes, upgrade steps, known limitations.
2. Run `yarn release:sync`, then the validation gate: `yarn lint`, `yarn test`,
   `yarn build`. Open a pull request with those files. The `Application
   versioning` workflow checks the generated badge and the metadata behaviour;
   `CI` runs the gate.
3. Merge after review. Fetch the merged default branch and identify the exact
   commit to release. Complete acceptance testing before tagging.
4. Create and push an annotated tag matching the package version:

   ```bash
   git tag -a v1.0.0 <validated-commit> -m "Telnyx Genesys Integrations 1.0.0"
   git push origin v1.0.0
   ```

5. The `Publish release` workflow validates the tag against `package.json` and
   against the commit it points at, confirms a checkout there reports a stable
   (or prerelease) channel, runs the validation gate on that commit, and then
   publishes the GitHub Release from the canonical notes. Candidates publish as
   pre-releases. A failed gate publishes nothing — read Actions before
   announcing availability.
6. Build the deployable image from that exact tag. In `fde-infra` choose
   **Build artifact**, pick the application, and select the tag from the offered
   release tags; the workflow builds from it and writes the artifact and its
   manifest to S3. Deploy the selected artifact through the normal, separately
   authorized operational process.

One release can contain several pull requests. Every build has its own build
information; there is no automatic version bump per commit. Published tags are
immutable — fix a released problem with a new version rather than moving or
overwriting a tag. The release workflow does not deploy anything and does not
touch a running environment.

## How the deployment tooling sees releases

`fde-infra` (the FDE Infra CLI) discovers this application from EC2 tags and
offers two kinds of build ref:

- the repository's default branch, `main` — the everyday case, carrying whatever
  has merged since the last release. Those builds label themselves development
  builds, which is exactly what they are.
- release tags, listed newest first. The CLI reads them with
  `gh api repos/team-telnyx/telnyx-genesys-integrations/tags` and keeps the ones
  matching `^v\d+\.\d+\.\d+`, so a tag named any other way is invisible there.

That distinction is not cosmetic: a build reports a clean version only when the
commit it was built from carries the matching tag, so picking a tag in the CLI
is the only way to produce an artifact that states a release version. The
artifact manifest records the same snapshot, so the version can still be read
back from S3 long after the build.
