#!/usr/bin/env node

import fs from 'node:fs'
import { execSync } from 'node:child_process'
import mri from 'mri'
import path from 'node:path'
import dedent from 'dedent'
import consola from 'consola'
import { version } from '../package.json'

const args = process.argv.slice(2)

interface CliOptions {
  name?: string
  protocol?: string
  host?: string
  port?: number
  token?: string
  prefix?: string
  owners?: string
  admins?: string
  help?: boolean
  version?: boolean
  'use-npm-mirror'?: boolean
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd} > /dev/null 2>&1`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function ensurePackageManager(pm: string) {
  if (commandExists(pm)) return pm

  if (pm === 'bun') {
    console.log('安装 bun...')
    execSync('npm install -g bun', { stdio: 'inherit' })
    return 'bun'
  }

  if (pm === 'pnpm') {
    console.log('pnpm 未安装，正在安装...')
    execSync('npm install -g pnpm', { stdio: 'inherit' })
    return 'pnpm'
  }

  if (pm === 'npm') {
    return 'npm'
  }

  return pm
}

async function selectPackageManager(): Promise<string> {
  const choices = ['bun', 'npm', 'pnpm']

  const result = await consola.prompt('选择包管理器 (默认 bun)', {
    type: 'text',
    default: 'bun',
  })

  const normalized = result.toString().trim().toLowerCase()
  if (choices.includes(normalized)) {
    return normalized
  }
  return 'bun'
}

;(async () => {
  const cli = mri<CliOptions>(args, {
    alias: {
      v: 'version',
      h: 'help',
    },
  })

  const helpInfo = dedent(
    `
  mioku 命令行工具 v${version}

  用法: mioku <命令> [选项]

  选项:
  -h, --help              显示帮助信息
  -v, --version           显示版本号

  --name <name>           指定项目/文件夹名称，默认 mioku-bot
  --protocol <protocol>   指定 NapCat 协议，默认 ws
  --host <host>           指定 NapCat 主机，默认 localhost
  --port <port>           指定 NapCat 端口，默认 3001
  --token <token>         指定 NapCat 连接 Token，默认空
  --prefix <prefix>       指定命令前缀，默认 #
  --owners <owners>       指定主人 QQ，英文逗号分隔，必填
  --admins <admins>       指定管理员 QQ，英文逗号分隔，可空
  --use-npm-mirror        使用 npm 镜像源加速依赖安装，默认否
`,
  )

  switch (true) {
    case cli.version:
      console.log(`v${version}`)
      process.exit(0)

    case cli.help:
      console.log(helpInfo)
      process.exit(0)
  }

  let {
    name = await input('请输入项目名称', { default: 'mioku-bot', placeholder: 'mioku-bot', required: true }),
    owners = await input('请输入主人 QQ (最高权限，英文逗号分隔，必填)', {
      placeholder: '请输入',
      default: '',
      required: true,
    }),
    token,
    protocol,
    host,
    port,
    prefix,
    admins,
    'use-npm-mirror': useNpmMirror,
  } = cli

  if (name && owners) {
    protocol ||= 'ws'
    host ||= 'localhost'
    port ||= 3001
    token ||= ''
    prefix ||= '#'
    admins ||= ''
    useNpmMirror ??= false
  } else {
    token ||= await input('请输入 NapCat WS Token', { default: '', placeholder: '请输入' })
    protocol ||= await input('请输入 NapCat WS 协议', { default: 'ws', placeholder: 'ws', required: true })
    host ||= await input('请输入 NapCat WS 主机', { default: 'localhost', placeholder: 'localhost', required: true })
    port ||= parseInt(await input('请输入 NapCat WS 端口', { default: '3001', placeholder: '3001', required: true }))
    prefix ||= await input('请输入消息命令前缀', { default: '#', placeholder: '#', required: true })
    admins ||= (await input('请输入管理员 QQ (插件权限，英文逗号分隔，可空)', { placeholder: '可空' })) || ''
    useNpmMirror ??= await confirm('是否使用 npm 镜像源加速依赖安装？', { initial: false })
  }

  const installWebui = await confirm('是否安装 WebUI？(建议安装)', { initial: true })

  // Select and validate package manager
  const pkgManager = await selectPackageManager()
  const pm = ensurePackageManager(pkgManager)

  const pkgJson = dedent(`
  {
    "name": "${name}",
    "private": true,
    "dependencies": {
      "mioku": "^${version}"
    },
    "mioku": {
      "prefix": "${prefix}",
      "owners": [${String(owners)
        .split(',')
        .map((o) => o.trim())
        .join(', ')}],
      "admins": [${
        admins
          ? String(admins)
              .split(',')
              .map((o) => `"${o.trim()}"`)
              .join(', ')
          : ''
      }],
      "plugins": ["boot", "help", "chat"],
      "log_level": "info",
      "online_push": true,
      "error_push": true,
      "napcat": [
        {
          "protocol": "${protocol}",
          "port": ${port},
          "host": "${host}",
          "token": "${token}"
        }
      ]
    },
    "scripts": {
      "start": "node app.ts",
      "dev": "bun run --watch app.ts"
    }
  }
`)

  const pluginCode = dedent(`
  import { definePlugin } from 'mioku'

  export default definePlugin({
    name: 'demo',
    version: '${version}',
    async setup(ctx) {
      ctx.logger.info('Demo 插件已加载')

      ctx.handle('message', async (e) => {
        if (e.raw_message === 'hello') {
          e.reply('world', true)
        }
      })

      return () => {
        ctx.logger.info('Demo 插件已卸载')
      }
    },
  })
`)

  const npmrc = dedent(`
  registry=https://registry.npmmirror.com
  fund=false
`)

  const fileTree: Record<string, any> = {
    'app.ts': "require('mioku').start({ cwd: __dirname })",
    'package.json': pkgJson,
    plugins: { demo: { 'index.ts': pluginCode } },
    config: {},
    data: {},
    ...(useNpmMirror ? { '.npmrc': npmrc } : {}),
  }

  createNewProject(name, fileTree, { installWebui, pkgManager: pm })
})()

async function createNewProject(name: string, fileTree: Record<string, any>, options: { installWebui: boolean, pkgManager: string }) {
  const projectName = name
  const projectPath = withRoot(`./${projectName}`)

  if (fs.existsSync(projectPath)) {
    const overwrite = await confirm(`项目 ${projectName} 已存在，是否覆盖？`)

    if (!overwrite) {
      gracefullyExit()
    }

    if (projectPath === process.cwd()) {
      if (fs.readdirSync(projectPath).length !== 0) {
        const confirmOver = await confirm('项目路径与当前路径相同，将删除当前目录下所有内容再创建，是否继续？')
        if (!confirmOver) {
          gracefullyExit()
        }
      }
    }

    fs.rmSync(projectPath, { recursive: true })
  }

  fs.mkdirSync(projectPath)

  makeFileTree(fileTree, projectPath)

  console.log(`项目 ${projectName} 创建成功！`)
  console.log(`\ncd ${projectPath} && ${options.pkgManager} install && ${options.pkgManager} start\n`)

  if (options.installWebui) {
    console.log('WebUI 将通过 mioku 框架自动加载，无需额外安装。')
  }
}

function gracefullyExit() {
  console.log('Bye!')
  process.exit(0)
}

function withRoot(_path: string) {
  return path.resolve(process.cwd(), _path)
}

type OmitTypeWithRequired<T> = Omit<T, 'type' | 'required'> & { required?: boolean }

async function confirm(message: string, options?: OmitTypeWithRequired<{ initial?: boolean }>) {
  return consola.prompt(message, { type: 'confirm', cancel: 'reject', ...options })
}

async function input(message: string, options?: OmitTypeWithRequired<{ default?: string; placeholder?: string }>) {
  const result = await consola.prompt(message, { type: 'text', cancel: 'reject', ...options })
  if (options?.required && !result) return input(message, options)
  return result
}

function makeFileTree(
  fileTree: Record<string, string | Record<string, string | Record<string, string>>>,
  base: string,
) {
  for (const [name, content] of Object.entries(fileTree)) {
    if (typeof content === 'object' && content !== null) {
      const subPath = `${base}/${name}`
      if (!fs.existsSync(subPath)) {
        fs.mkdirSync(subPath, { recursive: true })
      }
      for (const [subName, subContent] of Object.entries(content)) {
        if (typeof subContent === 'object') {
          makeFileTree(content as typeof fileTree, subPath)
        } else {
          fs.writeFileSync(`${subPath}/${subName}`, subContent)
        }
      }
    } else {
      const filePath = `${base}/${name}`
      const dirname = path.dirname(filePath)
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true })
      }
      fs.writeFileSync(filePath, content)
    }
  }
}