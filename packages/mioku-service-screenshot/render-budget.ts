import type { Page } from "puppeteer";

/** 单次导航上限，含等待外部资源 */
export const NAV_TIMEOUT_MS = 8_000;

/** 单张图的总预算，必须小于调用方的兜底超时 */
export const RENDER_BUDGET_MS = 10_000;

/** 最大的未完成资源条数，超出的只报数量 */
const MAX_REPORTED_REQUESTS = 3;

export class RenderBudget {
  private readonly deadline: number;

  constructor(readonly totalMs: number = RENDER_BUDGET_MS) {
    this.deadline = Date.now() + totalMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  get elapsedMs(): number {
    return this.totalMs - this.remainingMs;
  }

  /** 把一步的等待收进剩余预算，超时用 `describe()` 生成原因 */
  async guard<T>(step: Promise<T>, describe: () => string): Promise<T> {
    const ms = this.remainingMs;
    if (ms <= 0) {
      throw new Error(describe());
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        step,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(describe())), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 追踪页面上未结束的外部请求，超时时用来指名道姓 */
export function trackPendingRequests(page: Page): () => string {
  const pending = new Map<string, number>();

  const add = (url: string) => {
    if (!url.startsWith("file:")) {
      pending.set(url, (pending.get(url) ?? 0) + 1);
    }
  };
  const remove = (url: string) => {
    const count = pending.get(url);
    if (count === undefined) return;
    if (count <= 1) pending.delete(url);
    else pending.set(url, count - 1);
  };

  page.on("request", (req) => add(req.url()));
  page.on("requestfinished", (req) => remove(req.url()));
  page.on("requestfailed", (req) => remove(req.url()));

  return () => {
    const urls = [...pending.keys()];
    if (urls.length === 0) {
      return "无未完成的外部资源，页面本身渲染过慢";
    }
    const shown = urls.slice(0, MAX_REPORTED_REQUESTS).join("、");
    return urls.length > MAX_REPORTED_REQUESTS
      ? `${shown} 等 ${urls.length} 个外部资源`
      : shown;
  };
}
