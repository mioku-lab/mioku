import { definePlugin } from 'mioku'

export default definePlugin({
  name: 'demo',
  version: '1.0.0',
  async setup(ctx) {
    ctx.logger.info('Demo 插件已加载')

    // 处理所有消息
    ctx.handle('message', async (e: any) => {
      if (e.raw_message === 'hello') {
        await e.reply('world')
      }
    })

    return () => {
      ctx.logger.info('Demo 插件已卸载')
    }
  },
})