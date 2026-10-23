import { readFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { colorContrastRatio } from "@workloom/ui";

const productManifest = JSON.parse(readFileSync(new URL("../../../product.manifest.json", import.meta.url), "utf8")) as { displayName?: unknown };
if (typeof productManifest.displayName !== "string" || !productManifest.displayName.trim()) {
  throw new Error("产品清单缺少登录页使用的显示名称");
}
const pcLoginHeading = `登录 ${productManifest.displayName}`;

interface FirstClientFrame {
  client: string;
  documentWidth: number;
  viewportWidth: number;
}

declare global {
  interface Window {
    __workloomFirstClientFrame?: FirstClientFrame;
  }
}

async function installFirstFrameProbe(page: Page) {
  await page.addInitScript(() => {
    const capture = () => {
      if (window.__workloomFirstClientFrame) return;
      const client = document.querySelector<HTMLElement>("[data-workloom-client]");
      if (!client) return;
      window.__workloomFirstClientFrame = {
        client: client.dataset.workloomClient ?? "",
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    };
    // addInitScript 会早于 <html> 建立；直接观察 Document，避免因 documentElement
    // 尚不存在而漏掉 React 的第一次客户端提交。
    new MutationObserver(capture).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", capture, { once: true });
  });
}

async function assertClientFrame(page: Page, client: string) {
  const firstFrame = await page.waitForFunction(() => window.__workloomFirstClientFrame)
    .then((handle) => handle.jsonValue() as Promise<FirstClientFrame>);
  expect(firstFrame.client).toBe(client);
  expect(firstFrame.documentWidth, JSON.stringify(firstFrame)).toBeLessThanOrEqual(firstFrame.viewportWidth + 2);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const stableFrame = await page.evaluate(() => {
    const root = document.documentElement;
    const clientRoot = document.querySelector<HTMLElement>("[data-workloom-client]");
    const rect = clientRoot?.getBoundingClientRect();
    return {
      documentWidth: root.scrollWidth,
      viewportWidth: root.clientWidth,
      clientLeft: rect?.left ?? Number.NaN,
      clientRight: rect?.right ?? Number.NaN,
    };
  });
  expect(stableFrame.documentWidth, JSON.stringify(stableFrame)).toBeLessThanOrEqual(stableFrame.viewportWidth + 2);
  expect(stableFrame.clientLeft, JSON.stringify(stableFrame)).toBeGreaterThanOrEqual(-2);
  expect(stableFrame.clientRight, JSON.stringify(stableFrame)).toBeLessThanOrEqual(stableFrame.viewportWidth + 2);
}

async function assertLongContentAndTextScale(page: Page) {
  const before = await page.evaluate(() => {
    const sample = document.querySelector<HTMLElement>("h1, h2, h3, p, button");
    return sample ? Number.parseFloat(getComputedStyle(sample).fontSize) : 0;
  });
  await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>("h1, h2, h3");
    const action = document.querySelector<HTMLElement>("button, [role='button']");
    if (heading) heading.textContent = "这是来自行业投影的超长中文页面标题，需要在当前内容区域内自然换行且绝不越界";
    if (action) action.textContent = "这是来自行业投影的超长中文动态操作名称，需要在当前按钮内自然换行且绝不越界";
    document.documentElement.style.fontSize = "200%";
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const report = await page.evaluate(() => {
    const sample = document.querySelector<HTMLElement>("h1, h2, h3, p, button");
    const offenders = Array.from(document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, p, button, [role='button'], .wl-badge, .wl-status-chip, .wl-bottom-tabs__label",
    )).filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2;
    }).slice(0, 8).map((element) => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? "").trim().slice(0, 60),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    return {
      scaledFontSize: sample ? Number.parseFloat(getComputedStyle(sample).fontSize) : 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      offenders,
    };
  });
  expect(report.documentWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.viewportWidth + 2);
  expect(report.offenders, JSON.stringify(report)).toEqual([]);
  if (before > 0) expect(report.scaledFontSize).toBeGreaterThanOrEqual(before * 1.8);
}

async function attachNormalClientFrame(page: Page, testInfo: TestInfo, client: string, width: number) {
  // 首帧几何已由 assertClientFrame 独立检查；正常截图等待现有入场动画自然结束，
  // 避免把 opacity 0 的动画中段误记为主题故障，也不关闭或修改产品动画。
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document.getAnimations().filter((animation) => {
      const endTime = animation.effect?.getComputedTiming().endTime;
      return typeof endTime === "number" && Number.isFinite(endTime);
    });
    await Promise.all(animations.map(async (animation) => {
      try {
        await animation.finished;
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      }
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  if (client === "c-mobile") await assertReadableCServiceContent(page);
  await testInfo.attach(`${client}-${width}-normal`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function assertReadableCServiceContent(page: Page) {
  const report = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLButtonElement>("button.animate-fadein")];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法解析实际页面颜色");
    const hexColor = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data;
      if (rgba[3] !== 255) throw new Error(`正文颜色或卡片背景不是不透明颜色：${color}`);
      return `#${[...rgba].slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    };
    const faded = [...document.querySelectorAll<HTMLElement>(".wl-app-shell__main, .wl-app-shell__main *")]
      .filter((element) => Number.parseFloat(getComputedStyle(element).opacity) < 0.999)
      .map((element) => ({ className: element.className, opacity: getComputedStyle(element).opacity }));
    return {
      serviceHeading: document.querySelector(".wl-top-context-bar__title")?.textContent ?? "",
      faded,
      samples: cards.flatMap((card) => [...card.querySelectorAll<HTMLElement>("span:not([aria-hidden])")].map((element) => ({
        text: element.textContent ?? "",
        foreground: hexColor(getComputedStyle(element).color),
        background: hexColor(getComputedStyle(card).backgroundColor),
      }))),
    };
  });
  expect(report.faded, JSON.stringify(report)).toEqual([]);
  // 安全态可不装配服务大厅；该状态继续由原有导航、首帧与长文本断言覆盖。
  if (report.serviceHeading !== "服务大厅") return;
  expect(report.samples.length, JSON.stringify(report)).toBeGreaterThan(0);
  for (const sample of report.samples) {
    expect(colorContrastRatio(sample.foreground, sample.background), JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
  }
}

test("B 端 PC：生产登录主入口和首帧不横向溢出", async ({ page }, testInfo) => {
  await installFirstFrameProbe(page);
  await page.route("**/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("http://127.0.0.1:4310/login");
    await expect(page.getByRole("heading", { name: pcLoginHeading, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "邮箱密码" }).click();
    await expect(page.getByLabel("邮箱")).toBeVisible();
    await expect(page.getByLabel("密码")).toBeVisible();
    await assertClientFrame(page, "b-pc");
    await attachNormalClientFrame(page, testInfo, "b-pc", width);
    await assertLongContentAndTextScale(page);
  }
});

test("B 端移动：登录主入口和首帧不横向溢出", async ({ page }, testInfo) => {
  await installFirstFrameProbe(page);
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
    await page.goto("http://127.0.0.1:4311/");
    await expect(page.getByRole("heading", { name: "登录 WorkLoom" })).toBeVisible();
    await page.getByLabel("工作区识别码").fill("consumer-smoke");
    await page.getByLabel("手机号").fill("13800000000");
    await page.getByLabel("验证码").fill("123456");
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeEnabled();
    await assertClientFrame(page, "b-mobile");
    await attachNormalClientFrame(page, testInfo, "b-mobile", width);
    await assertLongContentAndTextScale(page);
  }
});

test("C 端移动：服务前台导航主流程和首帧不横向溢出", async ({ page }, testInfo) => {
  await installFirstFrameProbe(page);
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
    await page.goto("http://127.0.0.1:4312/");
    const navigation = page.getByRole("navigation", { name: "服务前台主导航" });
    await expect(navigation).toBeVisible();
    const tabs = navigation.getByRole("button");
    expect(await tabs.count()).toBeGreaterThan(1);
    // 行业投影就绪时第二项通常是服务大厅；安全态下则是工单。
    // 两者都验证真实路由切换，同时不假设行业仓必须启用某个可选入口。
    const target = tabs.nth(1);
    await target.click();
    await expect(target).toHaveAttribute("aria-current", "page");
    await assertClientFrame(page, "c-mobile");
    await attachNormalClientFrame(page, testInfo, "c-mobile", width);
    await assertLongContentAndTextScale(page);
  }
});
