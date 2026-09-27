# Changelog

Official versions follow [Semantic Versioning](https://semver.org/). The same
notes are published to
[GitHub Releases](https://github.com/team-telnyx/telnyx-genesys-integrations-shared/releases),
so an operator without repository access can read the release history. See
[docs/VERSIONING.md](docs/VERSIONING.md) for the compatibility policy and the
steps to publish a release.

## [1.1.0] - 2026-09-27

### Added

- Video calls in the web widget, powered by Telnyx Video Rooms and routed to a
  selected Genesys Cloud queue through Open Messaging. Publishing provisions
  the agent Interaction Widget, inbound message integration and Architect flow.
- Visitor and agent video views with camera preview, microphone and camera
  controls, screen sharing, layout selection and configurable waiting screens.
  Optional recording stores media in the connected Telnyx account.
- Queue-specific automatic opening of the video agent panel. Widget Studio
  reads the current Genesys setting and applies toggle changes on Publish,
  preserving other enabled video queues and unrelated media defaults.
- A waiting-video library with MP4/WebM uploads up to 64 MiB, reusable media,
  playlist ordering, HTTPS links and byte-range playback. Referenced media is
  protected from deletion.
- Widget Studio Test Page to run each published widget without hosting an
  external website. It supports test context, reload and opening in a new tab;
  access uses a scoped, expiring administrator grant.

### Fixed

- Ending a video call preserves Genesys after-contact work so agents can choose
  the wrap-up codes configured on their queue.
- Theme and video-layout controls no longer overlap in the Genesys agent panel.
- Test Page supports Light, Dark and System themes, with responsive theme
  controls contained within its header.
- Video launcher icons render correctly in the published widget, and abandoned
  or cancelled video calls are cleaned up without leaving queued interactions.

### Upgrade notes

- Startup applies the video session and media-library database migrations.
  Back up PostgreSQL and the persistent widget asset volume; multiple app
  instances must share the asset directory for uploaded waiting videos.
- Configure Telnyx Video Rooms access, the signed webhook key, an HTTPS public
  origin and Genesys queue membership before enabling Video and publishing.
  Video routing uses Genesys message capacity. Queue wrap-up settings are
  administered in Genesys and are preserved by widget publication.
- Reserve Open Messaging on queues with automatic video panel opening for
  video. Other Open Messaging interactions on those queues also match the
  native Genesys panel filter; phone calls do not match it. Agents choose the
  native panel size in Genesys Workspace.

See [Video setup](docs/video-channel.md) and
[Widget Studio Test Page](docs/widget-test-page.md) for configuration details.

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
