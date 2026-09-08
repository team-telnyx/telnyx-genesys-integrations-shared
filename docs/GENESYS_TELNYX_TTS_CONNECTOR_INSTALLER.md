# Genesys Cloud TTS Connector for Telnyx REST TTS

This runbook describes the Web Admin workflow that connects Genesys Cloud
Architect to Telnyx REST text-to-speech providers:

```text
Genesys Cloud Architect
  -> Genesys TTS Connector
  -> Telnyx REST Text-to-Speech API
  -> selected TTS provider
```

This integration is separate from the WebSocket-based Audio Connector described
in [`GENESYS_TELNYX_AUDIO_CONNECTOR.md`](GENESYS_TELNYX_AUDIO_CONNECTOR.md).
TTS Connector sends an HTTP request for each text segment and expects a binary
audio response.

## Organization-wide scope

Genesys TTS Connector instances, their shared credential, and the optional
Architect listening-test flows belong to the Genesys organization, not to an
individual application deployment. DEV and PROD installations connected to
the same Genesys organization therefore observe and manage the same resources.
They must not create environment-specific copies; this also preserves the
organization limit of 10 TTS Connector instances.

Web Admin always initializes the TTS editor from the current live Genesys
inventory. A configuration snapshot stored by one application installation is
not treated as authoritative for shared TTS state. Every plan identifies the
Genesys organization, expires after 60 minutes, and revalidates connector and
flow snapshots immediately before mutation. If another installation changes a
resource after plan review, apply stops and requires a refreshed plan.

## What the installer manages

The installer can:

- create or update `genesys-tts-connector` instances;
- configure installer-supported Telnyx TTS provider profiles;
- reuse an existing Genesys credential or create a dedicated credential;
- generate a read-only plan before changing Genesys Cloud;
- detect configuration drift, profile-version drift, and instance limits;
- write redacted run journals and restore previous connector configuration;
- optionally publish isolated Architect flows for listening tests;
- interactively remove revalidated, Telnyx-backed connectors and their owned
  test flows.

It never creates, deletes, assigns, or reroutes a DID or call route. It also
does not include an audio proxy or resampler. Profiles that cannot provide the
required 8 kHz audio contract are not offered for installation.

## Files

| File | Purpose |
|---|---|
| `scripts/manage-genesys-telnyx-tts.mjs` | Internal planner/apply library used by Web Admin |
| `lib/genesys/tts-connector-profiles.mjs` | Versioned provider profiles |
| `lib/genesys/tts-connector-manager.mjs` | Planning, drift detection, journals, and redaction |
| `lib/genesys/tts-connector-genesys.mjs` | Genesys Platform API adapter |
| `lib/genesys/tts-connector-architect.mjs` | Optional Architect listening-test flows |
| `lib/genesys/tts-provider-catalog.mjs` | Telnyx voice and language catalog |
| `lib/genesys/telnyx-tts-audio-probe.mjs` | Development-only audio inspection utility |
| `tests/genesys-telnyx-tts-manager.test.mjs` | Installer safety and contract tests |

## Installer profiles

Web Admin exposes the following profiles when their definitions pass
local validation:

| Profile | Provider or model | Audio response |
|---|---|---|
| `aws-polly-pcm` | AWS Polly | PCM16LE mono, 8 kHz |
| `xai-pcm` | xAI | PCM16LE mono, 8 kHz |
| `inworld-pcm` | Inworld Mini | LINEAR16 mono, 8 kHz |
| `minimax-pcm` | MiniMax | PCM16LE mono, 8 kHz |
| `rime-pcm` | Rime Coda | PCM16LE mono, 8 kHz |
| `naturalhd-pcm` | Telnyx NaturalHD | PCM16LE mono, 8 kHz |
| `resemble-wav` | Resemble Pro | WAV PCM16 mono, 8 kHz |
| `fishaudio-pcm` | FishAudio | PCM16LE mono, 8 kHz |
| `murfai-pcm` | MurfAI FALCON | PCM16LE mono, 8 kHz |
| `ultra-pcm` | Telnyx Ultra | PCM16LE mono, 8 kHz |
| `azure-pcm` | Azure through Telnyx | PCM16LE mono, 8 kHz |

Voice catalogs are retrieved dynamically from Telnyx where the provider exposes
the metadata Genesys requires. The xAI profile uses a static catalog because
its live catalog does not provide the language metadata Architect needs for
voice selection. FishAudio also uses a managed static catalog: its provider
endpoint mixes `s2.1-pro`, `s2-pro`, and `s1` voices and reports base language
codes such as `en`. The FishAudio profile exposes only the verified `s2.1-pro`
English voices and maps their catalog language to `en-US` for Genesys Architect.

Telnyx model families use server-side catalog filtering. For example, the
NaturalHD and Ultra profiles expose `provider=telnyx&model=NaturalHD` and
`provider=telnyx&model=Ultra` voice URLs to Genesys. The installer uses the
same provider/model combinations when it loads metadata, then still validates
every returned record against the expected model before offering it.

The profile definitions preserve provider-specific parameter names, casing,
and value types. Do not normalize fields such as `sample_rate`,
`sampling_rate`, `PCM`, or `pcm` without updating the profile tests.

## Prerequisites

- Node.js 20 or newer.
- Repository dependencies installed with Yarn.
- Network access to the selected Genesys Cloud region and `api.telnyx.com`.
- A Genesys OAuth Client Credentials client in the same organization and region.
- Genesys TTS Connector enabled for the organization in AppFoundry, with any required terms accepted.
- Genesys BYOT-A access and capacity for the intended connector instances.
- A Telnyx API key when creating a new Genesys credential.
- A maintenance window when changing a connector used by live Architect flows.

Web Admin verifies that the `genesys-tts-connector` integration type is enabled
for the organization. An empty connector inventory is valid: the first selected
provider creates the first instance during apply. AppFoundry entitlement,
commercial approval, and acceptance of terms remain administrator actions and
cannot be performed by this installer.

Genesys documents a limit of ten TTS Connector instances per organization,
including disabled instances. The installer counts the current inventory before
planning creates.

Official references:

- [Install the Genesys TTS Connector integration](https://help.genesys.cloud/articles/install-the-genesys-tts-connector-integration/)
- [Activate and configure the Genesys TTS Connector integration](https://help.genesys.cloud/articles/activate-and-configure-the-genesys-tts-connector-integration/)
- [Configure a third-party TTS provider](https://help.genesys.cloud/articles/configure-and-activate-a-third-party-tts-provider-integration/)
- [Telnyx REST TTS audio formats](https://developers.telnyx.com/docs/voice/tts/rest-api/parameters/audio-formats)

## Genesys permissions

The installer OAuth client needs the permissions required to view, add, and edit
integrations in the target division. Destroy operations additionally require
integration delete permission. Optional removal of credentials and Architect
test flows requires the corresponding credential and Architect permissions.

Use a dedicated least-privilege role. Web Admin validates `GC_ENVIRONMENT`
against the regions supported by the installed Genesys SDK before sending OAuth
credentials. It also disables inherited SDK gateways and request-body logging
before authentication.

## Environment

Use `genesys:deploy` to store real values in encrypted PostgreSQL storage.
For local development, the ignored `.env` file can still be initialized with:

```bash
cp .env.example .env
chmod 600 .env
```

Minimum configuration:

```env
GC_ENVIRONMENT=euw2.pure.cloud
GC_CLIENT_CRED_CLIENT_ID=
GC_CLIENT_CRED_CLIENT_SECRET=
TELNYX_API_KEY=
```

When values are missing, bootstrap collects and saves them securely. Web Admin
actively verifies the Genesys Client Credentials
grant and organization read first, then calls the Telnyx account and TTS REST
endpoints directly with `TELNYX_API_KEY`. A failed check offers an explicit
edit-and-retry action and does not open the main menu. The installer only
overwrites an existing credential after that retry action.

Web Admin lets you select an existing eligible Genesys credential or create one
from `TELNYX_API_KEY`. Internal plan and run state is stored in `.genesys-tts/`
by default. Secrets are never accepted through browser URLs or plan files.

When the installer creates a credential, it uses the Genesys `User Defined`
credential type with these HTTP fields:

```text
Authorization: Bearer <TELNYX_API_KEY>
Accept-Encoding: identity
```

Genesys does not return stored credential values. The installer therefore does
not compare or update a secret in place. Creating a replacement credential is
an explicit plan operation.

## Web Admin installation

The startup flow first verifies Genesys authentication and organization access,
then verifies the Telnyx account and Text-to-Speech API. Component checks for
Node.js, required libraries, AppFoundry installation, and current connector
usage run only after both platform checks pass.

The shared organization workflow is:

1. Select one or more supported provider profiles.
2. Select an existing Genesys credential or request a new one.
3. Review the generated `CREATE`, `UPDATE`, `NOOP`, `CONFLICT`, or `BLOCKED`
   operations.
4. Confirm the plan.
5. Optionally publish Architect listening-test flows after successful apply.

Web Admin re-reads the live organization immediately before the first mutation.
Changes to the organization, connector inventory, configuration version,
credential, profile definition, or plan intent stop the apply operation.
Removing a connector or test flow has organization-wide impact and is shown as
a shared-resource operation during plan review.

## Plan and apply lifecycle

Web Admin builds a read-only plan, displays it for approval, and applies the
accepted plan through the internal manager API. Plans expire after 60 minutes
and must not be edited manually.

## Adoption

The installer never adopts an integration based only on its name. Adoption
requires an immutable Genesys integration ID and an exact configuration match:

An integration with a different payload, connector type, ownership marker, or
profile marker is reported as a conflict.

## Plans, journals, and rollback

Plans and run journals are written under:

```text
.genesys-tts/plans/<plan-id>.json
.genesys-tts/runs/<run-id>.json
.genesys-tts/destroy-runs/<run-id>.json
```

The directory is ignored by Git. Files are created with restrictive local
permissions and recursively redact authorization values. Existing inline
fields that look like secrets block an update because a redacted snapshot could
not restore them safely.

The internal rollback engine validates organization identity and drift before restoring a previous
configuration. Newly created connectors are returned to their initial disabled
state instead of being deleted automatically. Credentials are not deleted by
rollback.

After a process interruption, inspect `status` and the journal before retrying.
The recovery option is limited to an incomplete operation already recorded in
the selected journal; it is not a general force flag.

## Destroy workflow

Destroy is available only from Web Admin. Before deleting anything,
the installer revalidates connector type, Telnyx endpoints, immutable IDs,
configuration snapshots, ownership markers, Architect test-flow ownership, and
credential references.

Connector deletion, owned test-flow deletion, and orphaned credential deletion
use separate confirmations. The default for credential deletion is `No`.
Deleting a connector cannot be automatically rolled back, so confirm that no
other Architect flow references its engine.

## Listening tests

Connector state and configuration hashes do not prove audio quality. Web Admin
can publish a dedicated inbound call flow named:

```text
Telnyx TTS - <provider or model> - Test Flow
```

The flow requires a voice whose model and locale exactly match the profile. For
example, the Telnyx NaturalHD profile first filters the provider-wide API
catalog by `model_id=NaturalHD`, then selects an `en-US` voice. Voices from
other Telnyx models and language-only matches such as `en-IN` or `en-GB` are
deliberately rejected. This avoids testing the wrong model and prevents an
Architect locale warning. If no exact model-and-locale match is available, the
Web Admin skips that provider's test flow and reports the reason. It does not create
or change a DID or call route. Follow the Genesys procedure to call and evaluate
the flow manually:

- [Test third-party TTS engine playback](https://help.genesys.cloud/articles/test-your-third-party-tts-engine-playback/)

The web administration interface also exposes a `Play` action next to every
active managed connector that has a matching test flow. The action starts a
real Genesys call for the signed-in administrator without opening the dial pad.
It requires an active Genesys phone or WebRTC station, the
`Conversation > Call > Add` permission, and the `conversations` OAuth scope.
Rerun `genesys:deploy` after upgrading an existing installation so that the
Code Authorization client receives the additional scope, then sign in again.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Noise or clicks | Compressed audio, a container header, or JSON interpreted as PCM |
| One click before speech | A WAV header interpreted as audio samples |
| Wrong speed or pitch | Sample-rate mismatch |
| Silence | Empty payload, authentication failure, unavailable voice, or Genesys cache |
| Voice missing in Architect | Inactive connector, stale cache, or missing language metadata |

The direct connector contract requires `binary_output`. Provider formats and
sample rates must match the profile definition; output-format mapping is not a
general-purpose resampler.

## Tests

Run the installer tests without making live API changes:

```bash
node --test tests/genesys-telnyx-tts-manager.test.mjs
```

The suite covers profile contracts, endpoint and region allowlists, secret
redaction, planning, drift detection, adoption, rollback, pagination, and
Architect flow safety.
