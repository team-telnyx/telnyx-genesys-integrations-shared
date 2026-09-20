# Telnyx integrations for Genesys Cloud

<!-- app-version:start -->
[![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-00C389)](https://github.com/team-telnyx/telnyx-genesys-integrations/releases)
<!-- app-version:end -->

A Next.js application and administration toolkit for connecting Telnyx services
to Genesys Cloud. The repository contains independent modules for SMS and MMS,
Number Lookup campaigns, Telnyx text-to-speech providers, and Telnyx AI
Assistants over Genesys Audio Connector.

## Features

- Two-way SMS and MMS through Genesys Cloud Open Messaging.
- Agentless and campaign messaging with Genesys contact-list status updates.
- Single-number and contact-list Number Lookup workflows.
- Interactive installation of Telnyx-backed Genesys TTS Connectors.
- Genesys Audio Connector WebSocket runtime for Telnyx AI Assistants.
- Queue-restricted AI-to-agent handoff with a generated Architect flow.
- Genesys interaction widget with conversation context and transcript data.
- Genesys OAuth authentication for application pages and API routes.

The SMS, Number Lookup, TTS, and Audio Connector modules use separate routes and
installer entry points. Running a Genesys installer does not modify the SMS or
Number Lookup configuration.

## Technology

- Next.js 16 and React 19
- Tailwind CSS 4 and Radix UI
- Telnyx Node.js SDK 7
- Genesys Cloud Platform API SDK
- Genesys Cloud Architect scripting SDK
- Yarn 4

## Prerequisites

- Node.js 20 or newer.
- Yarn through Corepack.
- A Telnyx account and API key.
- A Genesys Cloud organization and the OAuth clients required by the enabled
  modules.
- A public HTTPS origin for webhooks used outside local development.
- A public WSS endpoint when using Audio Connector.

The TTS and Audio integrations are independent. Each connector type must be
enabled for the organization in AppFoundry, including acceptance of any
applicable terms, but the installers can create the first TTS or Audio
Connector instance after that enablement.

## Quick start

After cloning the repository and installing dependencies, choose a deployment
target (local, AWS, Azure or Google Cloud):

```bash
npm run deploy
```

Choose `local` for Docker Compose. The local command generates the bundled
PostgreSQL connection and encryption key,
starts Docker Compose, and runs the interactive Genesys/Telnyx bootstrap. It
does not require the user to enter database credentials. After it completes,
open **Apps > Telnyx Integrations** in Genesys Cloud and finish the first Audio,
TTS, or Widget deployment in the web console.

Cloud targets use Terraform and your own cloud account. Start with
`./deploy/deploy up --target aws`, `--target azure` or `--target gcp`.
See [deployment targets and lifecycle](deploy/README.md) for configuration,
prerequisites, DNS/TLS, updates and teardown.

For application development, install dependencies and create a local
environment file:

```bash
corepack enable
yarn install --immutable
cp .env.example .env
```

Configure PostgreSQL, then run `npm run genesys:deploy`. The bootstrap generates
the encryption key and collects platform credentials without leaving them in
plaintext. Never commit `.env` files or credentials, and back up the encryption
key in the deployment platform's secret manager.

Start the application:

```bash
yarn dev
```

Open [http://localhost:3000](http://localhost:3000). Useful local pages include:

- `/sms` — individual SMS messages;
- `/sms-campaign` — SMS campaigns using Genesys contact lists;
- `/number-lookup` — individual Number Lookup requests;
- `/number-lookup-campaign` — contact-list Number Lookup;
- `/genesys-notifications` — Genesys notification monitoring;
- `/test` — local integration test utilities;
- `/docs` — application API examples.

Before production use, build and run the production server:

```bash
yarn build
yarn start
```

## Environment configuration

`.env.example` contains only the application bootstrap and optional non-secret
runtime tuning. A normal installation keeps only the PostgreSQL connection and
`ADMIN_SECRETS_MASTER_KEY` in `.env`. Genesys, Telnyx, OAuth, AudioHook, Open
Messaging, widget-session, and handoff credentials are encrypted in PostgreSQL
with AES-256-GCM and authenticated additional data.

### Telnyx core and messaging

`TELNYX_API_KEY` is collected by `genesys:deploy` and stored in the encrypted
store. Non-secret messaging profile, sender, and caller-number selections are
stored as runtime or component configuration.

| Variable | Used by | Where the value comes from |
|---|---|---|
| `TELNYX_API_KEY` | SMS, Number Lookup, TTS, Audio | Create an API key in the Telnyx Mission Control Portal. Store the complete key immediately because it is a secret. |
| `TELNYX_MESSAGING_PROFILE_ID` | SMS | Copy the ID of the Messaging Profile that will send and receive messages. |
| `TELNYX_FROM_NUMBER` | SMS | Use a messaging-enabled Telnyx number assigned to that profile, in E.164 format such as `+15551234567`. |
| `TELNYX_WIDGET_CALLER_NUMBER` | Chat Widget WebRTC voice | The Widget wizard stores the selected E.164 number in its PostgreSQL component configuration. The AI Agent Library sends it as `callerNumber`; the managed SIP Transfer tool uses `from={{telnyx_end_user_target}}`. |

The TTS and Audio installers do not require a separate Telnyx API key. They use
the same `TELNYX_API_KEY` as the other Telnyx modules.

### Genesys Cloud

`GC_ENVIRONMENT`, both OAuth client identities, and both client secrets are
logical runtime settings loaded from the encrypted PostgreSQL store. They are
not plaintext `.env` entries after bootstrap.

SMS additionally requires:

```env
GC_MESSAGE_DEPLOYMENT_ID=
GC_SECRET_TOKEN=
```

`GC_CLIENT_ID` and `GC_CLIENT_SECRET` are used for browser-based Genesys OAuth.
The client-credentials pair is used by server routes and Web Admin.
Grant only the permissions required by the modules you enable.

The managed Code Authorization client uses a 24-hour access-token lifetime.
The application keeps its rotating refresh token in secure, HTTP-only,
partition-aware cookies and silently refreshes an expired access token once
before asking the user to sign in again.

| Variable | Used by | Where the value comes from |
|---|---|---|
| `GC_ENVIRONMENT` | All Genesys modules | Use the Genesys Cloud region domain from the organization login URL, without `https://`, for example `usw2.pure.cloud` or `mypurecloud.ie`. |
| `GC_CLIENT_ID` | Browser UI and interaction widget | Create a Genesys Cloud OAuth client with the Code Authorization grant and copy its client ID. Configure the application's OAuth callback URL on that client. |
| `GC_CLIENT_SECRET` | Browser UI and interaction widget | Copy the secret generated for the Code Authorization OAuth client. It is not interchangeable with the Client Credentials secret. |
| `GC_CLIENT_CRED_CLIENT_ID` | Server routes and Web Admin | Create a separate Genesys Cloud OAuth client with the Client Credentials grant and copy its client ID. Assign a least-privilege role containing the permissions required by the enabled modules. |
| `GC_CLIENT_CRED_CLIENT_SECRET` | Server routes and Web Admin | Copy the secret generated for the Client Credentials OAuth client. |
| `GC_MESSAGE_DEPLOYMENT_ID` | SMS | Copy the deployment ID from the Genesys Cloud Open Messaging integration used for Telnyx messages. |
| `GC_SECRET_TOKEN` | SMS | Generate this value locally and configure the exact same value as the secret token in the Genesys Open Messaging integration. |

Create the OAuth clients under **Admin > Integrations > OAuth** in Genesys
Cloud. OAuth client secrets are credentials, not values that should be invented
or shared between grant types.

Generate the SMS webhook secret locally:

```bash
openssl rand -hex 32
```

Import the result through the encrypted bootstrap migration and never commit it.

## SMS and MMS Open Messaging

### Inbound messages

Configure the Telnyx messaging profile webhook as:

```text
https://your-domain.example/api/genesys/sms/inbound
```

The route accepts Telnyx messaging events and forwards inbound messages to the
configured Genesys Open Messaging deployment.

### Outbound messages

Configure the Genesys Open Messaging outbound webhook as:

```text
https://your-domain.example/api/genesys/sms/outbound
```

Set the same webhook secret in Genesys Cloud and `GC_SECRET_TOKEN`. The route
verifies the Genesys signature before sending through Telnyx.

Campaign messages may use the tag format
`[recipient]|[listId]|[contactId]`. Delivery information is written to these
Genesys contact-list fields when present:

- `TELNYX_STATUS`
- `TELNYX_TIME`
- `TELNYX_PRICE`
- `TELNYX_MESSAGE_ID`
- `TELNYX_MESSAGE`

## Number Lookup

The Number Lookup pages use the same Telnyx API key and Genesys browser session
as the messaging UI. Optional prefixes in `.env` can restrict which Genesys
contact lists and response templates appear in the campaign interfaces:

```env
NEXT_PUBLIC_SMS_TEMPLATES_PREFIX=
NEXT_PUBLIC_NL_CONTACT_LISTS_PREFIX=
NEXT_PUBLIC_SMS_CONTACT_LISTS_PREFIX=
```

## Shared Genesys administration console

Run the minimal interactive bootstrap once before opening the administration
console from Genesys Cloud:

```bash
npm run genesys:deploy
```

The command explains where every required value is obtained, writes only the
PostgreSQL bootstrap and a generated 32-byte encryption key to the private
`.env` file, verifies PostgreSQL, Genesys Client Credentials, Telnyx
AI Assistant, and Telnyx TTS access, then creates or reconciles the shared
administrator role, mandatory `Telnyx Integrations Administrators` group and
selected members, OAuth callback, access-group grant, and Genesys Custom Client
Application. It does not create TTS, Audio Connector, or customer Widget
deployments. Existing managed credentials found in `.env` are migrated into the
encrypted table and removed from the file only after the encrypted transaction
succeeds.

Back up `ADMIN_SECRETS_MASTER_KEY` in the deployment platform's secret manager.
It is intentionally not stored in PostgreSQL; losing it makes the encrypted
values unrecoverable. At runtime the custom server loads the values before
OAuth, AudioHook, webhook, and Next.js request handling begin.

After bootstrap, open **Apps > Telnyx Integrations** in Genesys Cloud. The same
console is also available at `/genesys/admin` and the backwards-compatible
`/genesys/widget-admin` URL.

The console contains enabled/disabled component tiles and desired-state wizards
for TTS, Audio Connector, and Web Chat. A wizard performs live discovery and
uses the shared planner/apply engine. The review screen must be accepted before
changes run, and every run and step status is retained in PostgreSQL. Component
configuration is available only through Web Admin; the former component CLI
entrypoints have been removed.

The Genesys light/dark theme preference is stored per Genesys organization and
administrator user in PostgreSQL.

## Telnyx TTS Connector installer

Required logical credentials (stored encrypted after `genesys:deploy`):

```env
TELNYX_API_KEY=
GC_ENVIRONMENT=usw2.pure.cloud
GC_CLIENT_CRED_CLIENT_ID=
GC_CLIENT_CRED_CLIENT_SECRET=
```

Web Admin can create the required Genesys User Defined credential from
`TELNYX_API_KEY` or reuse an eligible existing credential. No additional
TTS-specific environment variable is required. Missing base configuration is
collected by `genesys:deploy`; Web Admin then performs a real OAuth client-credentials grant
and reads the Genesys organization. Invalid credentials return to an explicit
edit-and-retry choice. The next stage collects `TELNYX_API_KEY` and verifies it
directly against the Telnyx account and Text-to-Speech REST endpoints. The main
menu is shown only after both platforms are reachable. An existing but invalid
value is overwritten only after the operator selects the retry action.

The installer:

1. validates the Genesys region, OAuth configuration, and SDK security settings;
2. verifies that the Genesys TTS Connector type is enabled for the organization;
3. reads the organization-wide connector inventory and available capacity, including an empty inventory;
4. lets the operator select supported Telnyx TTS provider profiles;
5. creates a read-only, drift-protected plan that can include the first connector instance;
6. applies changes only after explicit confirmation;
7. records a redacted run journal and supports rollback;
8. can optionally publish isolated Architect flows for listening tests.

TTS connectors, their credential, and test flows are shared by every DEV/PROD
installation connected to the same Genesys organization. Web Admin uses live
Genesys inventory as the canonical state, labels these resources separately
from installation-managed resources, and rejects stale plans when another
installation changes the shared inventory.

Plan and journal files are stored under `.genesys-tts/`, which is ignored by
Git. Complete operational guidance is in
[`docs/GENESYS_TELNYX_TTS_CONNECTOR_INSTALLER.md`](docs/GENESYS_TELNYX_TTS_CONNECTOR_INSTALLER.md).

## Telnyx AI Assistant and Genesys Audio Connector

Configure the shared Genesys client-credentials variables plus these Audio
Connector values:

```env
GC_PUBLIC_BASE_URL=https://integrations.example.com
GC_AUDIO_CONNECTOR_API_KEY=
GC_AUDIO_CONNECTOR_CLIENT_SECRET=
GC_AUDIO_HANDOFF_API_KEY=
GENESYS_HANDOFF_API_KEY=
GC_AUDIO_CONNECTOR_DEBUG=false
```

| Variable | Where the value comes from | Purpose and format |
|---|---|---|
| `GC_PUBLIC_BASE_URL` | Set this to the public origin where this application is deployed. | It must contain only an HTTPS origin, for example `https://integrations.example.com`, with no path, query string, credentials, or fragment. The installer derives the Audio Connector WSS URI, widget URL, and handoff webhook URL from it. |
| `GC_AUDIO_CONNECTOR_API_KEY` | Generated automatically during bootstrap when missing. | Opaque API key used by Genesys AudioHook and the WebSocket runtime through the `x-api-key` header. It is not a Telnyx API key or a Genesys OAuth credential. |
| `GC_AUDIO_CONNECTOR_CLIENT_SECRET` | Generated automatically during bootstrap when missing. | Base64-encoded HMAC secret used to verify signed Genesys AudioHook connections. |
| `GC_AUDIO_HANDOFF_API_KEY` | Generated automatically during bootstrap when missing. | Expected value of the webhook's `telnyx-ai-api-key` HTTP header. It authenticates calls from the Telnyx assistant tool to `/api/genesys/handoff`; it is not the Telnyx account API key. |
| `GENESYS_HANDOFF_API_KEY` | Generated together with the legacy channel-specific key on new installs. | Preferred shared handoff secret used by both Audio Connector and Web Chat. Existing channel-specific keys remain accepted for migration compatibility. |
| `GC_AUDIO_CONNECTOR_DEBUG` | Optional; defaults to disabled. | Set to `true`, `1`, `yes`, or `on` to emit `[genesys-audio-connector]` lifecycle logs and bidirectional Genesys/Telnyx WebSocket control traffic. Audio frames and audio payload events are omitted. |

Genesys Audio Connector currently offers mono external PCMU at 8 kHz. The
bridge waits for the Telnyx realtime session to become ready before completing
the Genesys `open` transaction, converts PCMU to Telnyx PCM16, and converts
assistant PCM16 back to PCMU. Incoming AudioHook messages may contain any
number of complete PCMU samples; the bridge does not assume a fixed WebSocket
frame size.

Genesys can replay buffered audio faster than realtime after `opened`. The
bridge therefore uses a bounded adaptive input pacer: normal traffic stays at
realtime speed, while a queue above 100 ms drains at up to 4x speed without an
unbounded burst. The queue retains up to 30 seconds of PCM16 by default. These
advanced limits can be changed with `GC_AUDIO_CONNECTOR_INPUT_CATCHUP_RATE`
(1-8), `GC_AUDIO_CONNECTOR_INPUT_CATCHUP_TARGET_MS` (20-1000), and
`GC_AUDIO_CONNECTOR_INPUT_BUFFER_MS` (1000-60000). They are optional and should
normally be left unset.

When Web Admin finds one or more missing Audio secrets, the bootstrap and
configuration workflow can generate them using Node.js cryptographic randomness. After confirmation it:

1. generates only the missing values;
2. encrypts them with AES-256-GCM and writes them transactionally to PostgreSQL;
3. leaves no plaintext secret in `.env`;
4. loads the generated values into the current process;
5. reruns startup checks and continues without a manual restart.

The installer refuses to overwrite a non-empty value, update duplicate entries,
or replace an existing value without an explicit retry. Replacement is allowed only after the
operator explicitly chooses to retry rejected Genesys or Telnyx credentials, or
when rotating a previous installer-managed `trycloudflare.com` URL. It reports
only variable names and never prints secret values.

During preflight, the installer loads Genesys queues for the assistant handoff
allowlist and Genesys groups for interaction-widget access. Both are explicit
multi-select choices. No queue or group name is hardcoded.

After secret generation, Web Admin performs ordered platform checks:

1. collect missing Genesys values, perform a real Client Credentials OAuth
   grant, and read the organization;
2. collect `TELNYX_API_KEY`, then verify the account and AI Assistants REST API
   directly with Bearer authentication;
3. configure `GC_PUBLIC_BASE_URL` only after both platform checks pass.

Rejected credentials return to a masked edit-and-retry prompt. The Genesys Code
Authorization client is used by the browser widget and cannot be exercised by
the non-interactive preflight; its OAuth flow is validated when the widget signs
in. The server-side Client Credentials pair is always actively verified.

After preflight, the Audio Connector section in Web Admin provides:

- **Manage an Audio Connector deployment** — select an installer-managed
  deployment and review its complete local configuration plus live Genesys and
  Telnyx status, modify its handoff queues, widget groups, or three Architect
  DNIS cases, reapply the current configuration, synchronize the public URL, or
  destroy it;
- **Create a new Audio Connector deployment** — run the queue, group,
  application-name, DNIS, preview, and confirmed-apply workflow. This option is
  disabled when all five Genesys Audio Connector slots are occupied, while
  review and destroy remain available;
- **Manage Cloudflare Quick Tunnel** — display descriptive process and health
  status and expose one state-aware lifecycle action. A healthy tunnel can be
  stopped and deactivated; a missing or unreachable tunnel can be created or
  replaced. The same menu can switch between a stable HTTPS origin and Quick
  Tunnel mode and synchronize the current URL to every managed deployment;
- **Refresh Genesys and deployment inventory** and **Quit**.

Every managed deployment has one six-character ID and one shared display name,
for example `Customer Assistant (A1B2C3)`, across its Telnyx assistant, webhook
tool, Genesys Audio Connector, widget, Architect flow, and handoff script. Names
cannot be changed in place; create a new deployment when a different name is
required. Before any update or destroy operation, the manager verifies each
resource's immutable ID, exact name, and resource type against its manifest.
Name or ownership drift blocks the operation before any remote mutation.

Active manifests are private files under `.genesys-audio/deployments/`. Update
and destroy operations create private journals under `.genesys-audio/runs/` and
`.genesys-audio/destroy-runs/`. A successful destroy archives the manifest under
`.genesys-audio/destroyed/`. It deletes the dedicated Audio Connector credential,
connector, widget, Architect flow, Telnyx assistant, and Telnyx webhook tool. It
retains the shared Genesys OAuth client and Telnyx Integration Secret. Genesys
Cloud currently exposes read, upload, and publish APIs for scripts but no script
delete API, so the deployment-named handoff script is reported and retained for
manual administration.

When `GC_PUBLIC_BASE_URL` is missing, choose one of these options:

- **Start a managed Cloudflare Quick Tunnel (demo)** — temporarily starts the
  unified local server when necessary, launches `cloudflared`, waits for local
  and public `/api/health`, stops only the temporary application server, and
  saves the generated HTTPS origin. Startup progress is reported per stage; if
  the first temporary endpoint never becomes healthy, the installer
  automatically requests one replacement Quick Tunnel URL;
- **Enter an existing public HTTPS origin** — uses a stable deployment or named
  tunnel URL;
- **Exit without changing configuration** — makes no remote changes.

For other missing values, choose either:

- **Enter missing values now and save them securely** — Web Admin prompts for
  every missing value, masks secrets, validates the Genesys region and public
  HTTPS origin, encrypts managed values in PostgreSQL, and reruns startup checks;
- **Exit and run `genesys:deploy`** — Web Admin lists the missing values and
  exits without making remote changes.

For manual or non-interactive configuration, generate equivalent values with:

```bash
openssl rand -hex 32       # GC_AUDIO_CONNECTOR_API_KEY
openssl rand -base64 32    # GC_AUDIO_CONNECTOR_CLIENT_SECRET
openssl rand -hex 32       # GC_AUDIO_HANDOFF_API_KEY
```

Prefer `genesys:deploy`, which generates and stores these values without a
plaintext intermediate file. Do not reuse one value for multiple purposes.
During the confirmed apply phase, Web Admin writes
the AudioHook API key and HMAC secret into a newly created, deployment-specific
Genesys Audio Connector
credential. It also stores the handoff secret in Telnyx as an Integration
Secret and references it from the generated webhook tool. The secret values are
not written to plan or run-journal files.

For the handoff tool, `telnyx-ai-api-key` is the fixed HTTP header name. Its
preferred value is `GENESYS_HANDOFF_API_KEY`; the legacy Audio and Widget keys
remain accepted during migration. The installer automatically creates or
reuses a Telnyx bearer Integration Secret with a managed identifier in the form
`telnyx-genesys-handoff-<fingerprint>` and configures the webhook header value
as a Telnyx Integration Secret reference. Do not manually create a secret named
`telnyx-ai-api-key`; that string identifies the HTTP header, not the Telnyx
secret. The application validates the received header against every configured
shared or legacy handoff key.

### Cloudflare Quick Tunnel demo

Quick Tunnel mode requires the `cloudflared` executable. On macOS install it
with `brew install cloudflared`; see the
[official Cloudflare downloads](https://developers.cloudflare.com/tunnel/downloads/)
for Linux and Windows.

The Public URL workflow in Web Admin is the supported entry point. A generated
`trycloudflare.com` URL is written to the encrypted store before the plan is
created, so confirmed apply configures the same URL in the Genesys Audio
Connector, interaction widget, Telnyx handoff webhook tool, and Code
Authorization OAuth callback allowlist.

Tunnel management is available through Web Admin. Starting a tunnel reuses an
existing managed tunnel only when its process, local health,
and public health are all valid. An unreachable or expired public URL is
stopped and replaced automatically. When no healthy server is present,
it temporarily starts the local development server on `PORT` (default `3000`)
to validate the tunnel and then stops that server. The command stores the
Cloudflare PID, URL, and log paths under `.genesys-audio/tunnel/`. `stop`
validates process identities before terminating `cloudflared`, never stops a
manually started application server, and clears `GC_PUBLIC_BASE_URL` only when
it still equals the managed Quick Tunnel URL.

The interactive **Manage Cloudflare Quick Tunnel** menu requires confirmation
before replacing a configured stable origin. It writes the new Quick Tunnel
URL and synchronizes Genesys and Telnyx only after the replacement passes its
public health check.

The installer and tunnel manager intentionally do not leave the application
runtime running in the background. After configuration, start it in a visible
terminal:

```bash
# Development
npm run dev

# Production
npm run build
npm run start
```

Both commands run the unified Next.js HTTP and AudioHook WebSocket server on
`PORT` (default `3000`). Stop it with `Ctrl+C`; its logs remain in that terminal.
At startup the server prints its local URL and the configured public URL. It
labels the public route as either a **static HTTPS origin** or a **Cloudflare
Quick Tunnel**, then performs a bounded public `/api/health` check and reports
whether that route is currently available.

When a new temporary hostname is assigned, `start` automatically synchronizes
every deployment manifest under `.genesys-audio/deployments/`. It updates the
Telnyx webhook tool, Genesys Audio Connector Base URI, interaction-widget URL
and icons, and the OAuth callback URI. Stale `trycloudflare.com` callback URIs
are removed while stable and localhost callbacks are preserved.

Quick Tunnels are temporary demo endpoints: their random URL changes after a
restart, they have no uptime guarantee, and Cloudflare currently limits them to
200 in-flight requests and does not support SSE. WebSockets are supported. If
the URL changes, the tunnel manager updates installer-managed deployments
automatically. For production,
use a stable named tunnel or another stable HTTPS/WSS deployment. See
[Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

The complete logical configuration for the Audio installer is shown below.
These names are records in the encrypted store, not required plaintext `.env`
entries. The three Audio secrets may be omitted before initial bootstrap
because the application can generate them:

```env
TELNYX_API_KEY=
GC_ENVIRONMENT=usw2.pure.cloud
GC_CLIENT_ID=
GC_CLIENT_SECRET=
GC_CLIENT_CRED_CLIENT_ID=
GC_CLIENT_CRED_CLIENT_SECRET=
GC_PUBLIC_BASE_URL=https://integrations.example.com
GC_AUDIO_CONNECTOR_API_KEY=
GC_AUDIO_CONNECTOR_CLIENT_SECRET=
GC_AUDIO_HANDOFF_API_KEY=
GC_AUDIO_CONNECTOR_DEBUG=false
```

No existing Telnyx assistant is required. The installer asks once for an Audio
deployment application name and appends a random six-character deployment ID,
for example `Telnyx Audio Connector (A1B2C3)`. That exact name is used for the
Telnyx assistant, Genesys Audio Connector, interaction widget, handoff script,
and Architect flow, making their ownership visible across both platforms.
The generated assistant is a Telnyx product and services specialist. Its
default greeting explicitly offers help with Telnyx products, while its
instructions cover the communications platform, Voice API and Call Control,
SIP Trunking, WebRTC, numbers, messaging, Verify, Fax, IoT, networking, and AI
Assistants. The selected Genesys queues and deployment-specific handoff tool
are added to this product-focused template. Every realtime conversation also
receives its Genesys caller context before the assistant starts speaking.
Each managed assistant also receives its own deployment-scoped Telnyx Hangup
tool. The instructions require a brief farewell followed by Hangup when the
caller asks to disconnect or when the conversation has clearly ended. Hangup
is explicitly excluded from the human-handoff path, which remains controlled
by the Audio Connector bridge.
The installer always creates its own Audio Connector and never selects or
reconfigures an unrelated existing instance. It validates the Genesys limit of
five Audio Connector instances before apply.

### Per-conversation dynamic variables

Immediately after the Telnyx Assistant WebSocket opens, the bridge sends a
`session.update` frame as the first client frame. Caller audio remains buffered
until Telnyx returns `session.created`. The frame automatically contains every
available value from this allowlist:

- `genesys_audiohook_session_id`
- `genesys_organization_id`
- `genesys_conversation_id`
- `genesys_participant_id`
- `genesys_ani`
- `telnyx_end_user_target` (mapped from Genesys ANI)
- `genesys_ani_name`
- `genesys_dnis`
- `telnyx_agent_target` (mapped from Genesys DNIS)
- `genesys_language`

Genesys may format ANI and DNIS as telephone URIs such as
`tel:+15551234567`. The bridge removes the leading `tel:` (case-insensitive)
before assigning `genesys_ani`, `genesys_dnis`, `telnyx_end_user_target`, and
`telnyx_agent_target`. Telnyx itself owns the reserved
`telnyx_conversation_channel` system variable and sets it to `websocket_call`
for this WebSocket Audio Connector path; the bridge does not override it and
treats that channel as voice for handoff.

The managed assistant defines every Genesys-provided dynamic variable with an
empty default. This makes a missing `session.update` value visible instead of
silently substituting test data. Its runtime instructions may use the caller
number, display name, called number, language, `first_name`, and `last_name`
only when they are non-empty. The generated Architect flow still sends the
literal `John`/`Wick` examples at runtime. The assistant is also instructed not
to disclose internal Genesys identifiers.

Architect flows can pass additional string values through the **Inputs** list
of the Call Audio Connector action. Prefix the input name with `telnyxVar_`;
the bridge removes that prefix before sending the dynamic variable. For
example:

| Architect input name | Telnyx dynamic variable |
|---|---|
| `telnyxVar_customer_name` | `customer_name` |
| `telnyxVar_account_id` | `account_id` |
| `telnyxVar_account_tier` | `account_tier` |
| `telnyxVar_preferred_language` | `preferred_language` |

Every managed Audio Connector flow includes two literal examples in the
Call Audio Connector action: `telnyxVar_first_name="John"` and
`telnyxVar_last_name="Wick"`. Telnyx receives them as `first_name` and
`last_name`. Open the reusable Audio Connector task in Architect to edit or
remove the examples, or replace the literals with flow, task, participant, or
data-action expressions.

Only explicitly prefixed inputs are forwarded; `assistantId` and all other
AudioHook inputs are excluded. Names after the prefix must use lower-case
`snake_case`, values must be strings, and the reserved `telnyx_` namespace is
rejected for Architect inputs. The bridge itself sets only the two verified
system targets listed above. It also limits the number and encoded size of variables and
logs variable names without logging their values. Do not pass credentials,
authentication tokens, payment data, or other secrets. Dynamic variables may
be retained in Telnyx conversation data or appear in assistant and tool logs.

The generated flow does not invent CRM-specific expressions. Add optional
`telnyxVar_*` mappings in Architect after installation when the corresponding
flow or data-action values exist. Reapplying the installer-managed Architect
flow regenerates its definition, so custom mappings must then be restored.
`session.update` is initialization-only: values cannot be changed after
`session.created` without starting a new assistant conversation.

The interaction widget provides five tabs: Conversation, Insights, Metadata,
Dynamic Variables, and Costs. The server authorizes the assigned Genesys agent,
reads the Telnyx conversation directly from the Telnyx REST API, and performs a
short sequence of background refreshes after handoff so asynchronously created
transcript, insight, webhook-log, and session-cost data appears without a
PostgreSQL or SSE dependency. The configured `GC_PUBLIC_BASE_URL` hostname is
added as an exact Next.js development origin so client assets can load through
the active Quick Tunnel without enabling a global `*.trycloudflare.com`
wildcard.

The widget reuses the demo portal's conversation components and presentation:
role-colored chat bubbles, the summary with intent and sentiment badges,
ordered insight cards, human-readable metadata, dynamic-variable webhook data,
and the detailed session-cost chart and component breakdown. It deliberately
keeps this repository's stateless REST loading and short background refresh
sequence instead of introducing a database dependency. The Genesys widget
route also uses the demo portal's theme controller and always forces light mode,
independently of the application, operating-system, or Genesys theme.

Use the Audio Connector section in Web Admin. It retrieves all Genesys queues
and presents a multi-select control.
The exact selected queue names are written to both the assistant instructions
and the handoff webhook tool's `queue_name` enum. Queue IDs and names are
validated again immediately before changes are applied.

The handoff tool is deployment-scoped too. Its Telnyx function name is
`request_genesys_human_handoff_<deployment-id>` (for example,
`request_genesys_human_handoff_a1b2c3`), and the assistant instructions refer
to that exact function. Tools belonging to different Audio Connector
deployments therefore do not share the same function name.

The generated inbound Architect flow uses the deployment name and switches on
`Call.CalledAddressOriginal`. Before the plan is created, the installer asks
whether to configure up to three inbound phone numbers. Choosing **No** keeps
these non-production DNIS placeholders:

- `+15550001001`
- `+15550001002`
- `+15550001003`

Choosing **Yes** opens three E.164-validated fields prefilled with those values.
Change only the required cases; pressing Enter leaves a case unchanged. A user
can therefore provide one real number while retaining the other two safe
placeholders. Duplicate numbers are rejected. Every branch uses the same
assistant created during installation. The default branch records an
unconfigured-DNIS error and disconnects.

The installer configures only the Switch cases; it does not assign DIDs or
create call routes. After installation, replace any remaining placeholders,
validate and republish the flow if it was edited, and configure the required
Genesys number assignments and call routes separately.

The main application server handles both regular Next.js HTTP traffic and the
AudioHook WebSocket on port `3000`. No separate bridge process or local reverse
proxy is required. Start both protocols with `npm run dev` or, after a build,
`npm run start`. Expose that single port through the public origin configured in
`GC_PUBLIC_BASE_URL`. Complete configuration and runtime guidance is in
[`docs/GENESYS_TELNYX_AUDIO_CONNECTOR.md`](docs/GENESYS_TELNYX_AUDIO_CONNECTOR.md).

## Main API routes

| Route | Purpose |
|---|---|
| `POST /api/genesys/sms/inbound` | Telnyx inbound messaging webhook |
| `POST /api/genesys/sms/outbound` | Genesys outbound messaging webhook |
| `POST /api/genesys/sms/agentless` | Genesys agentless message request |
| `POST /api/sms/send` | Send an SMS from the application UI |
| `GET /api/sms/status` | Retrieve Telnyx message status |
| `POST /api/number-lookup` | Telnyx Number Lookup request |
| `POST /api/genesys/handoff` | Authenticated AI handoff webhook |
| `GET /api/genesys/ai-conversation-widget` | Authorized widget data |
| `WS /api/genesys/audio-connector/ws` | Authenticated Genesys AudioHook stream |
| `GET /api/health` | Application health check |

## Development and validation

```bash
yarn test
yarn lint
yarn build
```

The installer test suite uses mocks and does not create Telnyx or Genesys
resources. Live installer commands display a plan and require explicit
confirmation before mutations.

## Repository safety

- Keep credentials only in ignored environment files or a secret manager.
- Do not commit installer state directories, plans, or journals.
- Use example phone numbers and resource IDs in tests and documentation.
- Review the generated plan before applying changes to either platform.
- The installers do not automatically assign phone numbers, DIDs, or call routes.
