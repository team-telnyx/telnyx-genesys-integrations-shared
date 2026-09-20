# Telnyx AI Assistant with Genesys Audio Connector

This integration runs a Telnyx AI Assistant in a Genesys voice interaction and
returns control to Genesys Architect when the assistant requests a human
handoff.

## Components

The integration has three isolated layers:

1. Web Admin — plan-based Audio Connector configuration.
2. The port `3000` application server — Next.js HTTP and AudioHook WebSocket.
3. `/api/genesys/handoff` and `/genesys/ai-conversation-widget` — authenticated
   handoff and agent experience endpoints.

The installer does not read or modify SMS messaging profiles, Open Messaging
deployment IDs, Number Lookup routes, DIDs, or call routes.

## Prerequisites

- Node.js 20 or newer.
- Repository dependencies installed with Yarn.
- A Genesys OAuth Client Credentials client with the Integrations, Architect,
  Scripts, Groups, Queues, and Organization permissions required by the
  installer.
- A Genesys Code Authorization OAuth client for the interaction widget.
- Genesys Audio Connector enabled for the organization in AppFoundry, with any required terms accepted.
- A Telnyx API key with AI Assistant, Tool, and Integration Secret access.
- A public HTTPS application origin and a public WSS endpoint on port 443.

Web Admin cannot create the AppFoundry entitlement or accept commercial terms.
An empty Audio Connector inventory is valid after enablement: apply creates the
first deployment-owned instance. TTS Connector is an independent integration
and is not required by the Audio installer or runtime.

## Environment

See `.env.example` for the complete list. Audio uses the shared Genesys Client
Credentials OAuth configuration and four dedicated runtime values:

```env
GC_ENVIRONMENT=usw2.pure.cloud
GC_CLIENT_ID=
GC_CLIENT_SECRET=
GC_CLIENT_CRED_CLIENT_ID=
GC_CLIENT_CRED_CLIENT_SECRET=
GC_PUBLIC_BASE_URL=https://integrations.example.com
GC_AUDIO_CONNECTOR_API_KEY=
GC_AUDIO_CONNECTOR_CLIENT_SECRET=
GC_AUDIO_HANDOFF_API_KEY=
GENESYS_HANDOFF_API_KEY=
GC_AUDIO_CONNECTOR_DEBUG=false
TELNYX_API_KEY=
```

Set `GC_AUDIO_CONNECTOR_DEBUG=true` (also accepts `1`, `yes`, or `on`) to log
connector lifecycle events and WebSocket traffic in both directions. Every entry
uses the `[genesys-audio-connector]` prefix. Binary audio frames and JSON audio
payload events are omitted, leaving only lifecycle and control traffic.

Genesys Audio Connector currently negotiates mono external PCMU at 8 kHz. The
bridge converts it to the PCM16 format used by the Telnyx Assistant WebSocket
and converts assistant audio back to PCMU before returning it to Genesys.

The bridge establishes the Telnyx WebSocket and waits for `session.created`
before returning `opened` to Genesys. Genesys therefore starts sending media
only after the downstream assistant is ready. Binary AudioHook messages are
treated as headerless audio with a variable sample count and are packetized
internally rather than being assumed to contain a fixed 20 ms frame.

Audio replayed by Genesys during startup or reconnect can arrive faster than
realtime. A bounded pacer drains input at normal speed while the queue is at or
below 100 ms and at up to 4x speed above that threshold. This catches up without
an uncontrolled WebSocket burst. The default queue limit is 30 seconds. The
following optional advanced variables can tune this behavior:

| Variable | Default | Accepted range |
|---|---:|---:|
| `GC_AUDIO_CONNECTOR_INPUT_CATCHUP_RATE` | `4` | `1`-`8` |
| `GC_AUDIO_CONNECTOR_INPUT_CATCHUP_TARGET_MS` | `100` | `20`-`1000` ms |
| `GC_AUDIO_CONNECTOR_INPUT_BUFFER_MS` | `30000` | `1000`-`60000` ms |

Leave these variables unset unless runtime metrics show a persistent input
backlog. Debug close logs include startup duration, peak input queue duration,
catch-up frame count, discarded-media notifications, and dropped frame counts.

`GC_PUBLIC_BASE_URL` is the public HTTPS origin of this application. The
installer derives the Audio Connector Base URI as
`wss://<origin>/api/genesys/audio-connector/ws` and configures the widget and
handoff webhook from the same origin.

`GC_AUDIO_CONNECTOR_CLIENT_SECRET` is the base64 AudioHook HMAC secret.
The API key and HMAC secret are configured on the Genesys integration and used
by the WebSocket runtime to authenticate each connection.

`GENESYS_HANDOFF_API_KEY` is the preferred shared secret for assistant handoff
webhooks. New installer runs copy the generated legacy Audio handoff key into
this variable so the same tool can also serve widget messaging. Existing
`GC_AUDIO_HANDOFF_API_KEY` values remain accepted. The installer stores the
selected value as a Telnyx bearer Integration Secret using a deterministic,
non-secret identifier and references it from the generated webhook tool.

The three `GC_AUDIO_*` secret values may be left empty before initial bootstrap.
Web Admin detects missing values and, after confirmation, generates them with
Node.js cryptographic randomness, writes them
atomically to `.env`, sets the file mode to `0600`, reloads them into the
current process, and reruns startup checks. Existing non-empty secret values
are never overwritten. The public URL can only be replaced automatically when
its current value is another installer-managed `trycloudflare.com` URL. For
non-interactive use, populate all three secrets before running an apply command.

After secret generation, Web Admin handles configuration in ordered stages. It
first collects Genesys values, performs a real Client Credentials OAuth grant,
and reads the organization. It then collects `TELNYX_API_KEY` and verifies both
the Telnyx account and AI Assistants REST API directly. Rejected credentials
offer a masked edit-and-retry path; values are overwritten only after that
explicit choice. The Code Authorization client is exercised later by the
browser widget OAuth flow, while the server-side Client Credentials pair is
always actively checked. Only after both platform checks pass does
`GC_PUBLIC_BASE_URL` offer a validated existing origin or the managed demo
tunnel described below.

## Optional Cloudflare Quick Tunnel for demos

When `GC_PUBLIC_BASE_URL` is missing, Web Admin can create a
managed Cloudflare Quick Tunnel. This requires `cloudflared` on `PATH` but does
not require a Cloudflare account or API token. Installation packages are listed
in the [official Cloudflare downloads](https://developers.cloudflare.com/tunnel/downloads/).

The installer:

1. reuses a healthy server already listening on `PORT`, or temporarily starts
   the unified Next.js and AudioHook server in development mode;
2. runs `cloudflared tunnel --url http://127.0.0.1:<PORT>` as a detached managed
   process with automatic updates disabled for that process;
3. extracts and validates the generated `https://*.trycloudflare.com` origin;
4. waits for both local and public `/api/health` responses;
5. reports each startup stage and automatically requests one replacement URL
   when the first temporary public endpoint does not become healthy;
6. writes the URL to `GC_PUBLIC_BASE_URL` in `.env` with mode `0600`;
7. synchronizes existing managed deployment manifests with the new URL;
8. stops only the temporary application server after validation;
9. creates a new installation plan only after the tunnel is healthy.

The interactive **Manage Cloudflare Quick Tunnel** menu adapts to this state.
For a healthy tunnel it offers deactivation; for a missing, expired, or
unreachable tunnel it offers creation or replacement. A running
`cloudflared` process is not reusable unless both local and public health checks
pass. Switching from a stable `GC_PUBLIC_BASE_URL` to a Quick Tunnel requires
explicit confirmation, and managed Genesys and Telnyx URLs are synchronized
only after the replacement tunnel is healthy.

The subsequent confirmed installation apply therefore writes the same origin
to the Genesys Audio Connector Base URI, Genesys interaction widget URL, and
Telnyx webhook tool URL.

Tunnel lifecycle is managed through Web Admin. State and Cloudflare logs are
stored under `.genesys-audio/tunnel/` and are
excluded from Git. Stop validates the recorded Cloudflare process identity
before sending signals. It never stops a manually started application server
and clears `.env` only when its current URL exactly matches the stopped Quick
Tunnel.

The installer does not leave the application runtime running in the
background. After configuration, start the unified HTTP and AudioHook server in
a visible terminal with `npm run dev`, or run `npm run build` followed by
`npm run start`. Both commands use `PORT` (default `3000`); use `Ctrl+C` to stop
the server.

The startup log prints the local URL and, when configured, `GC_PUBLIC_BASE_URL`.
It identifies the public route as either a static HTTPS origin or a Cloudflare
Quick Tunnel and performs a bounded `/api/health` request so the terminal shows
whether public access is currently available.

Quick Tunnels are for testing and demos only. The hostname changes whenever a
new tunnel is created, there is no SLA, and Cloudflare documents a 200 in-flight
request limit and no SSE support. WebSocket traffic is supported. Rerun the
standalone tunnel command after a restart; it automatically updates the Telnyx webhook tool,
Genesys Audio Connector, widget URL and icons, and OAuth callback for every
manifest under `.genesys-audio/deployments/`. A default
Cloudflare `config.yml` or `config.yaml` may also prevent Quick Tunnel startup.
For production, use a stable named tunnel. See the
[Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Queue allowlist

At startup the installer loads all Genesys Cloud queues using paginated API
requests. The operator selects one or more queues from a checkbox menu.

The exact selected queue names are written to:

- the AI Assistant instructions;
- the `queue_name` enum of `request_genesys_human_handoff`;
- the Genesys interaction-widget queue filter;
- the local plan under `.genesys-audio/plans`.

Immediately before apply, the installer reloads the queues and requires every
selected ID and name to match the plan. Renaming or deleting a selected queue
stops the operation before changes are made.

## Realtime dynamic variables

For every AudioHook session, the bridge sends Telnyx `session.update` as the
first WebSocket frame, before caller audio and without waiting for
`session.created`. It supplies the available AudioHook session, Genesys
organization, conversation, participant, ANI, ANI display name, DNIS, and
language values under lower-case `genesys_*` dynamic-variable names. Audio is
already buffered during Telnyx initialization and is released only after
`session.created`, so the initialization frame does not change media ordering.
Genesys ANI is also mapped to the Telnyx system variable
`telnyx_end_user_target`, and Genesys DNIS to `telnyx_agent_target`. These two
production-verified mappings make caller and assistant targets available with
their standard Telnyx meanings during WebSocket conversations.

If Genesys supplies ANI or DNIS as a telephone URI, the bridge strips the
leading, case-insensitive `tel:` prefix before populating both the `genesys_*`
copies and the Telnyx target variables. Telnyx owns the reserved
`telnyx_conversation_channel` system variable and automatically reports
`websocket_call` for this WebSocket path. The bridge does not override that
system variable and treats it as voice when processing handoff.

The generated assistant defines this context with empty default values. Its
instructions may use caller-facing ANI, display-name, DNIS, language,
`first_name`, and `last_name` only when they are non-empty, and prohibit
speaking internal Genesys identifiers. The literal `first_name="John"` and
`last_name="Wick"` examples exist only in the generated Architect Inputs and
must arrive through WebSocket `session.update`; they are not assistant
fallbacks. This makes missing bridge data immediately visible.

Every managed assistant also has a uniquely named shared Telnyx Hangup tool.
The assistant must give a brief farewell and invoke Hangup when the caller asks
to disconnect or when the conversation has clearly concluded. It must not use
Hangup while a Genesys human handoff is pending or after the handoff webhook
succeeds, because the bridge owns that transition. The Hangup tool ID is stored
in the deployment manifest and participates in review, update, and destroy.

To pass additional Architect or CRM context, add string Inputs to the Call
Audio Connector action using the `telnyxVar_` prefix. For example,
`telnyxVar_customer_name` becomes `customer_name` and
`telnyxVar_account_tier` becomes `account_tier`. Inputs without that prefix,
including the required `assistantId`, are not forwarded. The suffix must be
lower-case `snake_case`; `telnyx_` is reserved and rejected. Object values,
oversized values, duplicate protected names, and oversized frames are rejected
before any audio is sent.

New managed flows include two visible literal examples in the Call Audio
Connector action: `telnyxVar_first_name="John"` and
`telnyxVar_last_name="Wick"`. They arrive in Telnyx as `first_name` and
`last_name`. In Architect, edit the action's **Inputs** collection to change or
remove them, or replace the literal strings with any valid Architect string
expression such as a Flow variable, participant data, or Data Action output.

Never pass API keys, OAuth tokens, passwords, payment data, or other secrets as
dynamic variables. Values can influence prompts and webhook tools and may
appear in conversation records or logs. The installer does not create
customer-specific CRM expressions. Add those mappings manually when their
Architect values exist, and restore them if a later installer reapply
regenerates the managed flow.

## Widget access groups

The installer also loads all Genesys Cloud groups and asks the operator to
select one or more groups whose members may access the interaction widget.
There is no assumed or hardcoded group name. Selected group IDs and names are
stored in the plan and revalidated immediately before apply.

## Installation

Install dependencies, run the minimal bootstrap, and open Web Admin:

```bash
yarn install --immutable
npm run genesys:deploy
```

Web Admin performs a read-only preflight, displays the target organization,
Audio Connector capacity, live queues, and live groups, and then opens its main
menu. Choose **Create a new Audio Connector deployment** to provide the queue
allowlist, widget access groups, one application name, and optional DNIS values
before writing a plan. It appends a random six-character deployment ID and uses
the resulting name for every managed object. No resource changes occur until
the operator explicitly confirms apply.

Apply creates or repairs:

- a dedicated Telnyx Integration Secret;
- a queue-restricted Telnyx webhook tool;
- a standalone sample Telnyx AI Assistant (no existing assistant is required);
- a Genesys script and interaction widget;
- a new dedicated Genesys Audio Connector configuration and credential;
- a published inbound Architect flow.

The installer never adopts an arbitrary installed connector. It requires the
Audio Connector AppFoundry entitlement, enforces the five-instance limit, and
creates or reuses only the exact deployment-specific name from its plan.

Plans, run journals, and URL-synchronization manifests are stored under
`.genesys-audio/`, which is ignored by Git. They contain resource IDs and
status but never credential values.

## Deployment management

Choose **Manage an Audio Connector deployment** from the main menu and select a
manifest-owned deployment. Its submenu supports:

- reviewing all saved queues, groups, DNIS cases, object IDs, public URL, and
  the live Genesys/Telnyx name, type, state, and endpoint configuration;
- modifying the queue allowlist, widget access groups, or Architect DNIS cases;
- reapplying the current configuration to reconcile all managed objects;
- synchronizing only that deployment to the current `GC_PUBLIC_BASE_URL`;
- destroying its dedicated remote resources.

Updates and URL synchronization first verify every recorded resource by
immutable ID, exact deployment name, and integration type. If an object is
missing or its ownership has drifted, the operation stops instead of adopting
or overwriting a same-name resource. Renaming a deployment in place is not
supported; create a new deployment when a different shared name is required.

Destroy requires both an explicit confirmation and retyping the six-character
deployment ID. It deletes the Architect flow, widget, Audio Connector,
deployment-specific AudioHook credential, Telnyx assistant, and Telnyx webhook
tool. The shared Genesys OAuth client and fingerprinted Telnyx Integration
Secret are retained. Genesys Cloud does not expose a script delete API, so the
deployment-named handoff script is reported and retained. A completed destroy
archives the active manifest under `.genesys-audio/destroyed/` and writes a
step-by-step journal under `.genesys-audio/destroy-runs/`; a partial failure
keeps the active manifest so the operation can be reviewed and retried safely.

The separate **Cloudflare tunnel and public URL** menu reports process and
health state in human-readable form. It can start or replace a Quick Tunnel,
accept a stable HTTPS origin, synchronize the current origin to every managed
deployment, stop the managed tunnel, or refresh status. It never leaves a
bootstrap application server running; start the runtime yourself with
`npm run dev` or `npm run build && npm run start`.

## Generated Architect flow

The flow uses the shared deployment name, for example
`Telnyx Audio Connector (A1B2C3)`. The name is stored in the plan and used for
both create and update. The
flow's starting task contains a Switch on `Call.CalledAddressOriginal` with
three case branches and a default/error branch.

Before creating the installation plan, Web Admin asks whether to configure up to
three inbound phone numbers. Declining keeps these non-production placeholders:

- `+15550001001`
- `+15550001002`
- `+15550001003`

Accepting the prompt shows three E.164-validated fields prefilled with the
placeholder values. Change only the required fields and press Enter to retain
any remaining placeholder. All three case values must be unique.

Each case stores the same assistant ID created by the installer, calls the
reusable Audio Connector task, and disconnects when the assistant task ends.
The default branch records `NoAssistantConfiguredForDnis` and disconnects.

The reusable task:

1. starts the selected assistant through Genesys Audio Connector;
2. receives handoff state, queue data, summary, intent, sentiment, and transcript;
3. resolves the validated Genesys queue by immutable ID;
4. presents the AI context to the assigned agent;
5. transfers the voice interaction to that queue.

The installer does not assign or reroute any phone number. After installation:

1. open the flow name selected during installation in Architect;
2. replace any remaining placeholder DNIS values with real inbound numbers;
3. validate the flow;
4. republish it;
5. configure the required Genesys call routes separately.

## Unified HTTP and WebSocket runtime

The repository uses a custom Node.js server so Next.js and Genesys AudioHook
share the same listener. Start development mode with:

```bash
npm run dev
```

For production, build and start the same unified server:

```bash
npm run build
npm run start
```

Both commands listen on port `3000` by default. `PORT` may override the local
port. Normal HTTP traffic is delegated to Next.js; only the exact AudioHook
upgrade path is handled by the WebSocket runtime:

```text
https://integrations.example.com/*
    -> http://127.0.0.1:3000/*

wss://integrations.example.com/api/genesys/audio-connector/ws
    -> http://127.0.0.1:3000/api/genesys/audio-connector/ws
```

Genesys appends the fixed Connector ID, `ws`, to the configured Base
Connection URI. The Base URI therefore normally ends at
`/api/genesys/audio-connector`.

The shared application exposes `GET /api/health`. AudioHook connections must
provide both the configured API key and a valid HMAC signature. The WebSocket
runtime validates protocol messages, supports the configured PCM codecs, paces
outbound audio, and handles barge-in and handoff completion.

If the Audio environment variables are incomplete, including the shared
Genesys Client Credentials values needed for handoff queue lookup, the Next.js application
still starts for SMS, Number Lookup, and TTS administration. Only AudioHook
upgrade requests receive `503 Service Unavailable`. Restart the server after
the Audio installer writes new values to `.env`.

This runtime requires a long-lived, self-hosted Node.js process. Do not deploy
it as a serverless function or use Next.js `output: "standalone"`, which is not
compatible with a custom server.

## Interaction widget

The widget uses the existing Genesys OAuth session. It returns data only for a
voice conversation assigned to the authenticated agent and only when its queue
is in the installer-managed allowlist.

During apply and every managed Quick Tunnel rotation, the installer adds the
current `${GC_PUBLIC_BASE_URL}/api/auth/callback` to the Code Authorization
client, removes stale Quick Tunnel callbacks, and preserves stable callbacks.
Both widget icon fields point to
`${GC_PUBLIC_BASE_URL}/telnyx_logo_black.png`.

The widget loads the current Telnyx conversation directly from the Telnyx REST
API and exposes five views: Conversation, Insights, Metadata, Dynamic
Variables, and Costs. It refreshes the data for a short period after the agent
receives the handoff so that transcript, insight, webhook-log, and session-cost
records created asynchronously become visible without a database or SSE
dependency.

Its UI is the same component implementation used by the demo portal: the
Conversation view renders role-colored message bubbles and tool calls, the
header renders the generated summary plus intent and sentiment badges, and the
remaining tabs use the same insight, metadata, dynamic-variable, and detailed
cost-breakdown views. The route-level Genesys theme controller always selects
light mode for this widget, regardless of the surrounding application, browser,
operating-system, or Genesys theme.

The hostname stored in `GC_PUBLIC_BASE_URL` is added as an exact Next.js
development origin. This allows the widget's client-side JavaScript chunks to
load through the temporary hostname without enabling a broad
`*.trycloudflare.com` wildcard.

The generated Genesys script can show:

- handoff reason;
- conversation summary;
- detected intent and sentiment;
- selected queue;
- Telnyx conversation ID;
- bounded speaker-labelled transcript.

## Operational safety

- Assistant and tool targets use stable exact names.
- Queue lookup rejects missing, renamed, or ambiguous queues.
- The handoff tool accepts only queue names selected during installation.
- AudioHook requires both API-key and HMAC authentication.
- Plans and journals redact credentials.
- The assistant is built from public, self-contained defaults and has no
  account-bound template dependency.
- The installer does not assign phone numbers, DIDs, or call routes.
- Existing SMS and Number Lookup modules remain isolated.

## Validation

Run the automated tests without live provisioning:

```bash
node --test tests/genesys-audio-installer.test.mjs
```

For a live installation, verify the application health endpoint, place a test
call through each configured DNIS branch, complete a normal assistant session,
and test a handoff to every allowed queue before routing production traffic.
