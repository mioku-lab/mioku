import { definePlugin } from 'mioku'

export default definePlugin({
  name: 'demo',
  async setup(ctx) {
    ctx.logger.info('Demo 插件已加载')

    ctx.handle('message', async (e) => {
      if (e.raw_message === 'hello') {
        await e.reply('world')
      }
    })

    return () => {
      ctx.logger.info('Demo 插件已卸载')
    }
  },
})