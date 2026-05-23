# 部署指南

## 使用 npx mioku 管理

Mioku 使用 `npx mioku` 脚本进行各种管理操作。

### 常用命令

```bash
# 交互式创建新项目（首次使用）
npx mioku

# 安装插件
npx mioku install plugin <名称>
# 例如: npx mioku install plugin 60s

# 安装服务
npx mioku install service <名称>
# 例如: npx mioku install service ai

# 更新插件或服务
npx mioku update all        # 更新所有 mioku 相关包
npx mioku update self       # 只更新 mioku 框架
npx mioku update <包名>     # 更新指定包
```

## 常见问题

### 端口被占用

如果 3339 端口被占用，修改 `config/webui/settings.json`：

```json
{
  "port": 3338
}
```

### 需要帮助

```bash
npx mioku --help
```
