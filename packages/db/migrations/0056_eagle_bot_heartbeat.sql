-- Worker presence is an expiring projection, separate from business receipts.
CREATE TABLE eagle_bot_worker_presence (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_successful_tick_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ NOT NULL CHECK (valid_until > last_seen_at),
  PRIMARY KEY (tenant_id, workspace_id)
);

ALTER TABLE eagle_bot_worker_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE eagle_bot_worker_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped_eagle_bot_worker_presence ON eagle_bot_worker_presence TO workloom_app
  USING (tenant_id = current_setting('app.tenant_id', true) AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON eagle_bot_worker_presence TO workloom_app;
