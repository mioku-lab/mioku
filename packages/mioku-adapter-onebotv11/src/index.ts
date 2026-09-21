export { oneBotAdapterDefinition, buildNoticeFromOneBot } from './adapter'
export * from './bot'
export * from './config'
export * from './event'
export * from './gateway'
export * from './message'
export * from './status'

export { oneBotAdapterDefinition as default } from './adapter'

declare module 'mioku' {
  interface AdapterBotMap {
    onebotv11: import('./bot').OneBot
  }
}
