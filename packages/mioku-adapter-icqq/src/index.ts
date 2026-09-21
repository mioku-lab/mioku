export { icqqAdapterDefinition } from './adapter'
export * from './bot'
export * from './captcha'
export * from './config'
export * from './event'
export * from './interact'
export * from './message'
export { icqqAdapterDefinition as default } from './adapter'

declare module 'mioku' {
  interface AdapterBotMap {
    icqq: import('./bot').IcqqBot
  }
}
