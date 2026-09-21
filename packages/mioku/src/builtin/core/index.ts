import { version } from '../../../package.json' with { type: 'json' }
import { definePlugin } from '../../plugin'
import { createCmd, dedent, unique } from '../../utils'
import { isEventMaster, isEventOwnerOrAdmin } from '../../runtime/mioku-context'
import { getService } from '../../services/define'
import { Services } from '../../services/builtin'
import { rootLogger as logger } from '../../logger'
import {
  getPluginMetadataList,
  setPluginMetadata,
} from '../../runtime/plugin-metadata'
import { getPluginRuntimeState, setPluginRuntimeState } from '../../runtime/plugin-state'
import { buildMiokuStatus, formatMiokuStatus } from './status'
import { buildAdapterReport, collectBotStats, formatAdapterReport } from './adapters'
import {
  CORE_DEFAULT_CONFIG,
  cloneConfig,
  normalizeCoreConfig,
  type CorePluginConfig,
} from './config'
import { ensureAccessControlConfig } from './access/access-store'
import { normalizeAccessConfig } from './access/access-config'
import { matchMessageCommands } from './access/matcher'
import { registerLikeCommand } from './commands/like'
import { registerMinMemberCheck } from './commands/min-member'
import { registerUpdateCommands } from './commands/update'
import { registerInstallCommands } from './commands/install'
import { registerMarketCommands } from './commands/market'
import { registerRestartCommand } from './commands/restart'
import { registerLogCommand } from './commands/log'
import { registerAutoApprove } from './commands/auto-approve'
import {
  cleanupStaleRestartScripts,
  consumeRestartMarker,
  notifyRestartComplete,
} from './system/restart'
import { startAutoUpdateScheduler } from './system/auto-update'

import type { Adapter, MessageSegment } from '../../adapter'
import type { MessageEvent } from '../../adapter'
import type { AccessHook, AccessControlConfig, PluginHelp, PluginMetadata } from '../../types'
import type { MiokuStatus } from './status'
import type { StatusProvider } from './adapters'
import type { MiokuPlugin } from '../../plugin'
import type { MiokuContext } from '../../runtime/mioku-context'

export type { MiokuStatus } from './status'
export type { StatusProvider } from './adapters'

export const CORE_PLUGINS = ['mioku-core']

type AdapterEntry = {
  name: string
  version?: string
  impl?: { name: string; version?: string }
}

export const formatMiokuStatusFn = formatMiokuStatus

function escapeRegExp(value: string): string {
  return value.replace(/[-_.^$?[\]{}()|\\]/g, '\\$&')
}

const CORE_HELP_ENTRIES: ReadonlyArray<readonly [cmd: string, desc: string]> = [
  ['help', '显示帮助信息'],
  ['status', '显示框架状态'],
  ['adapter', '显示适配器与连接实例'],
  ['plugin', '插件管理'],
  ['settings', '框架设置管理'],
  ['update', '检查并选择插件/服务更新'],
  ['install', '从 npm 安装插件/服务'],
  ['uninstall', '卸载插件/服务'],
  ['plugin-market', '查看插件市场'],
  ['service-market', '查看服务市场'],
  ['restart', '重启机器人进程'],
  ['log', '查看最近100条日志'],
  ['exit', '退出框架进程'],
]

function displayWidth(value: string): number {
  let width = 0
  for (const ch of value) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  }
  return width
}

function padColumn(value: string, width: number): string {
  const gap = width - displayWidth(value)
  if (gap <= 0) return value
  // 只用全角空格（固定 2 格宽）；半角空格在 QQ 字体里几乎不占宽，会导致错位
  return value + '　'.repeat(Math.ceil(gap / 2))
}

function buildCoreHelpText(displayPrefix: string): string {
  const cmds = CORE_HELP_ENTRIES.map(([cmd]) => `${displayPrefix}${cmd}`)
  const cmdWidth = Math.max(...cmds.map(displayWidth))
  const lines = CORE_HELP_ENTRIES.map(
    ([cmd, desc], i) => `${padColumn(cmds[i], cmdWidth)}　${desc}`,
  )
  return ['〓 💡 Mioku 帮助 〓', ...lines].join('\n')
}

function buildCoreMetadata(
  ctx: MiokuContext,
  displayPrefix: string,
  likeKeyword: string,
): PluginMetadata {
  const esc = escapeRegExp(displayPrefix)
  const ownerHelp = (cmd: string, desc: string): PluginHelp['commands'][number] => ({
    cmd: `${displayPrefix}${cmd}`,
    desc,
    role: 'master',
  })

  const help: PluginHelp = {
    title: '系统',
    description: 'Mioku 内置核心插件：系统命令与管理功能',
    commands: CORE_HELP_ENTRIES.map(([cmd, desc]) => ownerHelp(cmd, desc)),
  }

  const accessHooks: AccessHook[] = [
    { id: 'like', match: likeKeyword, description: '匹配赞我指令关键字' },
    { id: 'help', match: `/^${esc}(help|帮助)$/`, description: '匹配帮助指令' },
    { id: 'status', match: `/^${esc}(status|状态)$/`, description: '匹配状态指令' },
    { id: 'adapter', match: `/^${esc}(adapter|适配器)$/`, description: '匹配适配器指令' },
    { id: 'plugin', match: `/^${esc}(plugin|插件)/`, description: '匹配插件管理指令' },
    { id: 'settings', match: `/^${esc}(settings|设置)/`, description: '匹配设置管理指令' },
    { id: 'update', match: `/^${esc}(update|更新)/`, description: '匹配更新指令' },
    { id: 'install', match: `/^${esc}(install|安装)/`, description: '匹配安装指令' },
    { id: 'uninstall', match: `/^${esc}(uninstall|卸载)/`, description: '匹配卸载指令' },
    {
      id: 'market',
      match: `/^${esc}(plugin-market|service-market|插件市场|服务市场)$/`,
      description: '匹配插件/服务市场指令',
    },
    { id: 'restart', match: `/^${esc}(restart|重启)$/`, description: '匹配重启指令' },
    { id: 'log', match: `/^${esc}(log|日志)$/`, description: '匹配日志指令' },
    { id: 'exit', match: `/^${esc}(exit|退出)$/`, description: '匹配退出指令' },
  ]

  return {
    name: 'core',
    version,
    description: 'mioku 内置核心插件',
    path: '',
    packageJson: {},
    config: { help, accessHooks },
  }
}

const core: MiokuPlugin = definePlugin({
  name: 'mioku-core',
  version,
  priority: -Infinity,
  description: 'mioku 内置核心插件',
  async setup(ctx: MiokuContext) {
    const rawPrefix = ctx.config.prefix ?? '.'
    const displayPrefix = rawPrefix
    const statusAdminOnly = ctx.config.status_permission === 'admin-only'

    logger.info('========================================')
    logger.info('          Mioku 正在引导服务...')
    logger.info('========================================')

    const disposers: Array<() => void> = []
    const configService = getService(ctx, Services.Config)

    let baseConfig: CorePluginConfig = cloneConfig(CORE_DEFAULT_CONFIG)
    if (configService) {
      await configService.registerConfig('core', 'base', baseConfig)
      const nextConfig = await configService.getConfig('core', 'base')
      if (nextConfig) {
        baseConfig = normalizeCoreConfig(nextConfig)
      }
      disposers.push(
        configService.onConfigChange('core', 'base', (next) => {
          baseConfig = normalizeCoreConfig(next)
        }),
      )
    } else {
      ctx.logger.warn('config-service 未加载，core 插件将使用默认配置')
    }

    let accessRules: AccessControlConfig = ensureAccessControlConfig()
    ctx.commands.setAccessControl(accessRules)
    if (configService) {
      await configService.registerConfig('core', 'access-control', accessRules)
      const persisted = await configService.getConfig('core', 'access-control')
      if (persisted) {
        accessRules = normalizeAccessConfig(persisted)
        ctx.commands.setAccessControl(accessRules)
      }
      disposers.push(
        configService.onConfigChange('core', 'access-control', (next) => {
          accessRules = normalizeAccessConfig(next)
          ctx.commands.setAccessControl(accessRules)
        }),
      )
    }
    logger.info(`访问控制已挂载: ${ctx.bots.length} 个 bot`)

    setPluginMetadata(
      buildCoreMetadata(ctx, displayPrefix, String(baseConfig.likeCommand.keyword || '赞我')),
    )

    const coreState = getPluginRuntimeState('core')
    coreState.matchMessageCommands = (text: string) =>
      matchMessageCommands(getPluginMetadataList(), text)
    setPluginRuntimeState('core', coreState)

    cleanupStaleRestartScripts()
    const restartMarker = consumeRestartMarker()
    if (restartMarker) {
      notifyRestartComplete(ctx, restartMarker).catch((err) => {
        ctx.logger.error(`[core] 重启完成通知失败: ${err}`)
      })
    }

    disposers.push(registerLikeCommand(ctx, () => baseConfig))
    disposers.push(registerAutoApprove(ctx, () => baseConfig))
    disposers.push(registerMinMemberCheck(ctx, () => baseConfig))
    disposers.push(registerUpdateCommands(ctx))
    disposers.push(registerInstallCommands(ctx))
    disposers.push(registerMarketCommands(ctx))
    disposers.push(registerRestartCommand(ctx))
    disposers.push(registerLogCommand(ctx))
    disposers.push(
      startAutoUpdateScheduler(
        baseConfig.autoUpdate.enabled,
        baseConfig.autoUpdate.time,
        baseConfig.autoUpdate.frequency,
      ),
    )

    const collectBots = (): typeof ctx.bots => ctx.bots
    /** 已加载的适配器优先，再补上只在 bot 上出现过的适配器名 */
    const collectAdapters = (): AdapterEntry[] => {
      const describe = (name: string, adapter?: Adapter): AdapterEntry => ({
        name,
        version: adapter?.version,
        impl: adapter?.impl ? { name: adapter.impl.name, version: adapter.impl.version } : undefined,
      })
      const list = ctx.adapters.map((adapter) => describe(adapter.name, adapter))
      const seen = new Set(list.map((adapter) => adapter.name))
      for (const bot of ctx.bots) {
        const name = String(bot.adapter)
        if (seen.has(name)) continue
        seen.add(name)
        list.push(describe(name, ctx.getAdapter(name)))
      }
      return list
    }

    const getStatus = async (): Promise<MiokuStatus> => {
      const enabled = ctx.plugins.list().length
      const total = ctx.plugins.list().length + ctx.plugins.localPlugins().length
      const bots = collectBots()
      const botStats = bots.length
        ? collectBotStats(await buildAdapterReport({ bots, adapters: collectAdapters() }))
        : undefined
      return await buildMiokuStatus({
        bots,
        botStats,
        enabledPlugins: enabled,
        totalPlugins: total,
      })
    }

    const getAdapterText = async (): Promise<string> =>
      formatAdapterReport(await buildAdapterReport({ bots: collectBots(), adapters: collectAdapters() }))

    ctx.command({
      name: "help",
      aliases: ["帮助"],
      permission: "master",
      priority: -1000,
      description: "显示帮助信息",
      handler: async ({ event }) => {
        await event.reply(buildCoreHelpText(displayPrefix))
      },
    })
    ctx.command({
      name: "status",
      aliases: ["状态"],
      priority: -1000,
      description: "显示框架状态",
      handler: async ({ event }) => {
        if (statusAdminOnly && !isEventOwnerOrAdmin(event)) return
        await event.reply(await formatMiokuStatus(await getStatus()))
      },
    })
    ctx.command({
      name: "adapter",
      aliases: ["适配器"],
      priority: -1000,
      description: "显示适配器与连接实例",
      handler: async ({ event }) => {
        if (statusAdminOnly && !isEventOwnerOrAdmin(event)) return
        await event.reply(await getAdapterText())
      },
    })

    const atTarget = (event: MessageEvent): string | undefined => {
      const at = event.message.find((seg): seg is MessageSegment & { data: Record<string, unknown> } => seg.type === 'at')
      const qq = at?.data?.qq ?? at?.data?.target
      return qq != null ? String(qq) : undefined
    }

    const handleCoreMessage = async (event: MessageEvent) => {
        const ev = event as MessageEvent
        const text = ev.message.text()
        const currentPrefix = String(ctx.config.prefix ?? '.')
        const currentCmdPrefix = new RegExp(`^${escapeRegExp(currentPrefix)}`)

        if (!currentCmdPrefix.test(text)) return

        if (statusAdminOnly && !isEventOwnerOrAdmin(ev)) return

        const bare = text.replace(currentCmdPrefix, '').trim()

        if (bare === '状态' || bare === 'status') {
          await ev.reply(await formatMiokuStatus(await getStatus()))
          return
        }

        if (bare === '适配器' || bare === 'adapter') {
          await ev.reply(await getAdapterText())
          return
        }

        if (!isEventMaster(ev)) return

        const { cmd, params } = createCmd(text)
        if (!cmd) return

        const subCmd = cmd.replace(currentCmdPrefix, '').replace(/\s+/g, '')
        const target = params[0]

        switch (subCmd) {
          case 'help':
          case '帮助': {
            await ev.reply(buildCoreHelpText(displayPrefix))
            break
          }

          case 'plugin':
          case '插件': {
            if (CORE_PLUGINS.includes(target)) {
              await ev.reply('内置插件无法操作')
              return
            }

            switch (target) {
              case 'list':
              case '列表': {
                const enabled = ctx.plugins.list()
                const plugins = unique([...ctx.plugins.localPlugins(), ...enabled.map((e) => e.name)])
                  .map((name) => {
                    const entry = enabled.find((e) => e.name === name)
                    const tag = entry ? '🟢' : '🔴'
                    const type = entry?.type === 'builtin' ? '[内置]' : '[用户]'
                    return `${tag} ${type} ${name}`
                  })
                  .sort((pre, next) => {
                    const weight = (str: string): number => {
                      let w = 0
                      if (str.includes('🟢')) w += 10
                      if (str.includes('[内置]')) w += 1
                      return w
                    }
                    return weight(next) - weight(pre) || pre.localeCompare(next)
                  })

                await ev.reply(
                  dedent(`
                    〓 插件列表 〓
                    ${plugins.join('\n')}
                    共 ${plugins.length} 个，启用 ${enabled.length} 个
                  `).trim(),
                )
                break
              }

              case 'enable':
              case '启用': {
                const pluginName = params[1]
                if (!pluginName) {
                  await ev.reply('请指定插件 ID')
                  return
                }
                try {
                  await ctx.plugins.enable(pluginName)
                } catch (err) {
                  await ev.reply(`插件 ${pluginName} 启用失败：${err instanceof Error ? err.message : '未知错误'}`)
                  return
                }
                await ctx.updateConfig((c) => {
                  c.plugins = [...c.plugins, pluginName]
                })
                await ev.reply(`插件 ${pluginName} 启用成功`)
                break
              }

              case 'disable':
              case '禁用': {
                const pluginName = params[1]
                if (!pluginName) {
                  await ev.reply('请指定插件 ID')
                  return
                }
                try {
                  await ctx.plugins.disable(pluginName)
                } catch (err) {
                  await ev.reply(err instanceof Error ? err.message : String(err))
                  return
                }
                await ctx.updateConfig((c) => {
                  c.plugins = c.plugins.filter((name) => name !== pluginName)
                })
                await ev.reply(`插件 ${pluginName} 已禁用`)
                break
              }

              case 'reload':
              case '重载': {
                const pluginName = params[1]
                if (!pluginName) {
                  await ev.reply('请指定插件 ID')
                  return
                }
                try {
                  await ctx.plugins.reload(pluginName)
                } catch (err) {
                  await ev.reply(err instanceof Error ? err.message : String(err))
                  return
                }
                await ctx.updateConfig((c) => {
                  c.plugins = [...c.plugins, pluginName]
                })
                await ev.reply(`插件 ${pluginName} 已重载`)
                break
              }

              default: {
                await ev.reply(
                  dedent(`
                    〓 🧩 mioku 插件 〓
                    ${displayPrefix}plugin list
                    ${displayPrefix}plugin enable <ID>
                    ${displayPrefix}plugin disable <ID>
                    ${displayPrefix}plugin reload <ID>
                  `).trim(),
                )
                break
              }
            }
            break
          }

          case 'settings':
          case '设置': {
            const action = target
            switch (action) {
              case 'detail':
              case '详情': {
                await ev.reply(
                  dedent(`
                    〓 设置详情 〓
                    主人: ${ctx.config.owners.join(', ') || '(无)'}
                    管理: ${ctx.config.admins.join(', ') || '(无)'}
                    启用插件: ${ctx.config.plugins.join(', ') || '(无)'}
                  `).trim(),
                )
                break
              }

              case 'add-owner':
              case '加主人':
              case '添加主人': {
                const uid = params[1] ?? atTarget(ev)
                if (!uid) {
                  await ev.reply('请指定主人 QQ/AT')
                  return
                }
                const userId = String(uid)
                if (ctx.config.owners.includes(userId)) {
                  await ev.reply(`主人 ${uid} 已存在`)
                  return
                }
                await ctx.updateConfig((c) => {
                  c.owners = [...c.owners, userId]
                })
                await ev.reply(`已添加主人 ${uid}`)
                break
              }

              case 'remove-owner':
              case '删主人':
              case '删除主人': {
                const uid = params[1] ?? atTarget(ev)
                if (!uid) {
                  await ev.reply('请指定主人 QQ/AT')
                  return
                }
                const userId = String(uid)
                if (userId === ctx.config.owners[0]) {
                  await ev.reply('不能删除第一主人')
                  return
                }
                if (!ctx.config.owners.includes(userId)) {
                  await ev.reply(`主人 ${uid} 不存在`)
                  return
                }
                await ctx.updateConfig((c) => {
                  c.owners = c.owners.filter((id) => id !== userId)
                })
                await ev.reply(`已删除主人 ${uid}`)
                break
              }

              case 'add-admin':
              case '加管理':
              case '添加管理': {
                const uid = params[1] ?? atTarget(ev)
                if (!uid) {
                  await ev.reply('请指定管理 QQ/AT')
                  return
                }
                const userId = String(uid)
                if (ctx.config.admins.includes(userId)) {
                  await ev.reply(`管理 ${uid} 已存在`)
                  return
                }
                await ctx.updateConfig((c) => {
                  c.admins = [...c.admins, userId]
                })
                await ev.reply(`已添加管理 ${uid}`)
                break
              }

              case 'remove-admin':
              case '删管理':
              case '删除管理': {
                const uid = params[1] ?? atTarget(ev)
                if (!uid) {
                  await ev.reply('请指定管理 QQ/AT')
                  return
                }
                const userId = String(uid)
                if (!ctx.config.admins.includes(userId)) {
                  await ev.reply(`管理 ${uid} 不存在`)
                  return
                }
                await ctx.updateConfig((c) => {
                  c.admins = c.admins.filter((id) => id !== userId)
                })
                await ev.reply(`已删除管理 ${uid}`)
                break
              }

              default: {
                await ev.reply(
                  dedent(`
                    〓 ⚙️ mioku 设置 〓
                    ${displayPrefix}settings detail
                    ${displayPrefix}settings [add-owner|remove-owner] <QQ/AT>
                    ${displayPrefix}settings [add-admin|remove-admin] <QQ/AT>
                  `).trim(),
                )
                break
              }
            }
            break
          }

          case 'exit':
          case '退出': {
            await ev.reply('またね～')
            ctx.logger.info('接收到退出指令，即将退出... 如需自动重启，请使用 pm2 部署。')
            process.exit(0)
          }
        }
    }

    for (const command of [
      { name: 'plugin', aliases: ['插件'], description: '插件管理' },
      { name: 'settings', aliases: ['设置'], description: '框架设置管理' },
      { name: 'exit', aliases: ['退出'], description: '退出框架进程' },
    ]) {
      ctx.command({
        ...command,
        permission: 'master',
        priority: -1000,
        handler: ({ event }) => handleCoreMessage(event),
      })
    }

    logger.info('========================================')
    logger.info('          Mioku 服务初始化完成')
    logger.info('========================================')

    return async () => {
      for (const dispose of disposers) {
        dispose()
      }

      logger.info('正在关闭 Mioku...')
    }
  },
})

export default core
export { buildMiokuStatus, formatMiokuStatus } from './status'
export { buildAdapterReport, collectBotStats, formatAdapterReport, registerStatusProvider } from './adapters'
