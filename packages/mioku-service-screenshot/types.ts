/**
 * 截图选项
 */
export interface ScreenshotOptions {
  // 视图宽度
  width?: number;
  // 视图高度
  height?: number;
  // 是否截取完整页面
  fullPage?: boolean;
  // 图片质量 1-100
  quality?: number;
  // 输出图片格式
  type?: "png" | "jpeg" | "webp";
  // 超时时间
  waitTime?: number;
  // 主题模式，默认 auto（按时间自动切换）
  themeMode?: "auto" | "light" | "dark";
}

export interface MarkdownScreenshotOptions extends ScreenshotOptions {
  // 主题模式，默认 auto（按时间自动切换）
  themeMode?: "auto" | "light" | "dark";
}

/**
 * 截图服务接口
 */
export interface ScreenshotService {
  // 截图
  screenshot(htmlContent: string, options?: ScreenshotOptions): Promise<string>;
  // 从 Markdown 渲染截图
  screenshotMarkdown(
    markdownContent: string,
    options?: MarkdownScreenshotOptions,
  ): Promise<string>;
  // 从URL截图
  screenshotFromUrl(url: string, options?: ScreenshotOptions): Promise<string>;
  // 清除缓存
  cleanupTemp(olderThanMs?: number): Promise<number>;
}
