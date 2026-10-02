import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { OneBotLink, type ApiCaller, type LinkHandlers, type LinkSocket } from "./gateway";

import type { Logger } from "mioku";

export interface OneBotServerOptions {
  readonly name?: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** 非空时校验 access_token(query 或 Authorization: Bearer) */
  readonly token?: string;
  readonly logger: Logger;
}

/** 一条已通过鉴权的待接管连接;适配器用它构造 OneBotServerSession */
export interface OneBotServerAccept {
  readonly id: string;
  readonly remote: string;
  readonly socket: LinkSocket;
  /** 未接管前直接拒绝连接 */
  close(code?: number, reason?: string): Promise<void>;
}

export interface OneBotServerHandlers {
  onAccept(accept: OneBotServerAccept): void | Promise<void>;
}

const normalizePath = (value: string): string => {
  const trimmed = value.trim() || "/onebot/v11/ws";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
};

const tokenOf = (req: IncomingMessage): string | null => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("access_token");
  if (query) return query;
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (bearer) return bearer[1].trim();
    return auth.trim();
  }
  return null;
};

const tokenEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/** ws 包 socket → LinkSocket 适配 */
class WsServerSocket implements LinkSocket {
  readonly #ws: WebSocket;

  constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  async send(data: string | Uint8Array): Promise<void> {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    await new Promise<void>((resolve, reject) => {
      this.#ws.send(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(code?: number, reason?: string): Promise<void> {
    if (this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.terminate();
      return;
    }
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.close(code ?? 1000, reason ?? "");
    }
  }

  onMessage(handler: (data: string | Uint8Array) => void): () => void {
    const listener = (data: unknown, isBinary: boolean): void => {
      if (typeof data === "string") {
        handler(data);
        return;
      }
      const buffer = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : (data as Buffer);
      handler(isBinary ? new Uint8Array(buffer) : buffer.toString("utf8"));
    };
    this.#ws.on("message", listener);
    return () => this.#ws.off("message", listener);
  }

  onClose(handler: (event: { code: number; reason: string }) => void): () => void {
    const listener = (code: number, reason: Buffer): void => {
      handler({ code, reason: reason.toString("utf8") });
    };
    this.#ws.on("close", listener);
    return () => this.#ws.off("close", listener);
  }

  onError(handler: (err: Error) => void): () => void {
    const listener = (err: Error): void => handler(err);
    this.#ws.on("error", listener);
    return () => this.#ws.off("error", listener);
  }
}

/** 反向 WS 服务端的一条接入会话:echo 关联与 API 调用 */
export class OneBotServerSession {
  readonly id: string;
  readonly remote: string;
  readonly #link: OneBotLink;

  constructor(
    id: string,
    socket: LinkSocket,
    remote: string,
    handlers: LinkHandlers,
    logger: Logger,
  ) {
    this.id = id;
    this.remote = remote;
    this.#link = new OneBotLink({ name: "onebotv11.session", logger }, handlers);
    this.#link.attach(socket);
  }

  get call(): ApiCaller {
    return this.#link.call;
  }

  async close(code = 1000, reason = ""): Promise<void> {
    this.#link.failPending(reason || "session closed");
    await this.#link.close(code, reason);
  }
}

/** 反向 WS 服务端网关:监听 HTTP 端口,在指定路径接受 OneBot 实现接入 */
export class OneBotServerGateway {
  readonly name: string;
  readonly #options: OneBotServerOptions;
  readonly #handlers: OneBotServerHandlers;
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;

  constructor(options: OneBotServerOptions, handlers: OneBotServerHandlers) {
    this.name = options.name ?? "onebotv11.server";
    this.#options = options;
    this.#handlers = handlers;
  }

  get path(): string {
    return normalizePath(this.#options.path);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const path = this.path;
    if (!this.#options.token) {
      this.#options.logger.warn(
        `反向 WS 服务端未设置访问令牌: ${this.#options.host}:${this.#options.port} 上的任意客户端均可接入`,
      );
    }
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.replace(/\/+$/, "") !== path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const expected = this.#options.token;
      if (expected) {
        const got = tokenOf(req);
        if (!got || !tokenEquals(got, expected)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          this.#options.logger.warn(
            `反向 WS 接入被拒绝: access_token 校验失败 (${req.socket.remoteAddress})`,
          );
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const accept: OneBotServerAccept = {
        id: randomUUID(),
        remote: req.socket.remoteAddress ?? "unknown",
        socket: new WsServerSocket(ws),
        close: (code, reason) => {
          return new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(code ?? 1000, reason ?? "");
            } else {
              ws.terminate();
            }
            resolve();
          });
        },
      };
      void Promise.resolve(this.#handlers.onAccept(accept)).catch((err) => {
        this.#options.logger.error(
          `反向 WS 会话接管失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        void accept.close(1011, "accept failed");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => resolve());
    });
    this.#server = server;
    this.#wss = wss;
    this.#options.logger.info(
      `反向 WS 服务端已监听 ${this.#options.host}:${this.#options.port}${path}`,
    );
  }

  /** 关闭监听;已接入的 socket 由适配器先行断开,这里兜底强断 */
  async stop(reason?: string): Promise<void> {
    const server = this.#server;
    const wss = this.#wss;
    this.#server = null;
    this.#wss = null;
    if (wss) {
      // 停机路径直接 terminate,避免等待对端完成关闭握手
      for (const client of wss.clients) {
        client.terminate();
      }
      await Promise.race([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    if (server) {
      server.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
  }
}
