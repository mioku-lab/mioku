import { definePlugin } from 'mioku'

export default definePlugin({
  name: 'demo',
  async setup(ctx) {
    ctx.logger.info('Demo 插件已加载')

    ctx.command({
      name: 'hello',
      aliases: ['你好'],
      description: '打招呼',
      handler: async ({ event }) => {
        await event.reply('world')
      },
    })

    return () => {
      ctx.logger.info('Demo 插件已卸载')
    }
  },
})
