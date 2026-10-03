import { logger } from "mioku";
import type { MiokuService } from "mioku";
import puppeteer, { Browser, type Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  MarkdownScreenshotOptions,
  ScreenshotOptions,
  ScreenshotService,
} from "./types";
import {
  NAV_TIMEOUT_MS,
  RenderBudget,
  trackPendingRequests,
} from "./render-budget";

/**
 * 截图服务实现
 */
class ScreenshotServiceImpl implements ScreenshotService {
  private browser: Browser | null = null;
  private readonly tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), "temp", "screenshots");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async init(): Promise<void> {
    const isWindows = process.platform === "win32";
    const isLinux = process.platform === "linux";

    let executablePath: string | undefined;
    let channel: "chrome" | undefined;

    const envExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envExecutablePath && fs.existsSync(envExecutablePath)) {
      executablePath = envExecutablePath;
    }

    if (!executablePath && isWindows) {
      // Try Edge first on Windows
      const edgePaths = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ];

      for (const p of edgePaths) {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      }

      if (!executablePath) {
        // Fallback to Chrome
        channel = "chrome";
      }
    }

    if (!executablePath && process.platform === "darwin") {
      const macPaths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];

      for (const p of macPaths) {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      }
    }

    if (!executablePath && isLinux) {
      const linuxPaths = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
      ];

      for (const p of linuxPaths) {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      }
    }

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        executablePath,
        channel,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (err) {
      // Fallback: try with default Chrome
      if (!channel && !executablePath) {
        logger.warn(
          "screenshot-service: Chrome/Edge not found, trying default...",
        );
        this.browser = await puppeteer.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
          ],
        });
      } else {
        throw err;
      }
    }
  }

  private generateId(): string {
    return crypto.randomBytes(8).toString("hex");
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isNightMode(themeMode?: "auto" | "light" | "dark"): boolean {
    if (themeMode === "dark") return true;
    if (themeMode === "light") return false;
    const hour = new Date().getHours();
    return hour >= 18 || hour < 6;
  }

  private createHtmlPage(
    htmlContent: string,
    themeMode?: "auto" | "light" | "dark",
  ): string {
    const isDark = this.isNightMode(themeMode);
    const themeClass = isDark ? "dark" : "";
    const colorScheme = isDark ? "dark" : "light";

    return `<!DOCTYPE html>
<html lang="zh-CN" class="${themeClass}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html {
      color-scheme: ${colorScheme};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;
  }

  private async gotoPage(
    page: Page,
    url: string,
    budget: RenderBudget,
    pending: () => string,
  ): Promise<void> {
    const attempts = ["networkidle0", "domcontentloaded"] as const;
    let lastErr: unknown;
    for (const waitUntil of attempts) {
      const timeout = Math.min(NAV_TIMEOUT_MS, budget.remainingMs);
      if (timeout <= 0) break;
      try {
        await page.goto(url, { waitUntil, timeout });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    const timedOut = (lastErr as Error | undefined)?.name === "TimeoutError";
    throw timedOut
      ? new Error(`页面加载超时（${NAV_TIMEOUT_MS}ms 内未完成：${pending()}）`)
      : new Error(`页面加载失败（未完成：${pending()}）: ${String(lastErr)}`);
  }

  private async waitForImages(
    page: Page,
    budget: RenderBudget,
    pending: () => string,
  ): Promise<void> {
    await budget.guard(
      page.evaluate(async () => {
        const doc = globalThis as unknown as { document?: { images?: unknown[] } };
        const images = doc.document?.images ? Array.from(doc.document.images) : [];
        await Promise.all(
          images.map((img) =>
            (img as { decode?: () => Promise<void> }).decode?.().catch(() => {}),
          ),
        );
      }),
      () => `图片解码超时（未完成：${pending()}）`,
    );
  }

  /**
   * 从 HTML 内容生成截图
   */
  async screenshot(
    htmlContent: string,
    options?: ScreenshotOptions,
  ): Promise<string> {
    if (!this.browser) {
      throw new Error("浏览器未初始化");
    }

    const page = await this.browser.newPage();
    const budget = new RenderBudget();
    const pending = trackPendingRequests(page);

    try {
      const width = options?.width || 1920;
      const height = options?.height || 1080;
      const deviceScaleFactor = options?.deviceScaleFactor ?? 1;
      await page.setViewport({ width, height, deviceScaleFactor });

      const fullHtml = this.createHtmlPage(htmlContent, options?.themeMode);
      const htmlId = this.generateId();
      const htmlPath = path.join(this.tempDir, `${htmlId}.html`);
      await fs.promises.writeFile(htmlPath, fullHtml, "utf-8");
      await this.gotoPage(page, `file://${htmlPath}`, budget, pending);
      await this.waitForImages(page, budget, pending);

      // if (options?.waitTime) {
      //   await this.delay(options.waitTime);
      // }

      const screenshotId = this.generateId();
      const screenshotPath = path.join(
        this.tempDir,
        `${screenshotId}.${options?.type || "png"}`,
      );

      await budget.guard(
        page.screenshot({
          path: screenshotPath,
          type: options?.type || "png",
          quality: options?.quality,
          fullPage: options?.fullPage ?? false,
        }),
        () => `截图写入超时（已用 ${budget.elapsedMs}ms，未完成：${pending()}）`,
      );

      try {
        await fs.promises.unlink(htmlPath);
      } catch (err) {
        // 忽略删除错误
      }

      return screenshotPath;
    } finally {
      await page.close();
    }
  }

  /**
   * 从 Markdown 内容生成截图
   */
  async screenshotMarkdown(
    markdownContent: string,
    options?: MarkdownScreenshotOptions,
  ): Promise<string> {
    const { buildMarkdownScreenshotOptions } = await import("./markdown");
    const { html, options: screenshotOptions } = buildMarkdownScreenshotOptions(
      markdownContent,
      options,
    );
    return this.screenshot(html, screenshotOptions);
  }

  /**
   * 从 URL 生成截图
   */
  async screenshotFromUrl(
    url: string,
    options?: ScreenshotOptions,
  ): Promise<string> {
    if (!this.browser) {
      throw new Error("浏览器未初始化");
    }

    const page = await this.browser.newPage();
    const budget = new RenderBudget();
    const pending = trackPendingRequests(page);

    try {
      const width = options?.width || 1920;
      const height = options?.height || 1080;
      const deviceScaleFactor = options?.deviceScaleFactor ?? 1;
      await page.setViewport({ width, height, deviceScaleFactor });

      await this.gotoPage(page, url, budget, pending);
      await this.waitForImages(page, budget, pending);

      if (options?.waitTime) {
        await this.delay(Math.min(options.waitTime, budget.remainingMs));
      }

      const screenshotId = this.generateId();
      const screenshotPath = path.join(
        this.tempDir,
        `${screenshotId}.${options?.type || "png"}`,
      );

      await budget.guard(
        page.screenshot({
          path: screenshotPath,
          type: options?.type || "png",
          quality: options?.quality,
          fullPage: options?.fullPage ?? true,
        }),
        () => `截图写入超时（已用 ${budget.elapsedMs}ms，未完成：${pending()}）`,
      );
      return screenshotPath;
    } finally {
      await page.close();
    }
  }

  /**
   * 清理临时文件
   */
  async cleanupTemp(olderThanMs: number = 3600000): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    const files = await fs.promises.readdir(this.tempDir);
    for (const file of files) {
      const filePath = path.join(this.tempDir, file);
      const stats = await fs.promises.stat(filePath);

      if (now - stats.mtimeMs > olderThanMs) {
        await fs.promises.unlink(filePath);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async dispose(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

const screenshotService: MiokuService = {
  name: "screenshot",
  api: {} as ScreenshotService,

  async init() {
    const impl = new ScreenshotServiceImpl();
    await impl.init();
    this.api = impl;
    logger.info("screenshot-service 已就绪");
  },

  async dispose() {
    if (this.api && typeof (this.api as any).dispose === "function") {
      await (this.api as any).dispose();
    }
    logger.info("screenshot-service 已卸载");
  },
};

export default screenshotService;
