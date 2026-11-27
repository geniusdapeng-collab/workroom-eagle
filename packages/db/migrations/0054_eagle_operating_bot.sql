-- Eagle owns this data. Only the app role operates the queue through dual-scope RLS.
-- The shared event ledger records state changes and receipts in the same transaction.
CREATE TABLE eagle_bot_mandates (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  business_unit TEXT NOT NULL,
  issuer_member_id TEXT NOT NULL,
  issuer_member_no TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability = 'eagle.operating-brief'),
  contract_version INT NOT NULL CHECK (contract_version = 1),
  request_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  max_runs INT NOT NULL CHECK (max_runs BETWEEN 1 AND 90),
  used_runs INT NOT NULL DEFAULT 0 CHECK (used_runs BETWEEN 0 AND max_runs),
  max_runtime_seconds INT NOT NULL CHECK (max_runtime_seconds BETWEEN 5 AND 120),
  daily_at TEXT CHECK (daily_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  next_due_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  CHECK ((daily_at IS NULL) = (next_due_at IS NULL)),
  UNIQUE (tenant_id, workspace_id, request_digest),
  UNIQUE (tenant_id, workspace_id, id)
);

CREATE INDEX eagle_bot_mandates_due
  ON eagle_bot_mandates (tenant_id, workspace_id, next_due_at)
  WHERE revoked_at IS NULL AND next_due_at IS NOT NULL AND used_runs < max_runs;

CREATE TABLE eagle_bot_tasks (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mandate_id UUID NOT NULL,
  business_unit TEXT NOT NULL,
  business_date DATE NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'daily')),
  request_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  deadline TIMESTAMPTZ NOT NULL CHECK (deadline >= scheduled_at),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at TIMESTAMPTZ NOT NULL,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  result JSONB,
  error_code TEXT,
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  FOREIGN KEY (tenant_id, workspace_id, mandate_id) REFERENCES eagle_bot_mandates (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, trigger, request_digest),
  UNIQUE (tenant_id, workspace_id, id)
);

CREATE INDEX eagle_bot_tasks_queue
  ON eagle_bot_tasks (tenant_id, workspace_id, available_at, id) WHERE status = 'queued';
CREATE INDEX eagle_bot_tasks_lease
  ON eagle_bot_tasks (tenant_id, workspace_id, lease_until, id) WHERE status = 'running';
CREATE INDEX eagle_bot_tasks_history
  ON eagle_bot_tasks (tenant_id, workspace_id, created_at DESC, id);

CREATE TABLE eagle_bot_attempts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id UUID NOT NULL,
  attempt_no INT NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  lease_token UUID NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'cancelled', 'failed', 'expired')),
  error_code TEXT,
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  CHECK ((status = 'running') = (settled_at IS NULL)),
  PRIMARY KEY (tenant_id, workspace_id, task_id, attempt_no),
  FOREIGN KEY (tenant_id, workspace_id, task_id) REFERENCES eagle_bot_tasks (tenant_id, workspace_id, id)
);

DO $$
DECLARE
  bot_table TEXT;
BEGIN
  FOREACH bot_table IN ARRAY ARRAY['eagle_bot_mandates', 'eagle_bot_tasks', 'eagle_bot_attempts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', bot_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', bot_table);
    EXECUTE format(
      'CREATE POLICY scoped_eagle_bot ON %I TO workloom_app USING
        (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))
        WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))',
      bot_table
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO workloom_app', bot_table);
  END LOOP;
END $$;
