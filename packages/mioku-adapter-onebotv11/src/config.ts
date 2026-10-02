export interface OneBotAdapterConfig {
  /** 正向连接实例:适配器主动连接 OneBot 实现(可多个) */
  instances: ReadonlyArray<OneBotInstanceConfig>
  /** 反向连接服务器:适配器监听,OneBot 实现接入(最多一个) */
  server: OneBotServerConfig
}

export interface OneBotInstanceConfig {
  protocol?: 'ws' | 'wss'
  host?: string
  port?: number
  token?: string
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
  maxReconnectInterval?: number
  headers?: Readonly<Record<string, string>>
}

export interface OneBotServerConfig {
  enabled: boolean
  listenHost: string
  listenPort: number
  path: string
  token: string
}

export const DEFAULT_INSTANCE: Required<Omit<OneBotInstanceConfig, 'token' | 'headers'>> = {
  protocol: 'ws',
  host: 'localhost',
  port: 3001,
  reconnect: true,
  reconnectInterval: 1000,
  maxReconnectAttempts: Infinity,
  maxReconnectInterval: 30_000,
}

export const DEFAULT_SERVER: OneBotServerConfig = {
  enabled: false,
  listenHost: '0.0.0.0',
  listenPort: 3939,
  path: '/onebot/v11/ws',
  token: '',
}

export const normalizeServerConfig = (input: unknown): OneBotServerConfig => {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const enabled = raw.enabled === true
  const port = Number(raw.listenPort)
  if (
    enabled &&
    raw.listenPort != null &&
    (!Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error(`onebotv11.server.listenPort 非法: ${String(raw.listenPort)}`)
  }
  return {
    enabled,
    listenHost:
      typeof raw.listenHost === 'string' && raw.listenHost.trim()
        ? raw.listenHost.trim()
        : DEFAULT_SERVER.listenHost,
    listenPort: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_SERVER.listenPort,
    path:
      typeof raw.path === 'string' && raw.path.trim()
        ? raw.path.trim()
        : DEFAULT_SERVER.path,
    token: typeof raw.token === 'string' ? raw.token : DEFAULT_SERVER.token,
  }
}

export const normalizeInstances = (input: unknown): OneBotInstanceConfig[] => {
  if (!input) return []
  if (Array.isArray(input)) {
    if (input.length === 0) return []
    if (typeof input[0] === 'object') {
      return input as OneBotInstanceConfig[]
    }
    return []
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    if (Array.isArray(obj.instances)) return obj.instances as OneBotInstanceConfig[]
    if ('protocol' in obj || 'host' in obj || 'port' in obj) {
      return [obj as OneBotInstanceConfig]
    }
  }
  return []
}
