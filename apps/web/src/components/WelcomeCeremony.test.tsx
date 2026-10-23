// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WelcomeCeremony } from "./WelcomeCeremony";

vi.mock("./CeremonyStage", () => ({ CeremonyStage: () => <div>团队形象</div> }));
vi.mock("./MateWelcome", () => ({ MateWelcome: () => <div>开场</div> }));
vi.mock("@workloom/ui", () => ({ Icon: () => <span />, useManagedSurface: () => ({ ref: { current: null } }), clientChineseText: (value: unknown) => typeof value === "string" ? value : "" }));

describe("真实首装欢迎介绍", () => {
  it("展示22个已安装岗位、正式资料接入状态与当前能力边界，不加入虚构总经理或演示承诺", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(resolve(here, "../../../../bundles/consulting/bundle.json"), "utf8"));
    const actors = manifest.workloom.provides.presets.map((preset: string) => ({ presetKey: preset, name: "已装配岗位" }));
    expect(actors).toHaveLength(22);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<WelcomeCeremony actors={actors} bundleName="鹰眼咨询" welcome={manifest.workloom.ui.welcome} installation={{ mode: "production", customerDataReady: false }} initialStep="summary" role="owner" onPause={() => {}} onDone={() => {}} />));
      expect(host.textContent).toContain("共有 22 名数字员工");
      expect(host.textContent).toContain("这是正式工作区，客户名单尚未接入");
      expect(host.textContent).toContain("待复核的内部草稿");
      expect(host.textContent).not.toMatch(/23 名|真实在岗|可操作的演示运行态|10 分钟/);
      expect(host.querySelector('a[href="/onboarding"]')).not.toBeNull();
      const page = readFileSync(resolve(here, "../pages/p0/P0.tsx"), "utf8");
      const welcomeInvocation = page.slice(page.indexOf("<WelcomeCeremony"), page.indexOf("<SubtitleBar"));
      expect(welcomeInvocation).toContain("actors={data.satellites.map");
      expect(welcomeInvocation).not.toContain('presetKey: "company-ceo"');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
