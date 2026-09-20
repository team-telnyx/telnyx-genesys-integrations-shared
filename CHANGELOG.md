# Changelog

Official versions follow [Semantic Versioning](https://semver.org/). The same
notes are published to
[GitHub Releases](https://github.com/team-telnyx/telnyx-genesys-integrations/releases),
so an operator without repository access can read the release history. See
[docs/VERSIONING.md](docs/VERSIONING.md) for the compatibility policy and the
steps to publish a release.

## [1.0.0] - 2026-09-20

First versioned release. It establishes the compatibility baseline described in
`docs/VERSIONING.md`; everything before it is unversioned history in Git.

### Added

- Application versioning. `package.json` is the source of the version and this
  file is the source of release notes. Each build carries an identity captured
  from its source: version, commit, build identifier, UTC build time, matching
  release tag, channel and working-tree status. A clean checkout at `v1.0.0`
  reports `1.0.0`; anything else reports `1.0.0-dev`, because an untagged or
  modified tree is not that release.
- `GET /api/version` returns that identity. It is public and reads no database,
  so it keeps answering while `/api/health` reports degraded.
- The Genesys admin console header shows the running version, with the full
  identity — commit, build identifier, channel — on hover, so support can read
  it without shell access to the host.
- A release workflow. Pushing a `vX.Y.Z` tag validates the tag against
  `package.json`, runs the validation gate and publishes the GitHub Release from
  the notes in this file. Candidates (`1.1.0-rc.1`) publish as pre-releases.
- The S3 artifact workflow, `deploy/aws/deploy.sh` and Compose now pass the
  build identity into the image and record it in the artifact manifest, so a
  deployable artifact states which release it contains.

### Changed

- `.github/workflows/ci.yml` runs the validation gate — `yarn lint`, `yarn test`,
  `yarn build` — on every pull request, every push to `main` and a weekly cron.
  Nothing in CI ran it before; the only workflow was a manual image build.
- `.github/dependabot.yml` groups dependency updates so the ten-pull-request
  queue cannot fill: every open advisory arrives as one pull request, version
  updates as one weekly batch per dependency type, actions and the Docker base
  image monthly. Majors are excluded from the groups and arrive individually.

### Security

- Closed all ten open advisories, two of them critical: unauthenticated remote
  code execution in the Next.js Image Optimization API via AVIF, and
  unauthenticated remote code execution on windows-hosted servers. Both affect
  every 16.x before 16.3.3; this release ships 16.3.5. **Anyone self-hosting an
  earlier build should upgrade.** Also patched: `sharp` (libheif), `browserslist`
  (prototype write via untrusted custom stats, and unbounded cache growth),
  `js-yaml` (unbounded CPU on empty merge sources), `@humanfs/node` (recursive
  copy follows symlinks out of the tree), `baseline-browser-mapping` (denial of
  service on invalid input), `prismjs` (DOM clobbering) and `uuid` (missing
  buffer bounds check).

### Fixed

- Two tests asserted a demo widget embed that had been removed from the home
  page seven commits earlier, leaving `yarn test` red on `main`.

## Historical changes

Everything before 1.0.0 is recorded in the Git history and in the merged pull
requests of the repository. Those changes were never released under a version
number and are not restated here.
