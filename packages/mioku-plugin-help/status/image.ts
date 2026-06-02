import type { MiokiContext, ScreenshotService } from "mioku";
import { checkNightMode } from "../shared";
import { collectSnapshot } from "./data-collector";
import { renderStatusHtml } from "./html-generator";
import type { StatusIntent } from "./types";

const FORCE_NIGHT_MODE = false;

const RENDER_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("status_render_timeout")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface GenerateStatusImageOptions {
  ctx: MiokiContext;
  event?: any;
  intent: StatusIntent;
  botNickname?: string;
  botAvatarUrl?: string;
}

export interface GenerateStatusImageResult {
  ok: boolean;
  imagePath?: string;
  error?: string;
}

export async function generateStatusImage(
  options: GenerateStatusImageOptions,
): Promise<GenerateStatusImageResult> {
  const { ctx, intent } = options;
  const screenshotService = ctx?.services?.screenshot as
    | ScreenshotService
    | undefined;
  if (!screenshotService) {
    return { ok: false, error: "screenshot 服务未加载" };
  }
  if (intent.type === "none") {
    return { ok: false, error: "not a status command" };
  }

  try {
    const snapshot = await collectSnapshot(ctx, {
      isNightMode: FORCE_NIGHT_MODE || checkNightMode(),
    });
    const html = renderStatusHtml(snapshot);
    const imagePath = await withTimeout(
      Promise.resolve(
        screenshotService.screenshot(html, {
          width: 760,
          height: 200,
          fullPage: true,
          type: "png",
        }),
      ),
      RENDER_TIMEOUT_MS,
    );
    if (!imagePath) {
      return { ok: false, error: "screenshot 返回空路径" };
    }
    return { ok: true, imagePath };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}
