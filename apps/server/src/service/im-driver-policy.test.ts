import { describe, expect, it } from "vitest";
import { imDriverPolicy } from "./im-driver-policy.js";
describe("explicit IM transport and truthful delivery", () => {
  it("defaults to disabled even during development", () => {
    expect(imDriverPolicy({}).mode).toBe("disabled");
    expect(imDriverPolicy({ NODE_ENV: "development" }).dataMode).toBe("unconfigured");
  });
  it("allows mock only when explicitly requested outside production", () => {
    expect(imDriverPolicy({ NODE_ENV: "test", IM_DRIVER: "mock" })).toMatchObject({ mode: "mock", dataMode: "simulated" });
  });
  it("production cannot enable mock or invent a real transport from a config string", () => {
    for (const value of [undefined, "mock", "wecom", "real", "disabled"]) {
      expect(imDriverPolicy({ NODE_ENV: "production", IM_DRIVER: value })).toMatchObject({ mode: "disabled", dataMode: "unconfigured" });
    }
  });
  it("an unimplemented provider never silently falls back to MockChannelDriver", () => {
    expect(imDriverPolicy({ NODE_ENV: "development", IM_DRIVER: "wecom" }).mode).toBe("disabled");
  });
});
