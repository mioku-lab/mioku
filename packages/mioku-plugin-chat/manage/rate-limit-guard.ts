import type { RateLimiter } from "./rate-limiter";

const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

type Logger = { warn: (...args: unknown[]) => void };

function isRateLimitError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const s = String(err).toLowerCase();
  return s.includes("429") || s.includes("rate limit") || s.includes("rate_limit");
}

async function retryOn429<T>(
  fn: () => Promise<T>,
  log: Logger,
  label?: string,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      if (attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw err;
      const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      const attemptLabel = `${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length}`;
      log.warn(
        `[Chat]${label ? ` ${label}` : ""} 命中 429，等待 ${delay / 1000}s 后第 ${attemptLabel} 次重试: ${err}`,
      );
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class RateLimitGuard {
  private blockedUntil = 0;

  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly log: Logger,
  ) {}

  isBlocked(): boolean {
    return Date.now() < this.blockedUntil;
  }

  private markBlocked(): void {
    this.blockedUntil = Date.now() + RATE_LIMIT_RETRY_DELAYS_MS[0];
  }

  async run<T>(
    request: () => Promise<T>,
    opts?: {
      userId?: string;
      groupId?: string;
      label?: string;
      skipRetryOnRateLimit?: boolean;
    },
  ): Promise<T | null> {
    if (this.isBlocked()) {
      this.log.warn(
        `[Chat] AI request skipped due to rate limit block${opts?.label ? ` (${opts.label})` : ""}`,
      );
      return null;
    }
    if (!this.rateLimiter.canRunAIRequest(opts?.userId, opts?.groupId)) {
      this.log.warn(
        `[Chat] AI request skipped due to RPM limit${opts?.label ? ` (${opts.label})` : ""}`,
      );
      return null;
    }
    this.rateLimiter.recordAIRequest(opts?.userId, opts?.groupId);

    if (opts?.skipRetryOnRateLimit) {
      return await request();
    }

    try {
      return await retryOn429(request, this.log, opts?.label);
    } catch (err) {
      this.markBlocked();
      throw err;
    }
  }
}