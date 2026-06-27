# Help Service

帮助系统服务，提供帮助信息注册和管理。

## HelpService

> 帮助系统服务接口

### registerHelp

> 注册插件帮助信息

```typescript
registerHelp(pluginName, help): void
```

> - `pluginName`: 插件名称
> - `help`: PluginHelp 对象

### getHelp

> 获取指定插件的帮助信息

```typescript
getHelp(pluginName): PluginHelp | undefined
```

> - `pluginName`: 插件名称
>   返回: `PluginHelp | undefined` - 帮助信息

### getAllHelp

> 获取所有插件的帮助信息

```typescript
getAllHelp(): Map<string, PluginHelp>
```

> 返回: `Map<string, PluginHelp>` - 所有帮助信息

### unregisterHelp

> 移除指定插件的帮助信息

```typescript
unregisterHelp(pluginName): boolean
```

> - `pluginName`: 插件名称
>   返回: `boolean` - 是否移除成功

---

## PluginHelp

> 插件帮助信息

```typescript
interface PluginHelp {
  title: string;
  description: string;
  commands: PluginHelpCommand[];
}
```

> - `title`: 插件名称
> - `description`: 插件描述
> - `commands`: 命令列表

### PluginHelpCommand

> 插件帮助命令

```typescript
interface PluginHelpCommand {
  cmd: string;
  desc: string;
  usage?: string;
  role?: CommandRole;
}
```

> - `cmd`: 命令格式 如果其中含有"?"字符串，框架截图时将会解析成mioki配置中默认前缀
> - `desc`: 命令描述
> - `usage?`: 使用示例
> - `role?`: 使用权限

### CommandRole

> 命令权限级别

```typescript
type CommandRole = "master" | "admin" | "owner" | "member";
```

> - `master`: 主人
> - `admin`: 管理员
> - `owner`: 群主
> - `member`: 普通成员

<details>
<summary>点击展开完整类型定义</summary>

```typescript
interface HelpService {
  registerHelp(pluginName: string, help: PluginHelp): void;
  getHelp(pluginName: string): PluginHelp | undefined;
  getAllHelp(): Map<string, PluginHelp>;
  unregisterHelp(pluginName: string): boolean;
}
```

</details>
