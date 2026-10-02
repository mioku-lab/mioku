import { randomUUID } from "node:crypto";
import type {
  WebSocketClient,
  WebSocketConnection,
  WebSocketConnectOptions,
  Logger,
} from "mioku";

export type ApiCaller = <T = unknown>(
  action: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/** OneBot 链路对底层 socket 的最小要求；driver 连接与 ws 服务端 socket 均满足 */
export interface LinkSocket {
  send(data: string | Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  onMessage(handler: (data: string | Uint8Array) => void): () => void;
  onClose(handler: (event: { code: number; reason: string }) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
}

export interface LinkHandlers {
  onMessage(payload: unknown): void | Promise<void>;
  onClose(code: number, reason: string): void | Promise<void>;
  onError(err: Error): void | Promise<void>;
}

export interface GatewayOptions {
  readonly name?: string;
  readonly url: string;
  readonly ws: WebSocketClient;
  readonly logger: Logger;
  readonly reconnect?: boolean;
  readonly reconnectInterval?: number;
  readonly maxReconnectAttempts?: number;
  readonly maxReconnectInterval?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GatewayHandlers {
  onMessage(payload: unknown): void | Promise<void>;
  onOpen(connection: WebSocketConnection): void | Promise<void>;
  onClose(code: number, reason: string): void | Promise<void>;
  onError(err: Error): void | Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  action: string;
}

const DEFAULT_MAX_PENDING_SENDS = 64;

/**
 * 单条 OneBot WS 链路的会话：echo 关联、API 调用、payload 分发。
 * 正向网关(带重连)与反向服务端的每个接入会话共用。
 */
export class OneBotLink {
  readonly name: string;
  readonly #logger: Logger;
  readonly #handlers: LinkHandlers;
  readonly #apiCalls = new Map<string, PendingRequest>();
  readonly #requestTimeout: number;
  readonly #maxPendingSends: number;
  #socket: LinkSocket | null = null;
  /** echo → 待补发 payload，按入队顺序补发 */
  readonly #pendingSends = new Map<string, string>();
  #closeNotified = false;

  constructor(
    options: {
      name?: string;
      logger: Logger;
      requestTimeout?: number;
      maxPendingSends?: number;
    },
    handlers: LinkHandlers,
  ) {
    this.name = options.name ?? "onebotv11.link";
    this.#logger = options.logger;
    this.#handlers = handlers;
    this.#requestTimeout = options.requestTimeout ?? 30_000;
    this.#maxPendingSends = options.maxPendingSends ?? DEFAULT_MAX_PENDING_SENDS;
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /** 绑定 socket；重复调用视为重连(重新接上并补发排队请求) */
  attach(socket: LinkSocket): void {
    this.#socket = socket;
    this.#closeNotified = false;
    socket.onMessage((data) => {
      const payload = decode(data);
      if (!payload) return;
      void this.#dispatch(payload);
    });
    socket.onClose(({ code, reason }) => {
      // 旧 socket 的迟到关闭不能影响新 socket
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#closeNotified) return;
      this.#closeNotified = true;
      void this.#handlers.onClose(code, reason);
    });
    socket.onError((err) => {
      void this.#handlers.onError(err);
    });
    const queued = [...this.#pendingSends];
    this.#pendingSends.clear();
    for (const [echo, payload] of queued) {
      void this.#sendRaw(echo, payload);
    }
  }

  async close(code = 1000, reason = ""): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    await socket?.close(code, reason);
  }

  /** 使所有在途 API 调用立即失败(网关停止时) */
  failPending(reason: string): void {
    for (const [, pending] of this.#apiCalls) {
      pending.reject(new Error(reason));
    }
    this.#apiCalls.clear();
    this.#pendingSends.clear();
  }

  call: ApiCaller = <T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const echo = randomUUID();
      const timer = setTimeout(() => {
        this.#apiCalls.delete(echo);
        this.#pendingSends.delete(echo);
        reject(new Error(`API 请求超时: ${action}`));
      }, this.#requestTimeout);
      const finalize = (cb: () => void): void => {
        clearTimeout(timer);
        cb();
      };
      const wrappedResolve = (value: unknown): void => {
        finalize(() => resolve(value as T));
      };
      const wrappedReject = (reason: unknown): void => {
        finalize(() =>
          reject(reason instanceof Error ? reason : new Error(String(reason))),
        );
      };
      this.#apiCalls.set(echo, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        action,
      });
      void this.#sendApi(echo, action, params);
    });
  };

  async #sendRaw(echo: string, payload: string): Promise<void> {
    const socket = this.#socket;
    if (socket) {
      try {
        await socket.send(payload);
      } catch (err) {
        this.#logger.warn(
          `发送 API 请求失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.#queueSend(echo, payload);
      }
      return;
    }
    this.#queueSend(echo, payload);
  }

  /** 链路上限保护：队列满时丢弃最旧的请求，避免断线期间无限堆积 */
  #queueSend(echo: string, payload: string): void {
    this.#pendingSends.set(echo, payload);
    while (this.#pendingSends.size > this.#maxPendingSends) {
      const oldest = this.#pendingSends.keys().next().value;
      if (oldest === undefined) break;
      this.#pendingSends.delete(oldest);
      const pending = this.#apiCalls.get(oldest);
      if (pending) {
        this.#apiCalls.delete(oldest);
        pending.reject(new Error(`发送队列已满，请求被丢弃: ${pending.action}`));
      }
    }
  }

  async #sendApi(
    echo: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.#sendRaw(echo, JSON.stringify({ echo, action, params }));
  }

  async #dispatch(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.echo === "string") {
      const pending = this.#apiCalls.get(obj.echo);
      if (!pending) return;
      this.#apiCalls.delete(obj.echo);
      if (obj.retcode === 0) {
        pending.resolve(obj.data);
      } else {
        const retcode = typeof obj.retcode === "number" ? obj.retcode : -1;
        const msg =
          typeof obj.message === "string"
            ? obj.message
            : `API error: ${retcode}`;
        const err = new Error(`[retcode=${retcode}] ${msg}`) as Error & {
          retcode: number;
          action: string;
        };
        err.retcode = retcode;
        err.action = pending.action;
        pending.reject(err);
      }
      return;
    }
    await this.#handlers.onMessage(obj);
  }
}

/** 正向 WS 网关：出站连接 + 指数退避重连，链路复用 OneBotLink */
export class OneBotWebSocketGateway {
  readonly name: string;
  readonly #options: GatewayOptions;
  readonly #handlers: GatewayHandlers;
  readonly #link: OneBotLink;
  #reconnectAttempts = 0;
  #reconnecting = false;
  #manualClose = false;

  constructor(options: GatewayOptions, handlers: GatewayHandlers) {
    this.name = options.name ?? "onebotv11.websocket";
    this.#options = options;
    this.#handlers = handlers;
    this.#link = new OneBotLink(
      { name: this.name, logger: options.logger },
      {
        onMessage: (payload) => this.#handlers.onMessage(payload),
        onClose: (code, reason) => {
          void this.#handlers.onClose(code, reason);
          if (!this.#manualClose && (this.#options.reconnect ?? true)) {
            this.#scheduleReconnect();
          }
        },
        onError: (err) => this.#handlers.onError(err),
      },
    );
  }

  get url(): string {
    return this.#options.url;
  }

  async start(): Promise<void> {
    this.#manualClose = false;
    await this.#connectOnce();
  }

  async #connectOnce(): Promise<void> {
    const opts: WebSocketConnectOptions = {
      headers: this.#options.headers,
    };
    const connection = await this.#options.ws.connect(this.#options.url, opts);
    this.#reconnectAttempts = 0;
    this.#reconnecting = false;
    this.#link.attach(connection);
    await this.#handlers.onOpen(connection);
  }

  #scheduleReconnect(): void {
    const {
      reconnectInterval = 1000,
      maxReconnectAttempts = Infinity,
      maxReconnectInterval = 30_000,
    } = this.#options;
    if (this.#reconnectAttempts >= maxReconnectAttempts) {
      this.#options.logger.error(`已达到最大重连次数 ${maxReconnectAttempts}`);
      return;
    }
    this.#reconnecting = true;
    this.#reconnectAttempts += 1;
    const delay = Math.min(
      reconnectInterval * Math.pow(2, this.#reconnectAttempts - 1),
      maxReconnectInterval,
    );
    this.#options.logger.info(
      `将在 ${delay}ms 后尝试第 ${this.#reconnectAttempts} 次重连`,
    );
    setTimeout(() => {
      void this.#connectOnce().catch((err) => {
        this.#options.logger.warn(
          `重连失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.#scheduleReconnect();
      });
    }, delay);
  }

  async stop(reason?: string): Promise<void> {
    this.#manualClose = true;
    this.#link.failPending(reason ?? "Gateway stopped");
    await this.#link.close(1000, reason ?? "");
  }

  call: ApiCaller = <T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    return this.#link.call<T>(action, params);
  };
}

const decode = (raw: string | Uint8Array): unknown => {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
