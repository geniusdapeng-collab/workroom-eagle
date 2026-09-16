import { describe, expect, it } from "vitest";
import { loadBundleUiProjection } from "@workloom/base/bundles";
import {
  bindBusinessAdapter,
  registeredBusinessAdapterIds,
} from "./business-registry.js";

describe("鹰眼服务前台行业适配器目录", () => {
  it("未交付咨询业务数据适配器时保持空目录并失败关闭", () => {
    expect(registeredBusinessAdapterIds()).toEqual([]);
    const binding = bindBusinessAdapter({
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

  it("伪造任意行业适配器标识不会回退到基座示例", () => {
    const projection = loadBundleUiProjection("consulting");
    const binding = bindBusinessAdapter({
      workspaceBundleId: "consulting",
      activeInstalls: [{ id: "install-consulting", bundleId: "consulting" }],
    }, () => ({
      ...projection,
      ui: {
        ...projection.ui,
        serviceFront: { ...projection.ui.serviceFront, enabled: true, adapterId: "hotel.service-v1" },
      },
    }));
    expect(binding).toMatchObject({ state: "adapter-unknown", adapter: null });
  });

  it("装配指针冲突在选择适配器前即失败关闭", () => {
    const binding = bindBusinessAdapter({
      workspaceBundleId: "consulting",
      activeInstalls: [{ id: "install-other", bundleId: "hotel" }],
    });
    expect(binding).toMatchObject({ state: "bundle-mismatch", adapter: null });
  });
});
