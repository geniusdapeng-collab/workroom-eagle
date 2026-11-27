-- Eagle operating evidence uses immutable business rows and receipts from the
-- existing WorkData ledger. Application roles can read and append their scoped
-- data. Corrections add rows; they never rewrite the original evidence.

CREATE TABLE eagle_business_facts (
  tenant_id            text        NOT NULL REFERENCES tenants(id),
  workspace_id         text        NOT NULL REFERENCES workspaces(id),
  id                   uuid        NOT NULL,
  owner_member_id      text        NOT NULL,
  recorded_by          text        NOT NULL,
  kind                 text        NOT NULL CHECK (kind IN ('lead','interaction','opportunity','contract','invoice','payment','delivery_cost','deal_outcome','commitment')),
  occurred_on          date        NOT NULL,
  recorded_at          timestamptz NOT NULL,
  source_kind          text        NOT NULL CHECK (source_kind IN ('manual','crm','finance')),
  source_ref           text,
  supersedes_fact_id   uuid,
  payload              jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  event_id             text        NOT NULL,
  event_hash           text        NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, supersedes_fact_id),
  FOREIGN KEY (tenant_id, workspace_id, supersedes_fact_id) REFERENCES eagle_business_facts(tenant_id, workspace_id, id),
  CHECK (supersedes_fact_id IS DISTINCT FROM id),
  CHECK (source_kind = 'manual' OR source_ref IS NOT NULL)
);
CREATE INDEX eagle_business_facts_time ON eagle_business_facts(tenant_id, workspace_id, occurred_on, recorded_at, id);
CREATE INDEX eagle_business_facts_owner ON eagle_business_facts(tenant_id, workspace_id, owner_member_id, recorded_at DESC, id);
CREATE INDEX eagle_business_facts_source ON eagle_business_facts(tenant_id, workspace_id, kind, source_kind, source_ref) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX eagle_business_facts_original_source ON eagle_business_facts(tenant_id, workspace_id, kind, source_kind, source_ref) WHERE source_ref IS NOT NULL AND supersedes_fact_id IS NULL;
CREATE INDEX eagle_business_facts_deal ON eagle_business_facts(tenant_id, workspace_id, (payload->>'dealRef'));
CREATE INDEX eagle_business_facts_invoice ON eagle_business_facts(tenant_id, workspace_id, (payload->>'invoiceRef')) WHERE kind = 'invoice';

CREATE TABLE eagle_business_briefs (
  tenant_id      text        NOT NULL REFERENCES tenants(id),
  workspace_id   text        NOT NULL REFERENCES workspaces(id),
  id             uuid        NOT NULL,
  source_run_key text        NOT NULL,
  business_date  date        NOT NULL,
  as_of          timestamptz NOT NULL,
  created_at     timestamptz NOT NULL,
  payload        jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  content_hash   text        NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  event_id       text        NOT NULL,
  event_hash     text        NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, source_run_key)
);
CREATE INDEX eagle_business_briefs_latest ON eagle_business_briefs(tenant_id, workspace_id, business_date DESC, as_of DESC, created_at DESC, id DESC);

CREATE TABLE eagle_business_actions (
  tenant_id       text        NOT NULL REFERENCES tenants(id),
  workspace_id    text        NOT NULL REFERENCES workspaces(id),
  id              uuid        NOT NULL,
  artifact_id     uuid        NOT NULL,
  insight_id      text        NOT NULL,
  owner_member_id text        NOT NULL,
  confirmed_by    text        NOT NULL,
  due_at          timestamptz NOT NULL,
  created_at      timestamptz NOT NULL,
  title           text        NOT NULL,
  description     text        NOT NULL,
  acceptance_condition text   NOT NULL,
  event_id        text        NOT NULL,
  event_hash      text        NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, artifact_id, insight_id),
  FOREIGN KEY (tenant_id, workspace_id, artifact_id) REFERENCES eagle_business_briefs(tenant_id, workspace_id, id)
);
CREATE INDEX eagle_business_actions_owner ON eagle_business_actions(tenant_id, workspace_id, owner_member_id, due_at, id);
CREATE INDEX eagle_business_actions_insight ON eagle_business_actions(tenant_id, workspace_id, insight_id);

CREATE TABLE eagle_business_action_events (
  tenant_id     text        NOT NULL REFERENCES tenants(id),
  workspace_id  text        NOT NULL REFERENCES workspaces(id),
  id            uuid        NOT NULL,
  action_id     uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('outcome','verification')),
  outcome_id    uuid,
  actor_id      text        NOT NULL,
  created_at    timestamptz NOT NULL,
  payload       jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  event_id      text        NOT NULL,
  event_hash    text        NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, action_id, id),
  UNIQUE (tenant_id, workspace_id, action_id, outcome_id),
  FOREIGN KEY (tenant_id, workspace_id, action_id) REFERENCES eagle_business_actions(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, action_id, outcome_id) REFERENCES eagle_business_action_events(tenant_id, workspace_id, action_id, id),
  CHECK ((kind = 'verification') = (outcome_id IS NOT NULL))
);
CREATE INDEX eagle_business_action_events_latest ON eagle_business_action_events(tenant_id, workspace_id, action_id, kind, created_at DESC, id DESC);

CREATE TABLE eagle_business_requests (
  tenant_id    text  NOT NULL REFERENCES tenants(id),
  workspace_id text  NOT NULL REFERENCES workspaces(id),
  actor_id     text  NOT NULL,
  operation    text  NOT NULL,
  request_key  text  NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  fingerprint  text  NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result       jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (tenant_id, workspace_id, actor_id, operation, request_key)
);

DO $$
DECLARE
  scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY['eagle_business_facts', 'eagle_business_briefs',
    'eagle_business_actions', 'eagle_business_action_events', 'eagle_business_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('CREATE POLICY eagle_business_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))', scoped_table);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO workloom_app', scoped_table);
  END LOOP;
END $$;
