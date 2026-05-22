---
title: WebUI插件配置API展示
description: 教你如何编写插件的help.md文件
fields:
  - key: demo.textValue
    label: text 单行文本
    type: text
    description: 最基础的单行文本输入。
    placeholder: 输入任意文本

  - key: demo.secretValue
    label: secret 密文输入
    type: secret
    description: 适合 token、密码、密钥这类敏感字段。
    placeholder: 输入密文内容

  - key: demo.textareaValue
    label: textarea 大文本
    type: textarea
    description: 适合提示词、描述、人设、长文本模板。
    placeholder: 输入多行文本

  - key: demo.numberValue
    label: number 数字输入
    type: number
    description: 用于整数、小数或数量限制。
    placeholder: 请输入数字

  - key: demo.switchValue
    label: switch 布尔开关
    type: switch
    description: 按钮交互

  - key: demo.selectStaticValue
    label: select 静态单选
    type: select
    description: 适合枚举值、模式切换、等级选择。
    options:
      - value: low
        label: 低
      - value: medium
        label: 中
      - value: high
        label: 高

  - key: demo.selectFriendValue
    label: select 好友单选
    type: select
    source: qq_friends
    description: 点击输入框弹窗，从当前好友列表中选择一个好友。
    placeholder: 点击选择好友

  - key: demo.selectGroupValue
    label: select 群聊单选
    type: select
    source: qq_groups
    description: 点击输入框弹窗，从当前已加入群聊中选择一个群。
    placeholder: 点击选择群聊

  - key: demo.multiSelectStaticValue
    label: multi-select 静态多选
    type: multi-select
    description: 适合静态标签、开关集合、白名单集合。
    options:
      - value: alpha
        label: alpha
      - value: beta
        label: beta
      - value: gamma
        label: gamma

  - key: demo.multiSelectFriendsValue
    label: multi-select 好友多选
    type: multi-select
    source: qq_friends
    description: 点击输入框弹窗，可按昵称、备注或 QQ 号模糊搜索并多选好友。
    placeholder: 点击选择多个好友

  - key: demo.multiSelectGroupsValue
    label: multi-select 群聊多选
    type: multi-select
    source: qq_groups
    description: 点击输入框弹窗，可按群名称或群号模糊搜索并多选群聊。
    placeholder: 点击选择多个群聊

  - key: demo.jsonValue
    label: json 原始对象
    type: json
    description: 用于复杂对象、复杂数组或暂时不想拆字段的高级配置。
---

# Help 插件配置 API 演示

这个页面只用于演示当前 `config.md` 的能力，不会影响 help 插件的实际功能。

## 1. `mioku-field` 单字段渲染

```mioku-field
key: demo.textValue
```

用法：当你只想在某个位置插入一个配置项时，使用 `mioku-field`，并通过 `key` 指向 frontmatter 里定义好的字段。

```mioku-field
key: demo.secretValue
```

用法：`secret` 类型会使用密文输入框，适合 API Key、密码、令牌等敏感内容。

```mioku-field
key: demo.textareaValue
```

用法：`textarea` 适合长文本。显示时会自动把配置里的字面量 `\n` 转成真实换行。

```mioku-field
key: demo.numberValue
```

用法：`number` 用于限制值、数量、权重、超时等数值字段。

```mioku-field
key: demo.switchValue
```

用法：`switch` 用于布尔开关，当前 UI 会用勾选卡片模式展示。

## 2. 静态单选与动态单选

```mioku-field
key: demo.selectStaticValue
```

用法：静态 `select` 通过 `options` 直接定义所有候选值。

```mioku-field
key: demo.selectFriendValue
```

用法：动态 `select` 通过 `source: qq_friends` 读取当前好友列表，点击输入框后弹窗选择。

```mioku-field
key: demo.selectGroupValue
```

用法：动态 `select` 通过 `source: qq_groups` 读取当前群聊列表，支持按群名称或群号模糊搜索。

## 3. 静态多选与动态多选

```mioku-field
key: demo.multiSelectStaticValue
```

用法：静态 `multi-select` 适合少量固定标签集合。

```mioku-field
key: demo.multiSelectFriendsValue
```

用法：动态好友多选会打开弹窗，支持按昵称、备注或 QQ 号搜索，并批量确认。

```mioku-field
key: demo.multiSelectGroupsValue
```

用法：动态群聊多选会打开弹窗，支持按群名或群号搜索，并展示群头像、群号和人数。

## 4. `json` 高级配置

```mioku-field
key: demo.jsonValue
```

用法：当配置结构复杂，不适合拆成很多基础字段时，可以直接暴露一个 `json` 编辑器。

## 5. `mioku-fields` 多字段渲染

```mioku-fields
keys:
  - demo.textValue
  - demo.numberValue
  - demo.switchValue
```

用法：当你希望按顺序连续渲染多个字段时，可以使用 `mioku-fields`。

## 6. `mioku-file` 原始文件渲染

```mioku-file
config: demo
```

用法：`mioku-file` 会直接把某个配置文件完整显示为 JSON 编辑器，适合调试或保底兜底。

---
