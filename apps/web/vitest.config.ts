import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// 测试专用依赖只在 Vitest 入口加载；正式桌面 preview 不依赖 vitest。
export default mergeConfig(viteConfig, defineConfig({
  test: {
    // @workloom/ui 的无扩展名相对导入需要由 Vite 解析，不能交给 Node ESM。
    server: { deps: { inline: ["@workloom/ui"] } },
  },
}));
