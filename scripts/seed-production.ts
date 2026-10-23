/** 正式装机初始化：只安装产品元数据；不生成任何客户、任务、经营指标或成功回执。 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PRODUCTION_WORKSPACE_SLUG = "eagle-production";
export const PRODUCTION_WORKSPACE_ID = "ws-workroom-eagle-production";
export const PRODUCTION_TENANT_ID = "tenant-workroom-eagle-production";
export const PRODUCTION_OWNER_ID = "member-workroom-eagle-local-owner";

interface QueryClient { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }
interface Preset {
  preset_key: string; name: string; version: string; kind: string; readonly: boolean;
  fence_bindings: string[]; skills: string[]; [key: string]: unknown;
}

export async function initializeProduction(client: QueryClient, root = ROOT): Promise<void> {
  const product = JSON.parse(readFileSync(join(root, "product.manifest.json"), "utf8"));
  if (product.productId !== "workroom-eagle" || product.defaultBundle !== "consulting") {
    throw new Error("正式初始化只适用于受保护的鹰眼产品身份");
  }
  const bundleRoot = join(root, "bundles/consulting");
  const bundle = JSON.parse(readFileSync(join(bundleRoot, "bundle.json"), "utf8"));
  const provides = bundle.workloom.provides;
  const assetPath = (relative: string) => {
    if (!/^[a-z0-9/-]+\.(?:yml|md)$/i.test(relative) || relative.split("/").includes("..")) {
      throw new Error("行业资产路径不合法");
    }
    return join(bundleRoot, relative);
  };
  const presets: Preset[] = provides.presets.map((file: string) => YAML.parse(readFileSync(assetPath(file), "utf8")));
  const fencePacks = provides.fences.map((file: string) => YAML.parse(readFileSync(assetPath(file), "utf8")));
  const fenceIds = new Set<string>(fencePacks.flatMap((pack: { rules: Array<{ rule_id: string }> }) => pack.rules.map((r) => r.rule_id)));
  for (const preset of presets) {
    if (!preset.preset_key || !Array.isArray(preset.skills) || !Array.isArray(preset.fence_bindings)
      || preset.fence_bindings.some((id) => !fenceIds.has(id))) throw new Error("岗位技能或围栏声明不完整");
  }
  const ownerName = process.env.WORKLOOM_OWNER_NAME?.trim() || "本机负责人";
  const workspaceName = process.env.WORKLOOM_WORKSPACE_NAME?.trim() || "鹰眼咨询工作区";
  const accountId = "account-workroom-eagle-local-owner";
  const archive = {
    dataMode: "real",
    firm: { name: workspaceName, principal: ownerName, bio: "", specialties: [], methodologies: [], price_list: {} },
    clients: [],
    charter: { mode: "disabled" },
    forbidden: [
      { rule: "客户敏感数据不得外发第三方", scope: "enterprise" },
      { rule: "关键访谈、最终诊断与高风险建议由人类咨询师裁决", scope: "enterprise" },
    ],
  };
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('eagle-production-install'))");
    await client.query("INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING", [PRODUCTION_TENANT_ID, workspaceName]);
    await client.query(
      `INSERT INTO workspaces (id,tenant_id,name,slug,industry,stage,night_config,bundle_id,is_example)
       VALUES ($1,$2,$3,$4,'consulting','intake','{"enabled":false}','consulting',false)
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCTION_WORKSPACE_ID, PRODUCTION_TENANT_ID, workspaceName, PRODUCTION_WORKSPACE_SLUG],
    );
    const existing = await client.query("SELECT tenant_id,bundle_id,is_example FROM workspaces WHERE id=$1", [PRODUCTION_WORKSPACE_ID]);
    if (existing.rows[0]?.tenant_id !== PRODUCTION_TENANT_ID || existing.rows[0]?.bundle_id !== "consulting" || existing.rows[0]?.is_example !== false) {
      throw new Error("正式工作区身份冲突；保留现有数据并拒绝覆盖");
    }
    await client.query("INSERT INTO accounts (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [accountId, ownerName]);
    await client.query(
      `INSERT INTO members (id,workspace_id,member_no,name,role,account_id)
       VALUES ($1,$2,'OWNER',$3,'owner',$4) ON CONFLICT (workspace_id,member_no) DO NOTHING`,
      [PRODUCTION_OWNER_ID, PRODUCTION_WORKSPACE_ID, ownerName, accountId],
    );
    await client.query(
      `INSERT INTO profiles (workspace_id,tenant_id,industry,archive,forbidden,pii_vault)
       VALUES ($1,$2,'consulting',$3,$4,NULL) ON CONFLICT (workspace_id) DO NOTHING`,
      [PRODUCTION_WORKSPACE_ID, PRODUCTION_TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
    );
    for (const preset of presets) {
      await client.query(
        `INSERT INTO agents (id,workspace_id,preset_key,name,version,kind,readonly,fence_bindings,skills,status,meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10) ON CONFLICT (id) DO NOTHING`,
        [`agt-${PRODUCTION_WORKSPACE_ID}-${preset.preset_key}`, PRODUCTION_WORKSPACE_ID, preset.preset_key,
          preset.name, preset.version, preset.kind, preset.readonly, JSON.stringify(preset.fence_bindings),
          JSON.stringify(preset.skills), JSON.stringify(preset)],
      );
    }
    for (const pack of fencePacks) {
      for (const rule of pack.rules) {
        await client.query(
          `INSERT INTO fence_rules (id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','system:production-install')
           ON CONFLICT (rule_id,version,workspace_id) DO NOTHING`,
          [`fr-${PRODUCTION_WORKSPACE_ID}-${rule.rule_id}`, rule.rule_id, pack.version, PRODUCTION_WORKSPACE_ID,
            rule.name, rule.level, JSON.stringify({ ...rule.match, when: rule.when }),
            JSON.stringify({ result: rule.level === "auto" ? "pass" : rule.level === "review" ? "review" : "blocked", note: rule.note ?? "" }), rule.is_baseline !== false],
        );
      }
    }
    for (const file of provides.skills as string[]) {
      const raw = readFileSync(assetPath(file), "utf8");
      const parsed = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!parsed) throw new Error(`技能缺少元数据：${file}`);
      const meta = YAML.parse(parsed[1]!);
      const name = String(meta.name ?? file.split("/")[1]);
      const bindings = [...new Set(presets.filter((preset) => preset.skills.includes(name)).flatMap((preset) => preset.fence_bindings))];
      const id = `skill-consulting-${name}`;
      await client.query(
        `INSERT INTO skills (id,level,bundle,name,version,description,fence_bindings,body,desensitized)
         VALUES ($1,'official','consulting',$2,$3,$4,$5,$6,false) ON CONFLICT (id) DO NOTHING`,
        [id, name, String(meta.version ?? "1.0.0"), String(meta.description ?? ""), JSON.stringify(bindings), parsed[2]!.trim()],
      );
      await client.query(
        `INSERT INTO skill_installs (skill_id,workspace_id,installed_by,fence_bindings_snapshot,installed_version)
         SELECT id,$2,'OWNER',fence_bindings,version FROM skills WHERE id=$1
         ON CONFLICT (skill_id,workspace_id) DO NOTHING`, [id, PRODUCTION_WORKSPACE_ID],
      );
    }
    await client.query(
      `INSERT INTO bundle_installs (id,workspace_id,bundle_id,assets,status)
       VALUES ($1,$2,'consulting',$3,'active') ON CONFLICT (id) DO NOTHING`,
      [`bi-${PRODUCTION_WORKSPACE_ID}-consulting`, PRODUCTION_WORKSPACE_ID,
        JSON.stringify({ production_install: true, bundle_version: bundle.version, bundle_digest: bundle.integrity?.digest })],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "正式初始化失败，事务回滚也失败");
    }
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("正式初始化必须显式提供 DATABASE_URL");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await initializeProduction(client);
    console.log("正式工作区初始化完成：真实模式，客户档案/任务/回执为空，既有数据保持不变。");
  } finally { await client.end(); }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("正式初始化失败；请检查数据库状态与行业资产，现有业务资料没有被覆盖。"); process.exitCode = 1; });
}
