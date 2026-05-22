# Mioku 简介

<img src="/images/home/cong.png" width="20%" alt="吉祥物"></img>

Mioku 是基于 [mioki](https://github.com/vikiboss/mioki) 的开源插件/服务式机器人框架

> 感谢 mioki/NapCat SDK 提供的底层支持

基于 [onebot](https://onebot.dev/) 协议与 QQ 进行通信

选用 TypeScript 进行开发，可以在任何平台快速、高效的运行

## 为什么需要 Mioku？

推荐资深开发者直接使用 [mioki](https://github.com/vikiboss/mioki) 底层框架进行开发，本框架旨在为更多用户提供更便捷的管理和运行方式。

Mioku 在 mioki 的基础上增加了统一的插件/服务/插件帮助/AI 支持/配置管理...等等规范，管理更加方便，插件接入更加迅速

> [!TIP]
> Mioku 保持对 mioki 插件的全部兼容，mioki 插件可以在 Mioku 中正常运行

## 对比

| 功能             | mioki       | Mioku                |
|----------------|-------------|----------------------|
| 发消息等基础功能       | ✅           | ✅                    |
| 所有 NapCat 事件   | ✅           | ✅                    |
| 侧载插件           | ✅           | ✅                    |
| 注入服务           | 仅支持插件内注入服务  | 服务管理器，统一管理服务         |
| WebUI          | ❌           | ✅ (可选的 WebUI)         |
| AI 支持/提示词动态注入  | ❌           | ✅                    |
| 插件帮助           | 仅支持系统帮助     | 各插件帮助指令动态解析，汇总到帮助图片上 |
| AI skills 插件技能 | ❌           | ✅                    |
| 插件市场           | ❌           | ✅                    |
| 插件包管理          | ❌           | ✅ (使用 bun)              |

## 下一步

- [开始使用](/guide/quick-start)
- [配置规范](/guide/configuration)
- [开发者](/developer/overview)
- [开放接口](/reference/ctx)
