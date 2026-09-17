import { describe, expect, it } from "vitest";
import { loadBundleUiProjection } from "@workloom/base/bundles";
import {
  bindInspectionAdapter,
  registeredInspectionBundleIds,
} from "./inspection-adapter.js";

describe("鹰眼巡检行业适配器目录", () => {
  it("未交付咨询巡检实现时保持空目录并失败关闭", () => {
    expect(registeredInspectionBundleIds()).toEqual([]);
    const binding = bindInspectionAdapter({
      workspaceBundleId: "consulting",
      activeInstalls: [{ id: "install-consulting", bundleId: "consulting" }],
    });
    expect(binding).toMatchObject({
      state: "adapter-not-declared",
      adapter: null,
      bundleId: "consulting",
      installId: "install-consulting",
    });
  });

  it("伪造巡检适配器标识不会回退到基座示例", () => {
    const projection = loadBundleUiProjection("consulting");
    const binding = bindInspectionAdapter({
      workspaceBundleId: "consulting",
      activeInstalls: [{ id: "install-consulting", bundleId: "consulting" }],
    }, () => ({
      ...projection,
      ui: {
        ...projection.ui,
        inspection: { enabled: true, adapterId: "hotel.inspection-v1" },
      },
    }));
    expect(binding).toMatchObject({ state: "adapter-not-registered", adapter: null });
  });

  it("装配指针冲突在选择巡检实现前即失败关闭", () => {
    const binding = bindInspectionAdapter({
      workspaceBundleId: "consulting",
      activeInstalls: [{ id: "install-other", bundleId: "hotel" }],
    });
    expect(binding).toMatchObject({ state: "bundle-mismatch", adapter: null });
  });
});
