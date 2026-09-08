# Container deployment

The [shared deployment CLI](../deploy/README.md) supports local, AWS, Azure and
Google Cloud. The steps below describe the **local** target. Select it explicitly
with `npm run deploy -- --target local`, or choose `local` from the target menu.

The application image runs the custom `server.mjs`. On every start it connects to PostgreSQL, obtains the schema advisory lock, applies pending pg-ensure migrations and only then starts accepting HTTP traffic. A separate migration container is neither required nor recommended.

## Prerequisites

- Docker Engine with Docker Compose v2.
- Public HTTPS routing to container port 3000 for production webhooks and the embedded widget.
- A Genesys Cloud Client Credentials OAuth client, a Telnyx API key, and access to both accounts.

Do not bake `.env`, TLS private keys or provider credentials into the image. `.dockerignore` excludes them from the build context.

## Recommended first installation

Run one command from the repository root:

```bash
npm run deploy
```

The installer creates a private `.env` when it is missing, generates the
PostgreSQL password and 32-byte `ADMIN_SECRETS_MASTER_KEY`, starts the bundled
PostgreSQL and application containers, and then opens `genesys:deploy` inside a
one-off installer container. PostgreSQL is private to the Compose network and
uses a named persistent volume.

The interactive part asks only for:

- Genesys Cloud region selected from the official SDK region list;
- Genesys Client Credentials client ID and secret;
- Telnyx API key;
- the stable public HTTPS application origin;
- one or more Genesys users to add to the mandatory
  `Telnyx Integrations Administrators` group.

It validates both providers, creates or reconciles the group, administrator
role, Code Authorization OAuth client and `Telnyx Integrations` Custom Client
Application. Generated runtime secrets and all provider credentials are stored
encrypted in PostgreSQL. Only the database bootstrap and encryption master key
remain in `.env`. Back up that file or, preferably, its master key in the target
platform secret manager.

After `genesys:deploy` completes the application container is restarted so it
loads the newly encrypted runtime configuration. Open **Apps > Telnyx
Integrations** in Genesys Cloud and perform the first component deployment in
the web wizard.

To start the containers without changing Genesys objects:

```bash
npm run deploy -- --skip-genesys
```

Before changing the environment file or starting Docker, the command prints a
short summary and asks `Continue? [y/N]`. Answer `y` to proceed. Automated
deployments must make the same decision explicitly with `--yes`:

```bash
npm run deploy -- --yes
```

Running the recommended command again is idempotent: it retains the database
and installer state volumes, revalidates access, adds only missing group
members, and reconciles the shared Genesys objects.

## External managed PostgreSQL

Set `DATABASE_URL` and a verified TLS mode. For strict certificate and hostname validation:

```dotenv
DATABASE_URL=postgresql://user:password@eu-database.example:5432/telnyx_genesys
PGSSLMODE=verify-full
PGSSLROOTCERT=/run/secrets/provider-ca.pem
```

Mount the CA file through the target platform's secret mechanism, then run:

```bash
node scripts/deploy.mjs --mode external --env-file .env
```

In an interactive terminal, missing external connection details and TLS mode are
collected by the CLI and saved automatically; no env file needs to be prepared.
Unattended runs still require configured connection values.

The external mode does not activate the bundled PostgreSQL profile. The deploy script refuses remote PostgreSQL without TLS unless `--allow-insecure-db` is explicitly supplied.

## Other commands

```bash
# Validate inputs and show commands without changing Docker state
npm run deploy -- --mode bundled --env-file .env --dry-run

# Build only
npm run deploy -- --mode bundled --env-file .env --build-only

# Stop containers but preserve PostgreSQL data
npm run deploy -- --mode bundled --env-file .env --down

# Destructive: stop containers and delete all Compose volumes (database, installer state and assets)
npm run deploy -- --mode bundled --env-file .env --down --remove-volumes
```

The last command permanently deletes the bundled database, installer state and widget assets and must only be used when the stored widget configuration, audit trail and active session state are no longer needed or have been backed up.

## GDPR/EU checklist

Selecting voice media region `eu` and hosting the app/database in the EU are necessary deployment controls, but not a complete residency guarantee. Before production, verify and document EU processing/residency for:

- the chosen Telnyx AI Assistant LLM, transcription, TTS, media and observability settings;
- Telnyx Conversation retention and Assistant privacy settings;
- Genesys Cloud organization region, Open Messaging and SIP media;
- the application host, managed PostgreSQL, backups, logs and monitoring;
- every attachment URL or external tool invoked by the Assistant.

Use `PGSSLMODE=verify-full`, encrypted persistent volumes/backups, an EU-only log destination, short `WIDGET_HANDOFF_RETENTION_HOURS`, and a tested restore/deletion procedure. The application database intentionally contains no AI/voice transcript, audio, recording or attachment binary.

## Removing Genesys resources

Use **Settings → Danger Zone → Delete integration** while the application and
PostgreSQL are still available. The result lists each failed or retained resource
and its error. Retry failed resources after resolving provider dependencies.
Administration access is retained while other installation-managed resources
remain or a deletion/status update fails. External and shared organization resources do not block final
administration removal. Shared TTS connectors and test flows are preserved;
manage their lifecycle separately through TTS component settings. Manually managed deletion steps must be reconciled before
final cleanup.

The administration role, group, OAuth client and application are removed only in
the final stage, with the application last. This stage intentionally removes
console access; a failure during that final stage may require recovery using the
installer or Genesys Cloud administration. Delete the Azure infrastructure only
after completing the Genesys cleanup.
