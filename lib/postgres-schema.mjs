import { getPostgresPool } from "./postgres.mjs";

const SCHEMA_BASELINE_VERSION = 100;

const MIGRATIONS = [
  {
    version: SCHEMA_BASELINE_VERSION,
    name: "integration_schema_baseline",
    sql: `
      CREATE TABLE IF NOT EXISTS widgets (
        id UUID PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        genesys_organization_id TEXT,
        published_revision_id UUID,
        created_by_genesys_user_id TEXT,
        updated_by_genesys_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        managed_deployment_id TEXT,
        supported_content_profile_id TEXT,
        supported_content_profile_name TEXT,
        open_messaging_integration_id TEXT,
        base_open_messaging_integration_id TEXT,
        infrastructure_fingerprint TEXT,
        infrastructure_config JSONB,
        infrastructure_synced_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS widget_revisions (
        id UUID PRIMARY KEY,
        widget_id UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'archived')),
        config JSONB NOT NULL,
        created_by_genesys_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        UNIQUE (widget_id, version)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname='widgets_published_revision_fk'
        ) THEN
          ALTER TABLE widgets
            ADD CONSTRAINT widgets_published_revision_fk
            FOREIGN KEY (published_revision_id) REFERENCES widget_revisions(id)
            ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS widget_sessions (
        id UUID PRIMARY KEY,
        widget_id UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
        revision_id UUID NOT NULL REFERENCES widget_revisions(id),
        channel TEXT NOT NULL CHECK (channel IN ('messaging', 'voice')),
        telnyx_conversation_id TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        origin TEXT NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_token_hash TEXT,
        telnyx_call_id TEXT
      );

      CREATE TABLE IF NOT EXISTS genesys_widget_handoffs (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL UNIQUE REFERENCES widget_sessions(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('messaging', 'voice')),
        status TEXT NOT NULL DEFAULT 'reserved',
        genesys_integration_id TEXT,
        genesys_conversation_id TEXT UNIQUE,
        genesys_remote_address TEXT UNIQUE,
        queue_id TEXT,
        queue_name TEXT,
        reason TEXT,
        summary TEXT,
        error TEXT,
        claimed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        intent TEXT,
        sentiment TEXT,
        agent_name TEXT,
        agent_user_id TEXT,
        agent_image_uri TEXT
      );

      CREATE TABLE IF NOT EXISTS widget_webhook_events (
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (source, event_id)
      );

      CREATE TABLE IF NOT EXISTS widget_admin_audit_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        widget_id UUID REFERENCES widgets(id) ON DELETE SET NULL,
        genesys_organization_id TEXT,
        genesys_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS widget_handoff_messages (
        id UUID PRIMARY KEY,
        handoff_id UUID NOT NULL REFERENCES genesys_widget_handoffs(id) ON DELETE CASCADE,
        provider_message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        sender TEXT NOT NULL CHECK (sender IN ('customer', 'agent', 'system')),
        message_type TEXT NOT NULL DEFAULT 'Text',
        text TEXT,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        sender_name TEXT,
        sender_image_uri TEXT,
        UNIQUE (handoff_id, provider_message_id)
      );

      CREATE TABLE IF NOT EXISTS widget_voice_did_allocations (
        id UUID PRIMARY KEY,
        genesys_organization_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved', 'provisioning', 'active', 'failed', 'releasing')),
        genesys_trunk_id TEXT,
        genesys_did_pool_id TEXT,
        genesys_flow_id TEXT,
        genesys_ivr_id TEXT,
        genesys_sip_uri TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (genesys_organization_id, deployment_id),
        UNIQUE (genesys_organization_id, phone_number)
      );

      CREATE TABLE IF NOT EXISTS integration_user_preferences (
        genesys_organization_id TEXT NOT NULL,
        genesys_user_id TEXT NOT NULL,
        theme TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (genesys_organization_id, genesys_user_id)
      );

      CREATE TABLE IF NOT EXISTS integration_deployment_profiles (
        id UUID PRIMARY KEY,
        genesys_organization_id TEXT NOT NULL,
        component TEXT NOT NULL CHECK (component IN ('tts', 'audio', 'callbacks', 'widget')),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by_genesys_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (genesys_organization_id, component)
      );

      CREATE TABLE IF NOT EXISTS integration_deployment_runs (
        id UUID PRIMARY KEY,
        genesys_organization_id TEXT NOT NULL,
        component TEXT NOT NULL CHECK (component IN ('tts', 'audio', 'callbacks', 'widget', 'settings')),
        status TEXT NOT NULL CHECK (
          status IN ('planned', 'running', 'succeeded', 'failed', 'cancelled')
        ),
        config JSONB NOT NULL,
        plan JSONB NOT NULL,
        installer_plan_path TEXT,
        result JSONB,
        error TEXT,
        created_by_genesys_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS integration_deployment_steps (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES integration_deployment_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
        ),
        detail TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        UNIQUE (run_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS integration_runtime_secrets (
        name TEXT PRIMARY KEY,
        ciphertext BYTEA NOT NULL,
        initialization_vector BYTEA NOT NULL,
        authentication_tag BYTEA NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_inventory_snapshots (
        genesys_organization_id TEXT PRIMARY KEY,
        inventory JSONB NOT NULL DEFAULT '{}'::jsonb,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_configuration_aggregates (
        id UUID PRIMARY KEY,
        genesys_organization_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'audio_connector', 'audio_routing', 'messaging_profile', 'voice_profile',
          'callback_campaign', 'assistant', 'tool_bundle', 'queue_policy', 'tts',
          'agent_experience', 'insight_profile'
        )),
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        desired_revision INTEGER NOT NULL DEFAULT 1,
        desired_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_genesys_user_id TEXT,
        updated_by_genesys_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (genesys_organization_id, kind, name)
      );

      CREATE TABLE IF NOT EXISTS integration_ai_assistants (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL UNIQUE
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        telnyx_assistant_id TEXT UNIQUE,
        ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'external')),
        name TEXT NOT NULL,
        desired_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_handoff_policies (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL UNIQUE
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        context TEXT NOT NULL CHECK (context IN (
          'audio_inbound', 'callback_outbound', 'web_messaging', 'web_voice'
        )),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_handoff_policy_queues (
        policy_id UUID NOT NULL REFERENCES integration_handoff_policies(id) ON DELETE CASCADE,
        genesys_queue_id TEXT NOT NULL,
        genesys_queue_name TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (policy_id, genesys_queue_id)
      );

      CREATE TABLE IF NOT EXISTS integration_ai_tool_definitions (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        logical_key TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'channel', 'deployment')),
        scope_id TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        desired_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provider TEXT NOT NULL DEFAULT 'telnyx',
        remote_tool_id TEXT,
        display_name TEXT,
        function_name TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'missing', 'drifted', 'retired')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_verified_at TIMESTAMPTZ,
        UNIQUE (aggregate_id, logical_key, scope_type, scope_id)
      );

      CREATE TABLE IF NOT EXISTS integration_ai_tool_assignments (
        id UUID PRIMARY KEY,
        assistant_id UUID REFERENCES integration_ai_assistants(id) ON DELETE CASCADE,
        remote_assistant_id TEXT NOT NULL,
        tool_definition_id UUID NOT NULL
          REFERENCES integration_ai_tool_definitions(id) ON DELETE CASCADE,
        required_by TEXT NOT NULL,
        component TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'assistant_missing', 'detached')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_verified_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS integration_audio_dnis_routes (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        dnis TEXT NOT NULL,
        assistant_id UUID NOT NULL REFERENCES integration_ai_assistants(id),
        takeover_approved BOOLEAN NOT NULL DEFAULT FALSE,
        takeover_source JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (aggregate_id, dnis)
      );

      CREATE TABLE IF NOT EXISTS integration_callback_campaigns (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL UNIQUE
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        assistant_id UUID REFERENCES integration_ai_assistants(id),
        queue_policy_id UUID REFERENCES integration_handoff_policies(id),
        caller_address TEXT NOT NULL,
        caller_name TEXT NOT NULL,
        genesys_site_id TEXT NOT NULL,
        genesys_wrapup_code_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_widget_channel_profiles (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL UNIQUE
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('messaging', 'voice')),
        assistant_id UUID REFERENCES integration_ai_assistants(id),
        queue_policy_id UUID REFERENCES integration_handoff_policies(id),
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integration_managed_resources (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL
          REFERENCES integration_configuration_aggregates(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('genesys', 'telnyx')),
        resource_type TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        display_name TEXT,
        desired_hash TEXT,
        observed_hash TEXT,
        status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN (
          'healthy', 'creating', 'updating', 'missing', 'drifted', 'error', 'retired', 'unknown'
        )),
        observed_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_observed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider, remote_id)
      );

      CREATE TABLE IF NOT EXISTS integration_resource_dependencies (
        resource_id UUID NOT NULL REFERENCES integration_managed_resources(id) ON DELETE CASCADE,
        depends_on_resource_id UUID NOT NULL
          REFERENCES integration_managed_resources(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        PRIMARY KEY (resource_id, depends_on_resource_id, relationship),
        CHECK (resource_id <> depends_on_resource_id)
      );

      CREATE TABLE IF NOT EXISTS integration_inventory_sync_runs (
        id UUID PRIMARY KEY,
        genesys_organization_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS widget_one_draft_idx
        ON widget_revisions(widget_id) WHERE state='draft';
      CREATE UNIQUE INDEX IF NOT EXISTS widget_one_published_idx
        ON widget_revisions(widget_id) WHERE state='published';
      CREATE INDEX IF NOT EXISTS widget_sessions_expiry_idx ON widget_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS widget_sessions_telnyx_idx ON widget_sessions(telnyx_conversation_id);
      CREATE UNIQUE INDEX IF NOT EXISTS widget_sessions_token_hash_idx
        ON widget_sessions(session_token_hash) WHERE session_token_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS widget_sessions_telnyx_call_idx
        ON widget_sessions(telnyx_call_id) WHERE telnyx_call_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS widget_handoffs_expiry_idx ON genesys_widget_handoffs(expires_at);
      CREATE INDEX IF NOT EXISTS widget_handoffs_remote_integration_idx
        ON genesys_widget_handoffs(genesys_integration_id, genesys_remote_address);
      CREATE INDEX IF NOT EXISTS widget_webhook_events_expiry_idx
        ON widget_webhook_events(expires_at);
      CREATE INDEX IF NOT EXISTS widget_admin_audit_widget_idx
        ON widget_admin_audit_events(widget_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS widget_handoff_messages_poll_idx
        ON widget_handoff_messages(handoff_id, created_at, id);
      CREATE INDEX IF NOT EXISTS widget_handoff_messages_expiry_idx
        ON widget_handoff_messages(expires_at);
      CREATE INDEX IF NOT EXISTS widget_voice_did_allocations_status_idx
        ON widget_voice_did_allocations(genesys_organization_id, status, phone_number);
      CREATE UNIQUE INDEX IF NOT EXISTS widgets_managed_deployment_id_idx
        ON widgets(managed_deployment_id) WHERE managed_deployment_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS widgets_supported_content_profile_idx
        ON widgets(genesys_organization_id, supported_content_profile_id)
        WHERE supported_content_profile_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS widgets_open_messaging_integration_idx
        ON widgets(genesys_organization_id, open_messaging_integration_id)
        WHERE open_messaging_integration_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS integration_deployment_profiles_org_idx
        ON integration_deployment_profiles(genesys_organization_id, component);
      CREATE INDEX IF NOT EXISTS integration_deployment_runs_org_idx
        ON integration_deployment_runs(genesys_organization_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS integration_deployment_steps_run_idx
        ON integration_deployment_steps(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS integration_runtime_secrets_updated_idx
        ON integration_runtime_secrets(updated_at DESC);
      CREATE INDEX IF NOT EXISTS integration_inventory_snapshots_refreshed_idx
        ON integration_inventory_snapshots(refreshed_at DESC);
      CREATE INDEX IF NOT EXISTS integration_aggregates_org_kind_idx
        ON integration_configuration_aggregates(genesys_organization_id, kind, enabled);
      CREATE UNIQUE INDEX IF NOT EXISTS integration_handoff_policy_one_default_idx
        ON integration_handoff_policy_queues(policy_id) WHERE is_default;
      CREATE UNIQUE INDEX IF NOT EXISTS integration_ai_tool_remote_id_idx
        ON integration_ai_tool_definitions(provider, remote_tool_id)
        WHERE remote_tool_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS integration_ai_tool_assignments_owner_idx
        ON integration_ai_tool_assignments(tool_definition_id, remote_assistant_id, required_by);
      CREATE INDEX IF NOT EXISTS integration_resources_aggregate_idx
        ON integration_managed_resources(aggregate_id, provider, resource_type);
      CREATE INDEX IF NOT EXISTS integration_resources_health_idx
        ON integration_managed_resources(status, last_observed_at DESC);
      CREATE INDEX IF NOT EXISTS integration_inventory_sync_org_idx
        ON integration_inventory_sync_runs(genesys_organization_id, started_at DESC);

      DELETE FROM widget_schema_migrations;
    `,
  },
  {
    version: 101,
    name: "organization_scoped_shared_tts",
    sql: `
      ALTER TABLE integration_configuration_aggregates
        ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'installation'
          CHECK (scope_type IN ('installation', 'organization'));

      UPDATE integration_configuration_aggregates
      SET scope_type='organization', updated_at=NOW()
      WHERE kind='tts' AND scope_type <> 'organization';

      CREATE INDEX IF NOT EXISTS integration_aggregates_scope_idx
        ON integration_configuration_aggregates(
          genesys_organization_id, scope_type, kind, enabled
        );
    `,
  },
  {
    version: 102,
    name: "widget_handoff_agent_presence_polling",
    sql: `
      ALTER TABLE genesys_widget_handoffs
        ADD COLUMN IF NOT EXISTS agent_polled_at TIMESTAMPTZ;
    `,
  },
  {
    version: 105,
    name: "telnyx_conversation_insight_events",
    sql: `
      CREATE TABLE IF NOT EXISTS telnyx_conversation_insight_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        insight_group_id TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS telnyx_insight_events_conversation_idx
        ON telnyx_conversation_insight_events(conversation_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS telnyx_insight_events_expiry_idx
        ON telnyx_conversation_insight_events(expires_at);
    `,
  },
  {
    version: 106,
    name: "widget_open_messaging_typing_state",
    sql: `
      ALTER TABLE genesys_widget_handoffs
        ADD COLUMN IF NOT EXISTS agent_typing_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS customer_typing_sent_at TIMESTAMPTZ;
    `,
  },
  {
    version: 107,
    name: "deployment_scoped_unique_widget_names_and_resource_ownership",
    sql: `
      ALTER TABLE widgets
        ADD COLUMN IF NOT EXISTS installation_key TEXT,
        ADD COLUMN IF NOT EXISTS normalized_name TEXT;

      UPDATE widgets
      SET normalized_name=LOWER(REGEXP_REPLACE(BTRIM(name), '\\s+', ' ', 'g'))
      WHERE normalized_name IS NULL;

      ALTER TABLE widgets
        ALTER COLUMN normalized_name SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS widgets_deployment_name_idx
        ON widgets(
          COALESCE(genesys_organization_id, ''),
          COALESCE(installation_key, 'seed'),
          normalized_name
        );

      ALTER TABLE integration_managed_resources
        ADD COLUMN IF NOT EXISTS logical_key TEXT,
        ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'installation'
          CHECK (scope_type IN ('installation', 'widget', 'organization')),
        ADD COLUMN IF NOT EXISTS scope_id TEXT,
        ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'managed'
          CHECK (ownership IN ('managed', 'external')),
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS integration_resources_destroy_idx
        ON integration_managed_resources(ownership, provider, status, deleted_at);
    `,
  },
  {
    version: 108,
    name: "web_chat_assistant_moves_to_widget_revision",
    sql: `
      DELETE FROM integration_widget_channel_profiles
      WHERE channel='messaging';

      UPDATE integration_configuration_aggregates
      SET desired_config=COALESCE(desired_config, '{}'::jsonb) - 'assistantId',
          updated_at=NOW()
      WHERE kind='messaging_profile'
        AND name='web_messaging:default';
    `,
  },
  {
    version: 109,
    name: "widget_infrastructure_fingerprint",
    sql: `
      ALTER TABLE widgets
        ADD COLUMN IF NOT EXISTS infrastructure_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS infrastructure_config JSONB,
        ADD COLUMN IF NOT EXISTS infrastructure_synced_at TIMESTAMPTZ;
    `,
  },
  {
    version: 110,
    name: "web_calls_profile_is_transport_only",
    sql: `
      UPDATE integration_widget_channel_profiles
      SET assistant_id=NULL,
          config=COALESCE(config, '{}'::jsonb) - 'assistantVersionId',
          updated_at=NOW()
      WHERE channel='voice';

      UPDATE integration_configuration_aggregates
      SET desired_config=COALESCE(desired_config, '{}'::jsonb)
            - 'assistantId'
            - 'assistantVersionId',
          updated_at=NOW()
      WHERE kind='voice_profile'
        AND name='web_voice:default';
    `,
  },
  {
    version: 111,
    name: "configuration_aggregate_kind_constraint",
    sql: `
      ALTER TABLE integration_configuration_aggregates
        DROP CONSTRAINT IF EXISTS integration_configuration_aggregates_kind_check;

      ALTER TABLE integration_configuration_aggregates
        ADD CONSTRAINT integration_configuration_aggregates_kind_check
        CHECK (kind IN (
          'audio_connector', 'audio_routing', 'messaging_profile', 'voice_profile',
          'callback_campaign', 'assistant', 'tool_bundle', 'queue_policy', 'tts',
          'agent_experience', 'insight_profile'
        ));
    `,
  },
  {
    version: 112,
    name: "managed_assistant_insight_profile",
    sql: `
      ALTER TABLE integration_configuration_aggregates
        DROP CONSTRAINT IF EXISTS integration_configuration_aggregates_kind_check;

      ALTER TABLE integration_configuration_aggregates
        ADD CONSTRAINT integration_configuration_aggregates_kind_check
        CHECK (kind IN (
          'audio_connector', 'audio_routing', 'messaging_profile', 'voice_profile',
          'callback_campaign', 'assistant', 'tool_bundle', 'queue_policy', 'tts',
          'agent_experience', 'insight_profile'
        ));
    `,
  },
];

let ensurePromise;

export async function ensurePostgresSchema() {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const client = await getPostgresPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [847221, 1]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS widget_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const appliedResult = await client.query(
        "SELECT version FROM widget_schema_migrations ORDER BY version"
      );
      const applied = new Set(appliedResult.rows.map((row) => row.version));

      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO widget_schema_migrations(version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
        console.log(`[ensure-pg] applied v${migration.version}: ${migration.name}`);
      }

      await client.query("COMMIT");
      return { version: MIGRATIONS.at(-1)?.version || 0 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      ensurePromise = null;
      throw error;
    } finally {
      client.release();
    }
  })();

  return ensurePromise;
}
