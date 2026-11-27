import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { industryRoutes } from "./routes";

const manifest = JSON.parse(readFileSync(
  new URL("../../../../../bundles/consulting/bundle.json", import.meta.url),
  "utf8",
)) as {
  workloom: {
    ui: {
      navigation: {
        slots: Array<{ capabilityId: string; route: string; clients: string[] }>;
      };
    };
  };
};

describe("鹰眼咨询行业路由", () => {
  it("使用咨询命名空间的语义路由并与能力一一对应", () => {
    expect(industryRoutes).toHaveLength(6);
    expect(new Set(industryRoutes.map((route) => route.path)).size).toBe(industryRoutes.length);
    expect(new Set(industryRoutes.map((route) => route.capabilityId)).size).toBe(industryRoutes.length);
    for (const route of industryRoutes) {
      expect(route.path).toMatch(/^\/consulting\/[a-z-]+$/);
      expect(route.capabilityId).toMatch(/^consulting\.[a-z-]+$/);
    }
  });

  it("PC 扩展与 Bundle 导航槽逐项一致，保留咨询移动投影", () => {
    const slots = manifest.workloom.ui.navigation.slots;
    expect(industryRoutes.map(({ path, capabilityId }) => ({ path, capabilityId }))).toEqual(
      slots.map(({ route: path, capabilityId }) => ({ path, capabilityId })),
    );
    expect(slots.every((slot) => slot.clients.includes("pc"))).toBe(true);
    expect(slots.filter((slot) => slot.capabilityId !== "consulting.business").every((slot) => slot.clients.includes("b-mobile"))).toBe(true);
    expect(slots.find((slot) => slot.capabilityId === "consulting.business")?.clients).toEqual(["pc"]);
  });
});
