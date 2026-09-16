import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const product = JSON.parse(readFileSync(resolve(root, "product.manifest.json"), "utf8"));
const seed = readFileSync(resolve(root, "scripts/seed-consulting.ts"), "utf8");

test("桌面咨询种子满足游客进场的工作区、成员与唯一 Bundle 身份", () => {
  assert.equal(product.defaultBundle, "consulting");
  assert.equal(product.demoWorkspaceSlug, "eagle-consulting");
  assert.equal(product.demoMemberNo, "MEM-E01");
  assert.match(seed, /bundle_id, is_example/u);
  assert.match(seed, /MEM-E01/u);
  assert.match(seed, /INSERT INTO bundle_installs/u);
  assert.match(seed, /bundle_id<>'consulting' AND status='active'/u);
  assert.match(seed, /'consulting',[\s\S]*'active'/u);
  assert.match(seed, /ON CONFLICT \(id\) DO UPDATE SET bundle_id='consulting', status='active'/u);
});
