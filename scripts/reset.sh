#!/usr/bin/env bash
# WorkLoom IM 底座 · 数据重置（演示剧本前置：回到干净的云栖酒店数据集）
# 注意：biz_events 为 append-only（触发器禁 DELETE，L1.1），
#      因此重置 = 整库重建（drop schema）→ 迁移 → 种子，而非清表。
# 用法：./scripts/reset.sh [--yes]；仅允许本机 workloom 纯演示库。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== WorkLoom IM 底座 · 重置演示数据 =="
if [ "$#" -gt 1 ]; then echo "未知参数；只支持 --yes/-y" >&2; exit 64; fi
case "${1:-}" in
  --yes|-y) ;;
  "")
    if [ ! -t 0 ]; then echo "非交互环境必须显式传入 --yes" >&2; exit 64; fi
    read -r -p "确认重建本机纯演示数据库？[y/N] " answer
    [ "$answer" = "y" ] || exit 0 ;;
  *) echo "未知参数；只支持 --yes/-y" >&2; exit 64 ;;
esac
if [ "${NODE_ENV:-}" = "production" ]; then echo "生产环境禁止重置演示数据库" >&2; exit 65; fi
if [ -z "${DATABASE_URL:-}" ]; then
  if [ ! -f .env ]; then echo "未配置 DATABASE_URL，拒绝重置" >&2; exit 65; fi
  DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .env)
fi
export DATABASE_URL
node --input-type=module <<'NODE'
try {
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/workloom' || url.search || url.hash || !url.username) throw new Error();
} catch {
  console.error('只允许显式配置的本机 workloom 演示数据库；远端、生产库名及连接参数覆盖均拒绝');
  process.exit(65);
}
NODE
# 使用同一个明确目标，不根据 ambient Docker 容器悄悄改连另一个数据库。
# libpq PGDATABASE 接受连接 URI，凭据不进入进程 argv。
export PGDATABASE="$DATABASE_URL" PGCONNECT_TIMEOUT=5
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
q() { psql -X -v ON_ERROR_STOP=1 -Atq -c "$1"; }
if [ "$(q "SELECT concat_ws('|', to_regclass('public.workspaces'), to_regclass('public.profiles'), to_regclass('public.bundle_installs'))")" != "workspaces|profiles|bundle_installs" ]; then
  echo "缺少工作区、档案或安装事实表，无法证明纯演示库，拒绝重置" >&2; exit 65
fi
if [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='workspaces' AND column_name='is_example'")" != "1" ]; then
  echo "缺少示例标识，拒绝重置" >&2; exit 65
fi
# A historical example marker alone cannot prove that a workspace still contains
# only demo data. Reuse this exact predicate before backup and under table locks.
UNSAFE_DEMO_SQL=$(cat <<'SQL'
SELECT 1 FROM public.workspaces w
LEFT JOIN public.profiles p ON p.workspace_id=w.id
WHERE w.is_example IS NOT TRUE
   OR w.tenant_id IS DISTINCT FROM 'tenant-demo'
   OR NOT (
     (w.id='ws-yunqi' AND w.slug='yunqi-hotel' AND w.industry='hotel' AND w.bundle_id='hotel')
     OR (w.id='ws-eagle' AND w.slug='eagle-consulting' AND w.industry='consulting' AND w.bundle_id='consulting')
   )
   OR w.slug IS NULL OR w.industry IS NULL OR w.bundle_id IS NULL
   OR p.workspace_id IS NULL OR p.tenant_id IS DISTINCT FROM w.tenant_id OR p.industry IS DISTINCT FROM w.industry
   OR jsonb_typeof(p.archive) IS DISTINCT FROM 'object'
   OR p.archive->>'dataMode' IS DISTINCT FROM 'simulated'
   OR p.archive#>>'{business,source}'='user' OR p.archive#>'{business,configured_at}' IS NOT NULL
   OR p.archive->'realModeActivation' IS NOT NULL OR p.archive->>'production_install'='true'
   OR EXISTS (
     SELECT 1 FROM public.bundle_installs bi
     WHERE bi.workspace_id=w.id
       AND (bi.assets->>'production_install'='true'
         OR (bi.status='active' AND (bi.bundle_id IS DISTINCT FROM w.bundle_id OR jsonb_typeof(bi.assets) IS DISTINCT FROM 'object')))
   )
UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM public.workspaces)
SQL
)
if [ "$(q "SELECT count(*) FROM ($UNSAFE_DEMO_SQL) unsafe_demo")" != "0" ]; then
  echo "检测到正式、未知或身份矛盾的工作区/档案/安装记录，拒绝重置" >&2; exit 65
fi
umask 077
mkdir -p data/reset-backups
backup="$(mktemp data/reset-backups/before-reset.XXXXXXXX.sql)"
if ! pg_dump > "$backup" || [ ! -s "$backup" ]; then
  echo "重置前备份未完成，数据库保持原状" >&2; exit 65
fi
echo "已生成重置前备份：$backup"
# Freeze all three fact tables before checking again. A profile-only conversion
# must not slip between the final check and DROP SCHEMA.
q "BEGIN; LOCK TABLE public.workspaces, public.profiles, public.bundle_installs IN ACCESS EXCLUSIVE MODE;
DO \$\$ BEGIN IF EXISTS ($UNSAFE_DEMO_SQL)
THEN RAISE EXCEPTION '检测到正式、未知或身份矛盾记录，拒绝重置'; END IF; END \$\$;
DROP SCHEMA public CASCADE; CREATE SCHEMA public; COMMIT;"
echo "✅ schema 已重建"

# This owner maintenance command has one validated database target. Child env wins over
# ambient/.env role URLs; ordinary production runtime roles remain unchanged.
DATABASE_APP_URL="$DATABASE_URL" DATABASE_GATEWAY_URL="$DATABASE_URL" pnpm db:migrate
DATABASE_APP_URL="$DATABASE_URL" DATABASE_GATEWAY_URL="$DATABASE_URL" pnpm db:seed:demo
echo "== 重置完成：云栖酒店演示数据集（含「昨夜」夜班数据）已就绪 =="
