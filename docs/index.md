---
layout: home
description: Mioku 是一个 AI 优先的插件式机器人框架，使用 TypeScript 与 bun，支持多平台接入。

hero:
  name: Mioku
  text: AI 优先的机器人框架
  tagline: 插件式 · 跨平台 · 轻量，为 Agent 时代设计
  image:
    src: /images/home/cong.png
    alt: Mioku
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 开发指南
      link: /developer/overview
    - theme: alt
      text: 类型参考
      link: /reference/

features:
  - title: 开箱即用
    details: 一条命令创建项目，自带终端调试与 WebUI 管理面板。
  - title: 轻量高性能
    details: 使用现代 TypeScript 编写，空载内存占用低于 100M，依赖由 bun 管理。
  - title: Agent 优先
    details: 围绕 AI 设计，机器人可以用 QQ 完成任务，也可以调用自己的插件。
---

<div class="mioku-home">
  <section class="mioku-home__section">
    <h2 class="mioku-home__section-title">从这里开始</h2>
    <div class="mioku-home__grid">
      <a class="mioku-home__entry" href="/guide/introduction">
        <h3>认识 Mioku</h3>
        <p>了解设计理念与插件、服务、适配器的关系</p>
      </a>
      <a class="mioku-home__entry" href="/guide/quick-start">
        <h3>快速上手</h3>
        <p>一条命令创建项目，快速体验框架</p>
      </a>
      <a class="mioku-home__entry" href="/developer/first-plugin">
        <h3>插件入门</h3>
        <p>从最小的插件开始，逐步熟悉开发流程</p>
      </a>
    </div>
  </section>
</div>
