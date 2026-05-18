# Config Page

配置界面渲染服务，支持插件自定义配置页面。

## 配置页面格式

插件通过 `config.md` 文件定义配置界面，使用 YAML frontmatter 定义字段，Markdown 编写界面说明。

```
plugins/<plugin_name>/
├── index.ts          # 插件入口
├── config.md        # 配置文件
└── ...
```

## Frontmatter 字段定义

`title: string`

> 插件显示名称

`description: string`

> 插件描述

`fields: ConfigField[]>`

> 配置字段数组

### ConfigField

`key: string`

> 配置键名，格式: `<configName>.<jsonPath>`

`label: string`

> 字段显示标签

`type: string`

> 字段类型: text, textarea, number, switch, select, multi-select, secret, json, array

`description?: string`

> 字段描述

`placeholder?: string`

> 占位符文本

`required?: boolean`

> 是否必填

`defaultValue?: any`

> 默认值

`options?: Array<{ value, label }>`

> 下拉选项（select/multi-select）

`source?: string`

> 数据源: groups, friends 等

---

## 字段类型

### `text` 文本输入

> 用于单行文本输入

`key`

> 字段键名

`label`

> 显示标签

`type: "text"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 输入框占位提示文字

`required?`

> 是否为必填字段

`defaultValue?`

> 默认值

### `textarea` 多行文本输入

> 用于多行文本输入，支持换行

`key`

> 字段键名

`label`

> 显示标签

`type: "textarea"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 输入框占位提示文字

`required?`

> 是否为必填字段

`defaultValue?`

> 默认值

### `number` 数字输入

> 用于数字输入

`key`

> 字段键名

`label`

> 显示标签

`type: "number"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 输入框占位提示文字

`required?`

> 是否为必填字段

`defaultValue?`

> 默认值

### `switch` 开关

> 用于布尔值开关

`key`

> 字段键名

`label`

> 显示标签

`type: "switch"`

> 字段类型标识

`description?`

> 字段描述信息

`defaultValue?`

> 默认值

### `select` 下拉选择

> 用于单选下拉框

`key`

> 字段键名

`label`

> 显示标签

`type: "select"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 选择框占位提示文字

`required?`

> 是否为必填字段

`options: Array<{ value, label }>`

> 选项列表 { value: 选项值, label: 选项显示名 }

`defaultValue?`

> 默认值

### `multi-select` 多选

> 用于多选列表

`key`

> 字段键名

`label`

> 显示标签

`type: "multi-select"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 选择框占位提示文字

`required?`

> 是否为必填字段

`options: Array<{ value, label }>`

> 选项列表 { value: 选项值, label: 选项显示名 }

`defaultValue?`

> 默认值

### `secret` 密码输入

> 用于密码输入，支持显示/隐藏切换

`key`

> 字段键名

`label`

> 显示标签

`type: "secret"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 输入框占位提示文字

`required?`

> 是否为必填字段

`defaultValue?`

> 默认值

### `json` JSON 编辑器

> 用于 JSON 对象编辑

`key`

> 字段键名

`label`

> 显示标签

`type: "json"`

> 字段类型标识

`description?`

> 字段描述信息

`placeholder?`

> 输入框占位提示文字

`required?`

> 是否为必填字段

`defaultValue?`

> 默认值

### `array` 数组编辑

> 用于编辑数组类型配置，例如服务器列表

`key`

> 字段键名

`label`

> 显示标签

`type: "array"`

> 字段类型标识

`description?`

> 字段描述信息

`required?`

> 是否为必填字段

`itemFields: ConfigField[]`

> 数组元素的内嵌字段定义，每个元素是一个对象，包含以下子字段：
> - `key`: 子字段键名（直接填字段名，不用带前缀）
> - `label`: 显示标签
> - `type`: 子字段类型（text/textarea/number/switch/select 等）
> - `description?`: 字段描述
> - `placeholder?`: 占位提示
> - `options?`: 下拉选项（select 类型）

---

## 数据源 (source)

部分字段支持从数据源动态加载选项

### `groups` 群列表

> 动态加载群列表作为选项

`source: "groups"`

> 数据源类型

返回选项结构:

> - value: 群号
> - label: 群名称
> - meta: { groupId, memberCount?, avatarUrl? }

### `friends` 好友列表

> 动态加载好友列表作为选项

`source: "friends"`

> 数据源类型

返回选项结构:

> - value: QQ 号
> - label: 昵称/备注
> - meta: { qq, avatarUrl? }

---

## WebUI API 端点

### GET /api/plugin-config/pages/:plugin

> 获取配置页面

返回 结构:

> - ok: 请求是否成功
> - data: ConfigPageData | null

### GET /api/plugin-config/datasources/:source

> 获取数据源选项

返回 结构:

> - ok: 请求是否成功
> - data: DatasourceOption[]

### POST /api/plugin-config/save/:plugin

> 保存配置

请求 结构:

> - configs: 配置对象

返回 结构:

> - ok: 请求是否成功

<details>
<summary>点击展开完整类型定义</summary>

```typescript
interface ConfigField {
  key: string;
  label: string;
  type:
    | "text"
    | "textarea"
    | "number"
    | "switch"
    | "select"
    | "multi-select"
    | "secret"
    | "json";
  description?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  source?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: any;
}

interface ConfigPageData {
  plugin: string;
  title: string;
  description?: string;
  markdown: string;
  fields: ConfigField[];
  hasCustomPage: boolean;
  configs: Record<string, any>;
}

interface DatasourceOption {
  value: string;
  label: string;
  meta?: Record<string, any>;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
```

</details>
