# Mioku Architecture Design

## Overview

Mioku is a convenience layer based on the mioki framework, providing a service-oriented architecture and AI skill system to make plugin development simpler and more standardized.

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Mioku Frame                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Plugin layer │  │ Service layer│  │ Core layer │ │   │
│  │  (Plugins)   │  │  (Services)  │  │   (Core)     │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│         │                  │                  │         │
│         └──────────────────┴──────────────────┘         │
│                          │                              │
└──────────────────────────┼──────────────────────────────┘
                           │
                ┌──────────▼──────────┐
                │ Mioki Frame         │
                │ (Plugin Management/Event System) │
                └─────────────────────┘
```

## Layered design

### 1. Core

**Responsibilities:** Framework infrastructure

**Components:**
- `types.ts` - Type definitions exported from `mioku` package
- `plugin-manager.ts` - Plugin metadata management
- `service-manager.ts` - Service lifecycle management

**Features:**
- Does not rely on Mioki's plugin system
- Provide service discovery and loading
- Manage plugin metadata

### 2. Services

**Responsibilities:** Provide reusable functional modules

**Built-in Services:**

#### AI Services (`mioku-service-ai`)
- Manage AI instances
- Manage AI skills and tools
- Provides a unified interface for AI calls

#### Config Services (`mioku-service-config`)
- Plugin configuration management
- Configuration persistence
- Configure hot updates

#### Help Services (`mioku-service-help`)
- Plugin help information registration
- Automatically generate help documentation
- Respond to help commands

**Service Features:**
- Separate npm package
- Independent dependency management
- Access through `ctx.services.{name}`

### 3. Plugins

**Responsibilities:** Implement specific functions

**Plugin Types:**

#### Boot Plugin (Required)
- Highest priority (`priority: -Infinity`)
- Responsible for loading all services
- Coordinate the initialization of services and plugins

#### Functional plugins
- Dependent on the service
- Register for AI Skill
- Register for help information
- Handle message events

**Plugin Features:**
- Separate npm package
- Independent dependency management
- Declarative service dependencies

## AI Skill System

### Design Concept

Traditional method: Each plugin directly registers the tool, and the tool name is globally unique
```
plugin-a: register_tool("send_message")
plugin-b: register_tool("send_message") // ❌ Conflict!
```

Skill method: Each plugin registers a Skill, and the Skill contains multiple tools
```
plugin-a: register_skill({
  name: "plugin_a",
  tools: [{ name: "send_message" }] // call: plugin_a.send_message
})

plugin-b: register_skill({
  name: "plugin_b",
  tools: [{ name: "send_message" }] // call: plugin_b.send_message
})
```

### Skill structure

```typescript
import type { AISkill, AITool } from "mioku";

interface AISkill {
  name: string;              // Skill name (usually the same as plugin name)
  description: string;        // Skill description
  tools: AITool[];            // List of tools
}

interface AITool {
  name: string;               // Tool name
  description: string;        // Tool description
  parameters: {...};          // Parameter definition
  handler: (args) => any;     // Tool handler function
  returnToAI?: boolean;       // Whether to return results to AI
}
```

### Tool call flow

```
1. The AI decides to call the tool
   ↓
2. Call format: {skill_name}.{tool_name}
   For example: chat.send_group_message
   ↓
3. The AI service finds the corresponding skill and tool
   ↓
4. Run the handler of the Tool
   ↓
5. Decide whether to return the results to the AI based on returnToAI
   ↓
6. The AI continues processing or ends
```

### Advantages

1. **Namespace Isolation** - Tools with the same name for different plugins do not conflict
2. **Semantic Clarity** - The AI can understand the source and grouping of tools
3. **Easy to Manage** - Organize tools by plugin for easy maintenance
4. **Highly Extensible** - The new plugin allows you to name tools freely

## Life cycle

### Start the process

```
1. Project启动 (bun run start)
   ↓
2. Mioku 框架启动
   ├─ Discover plugin metadata (plugin-manager)
   ├─ Discover service metadata (service-manager)
   └─ Check for missing services
   ↓
3. Mioki framework启动
   ├─ Load boot plugin (highest priority)
   │ └─ Load all services
   │ ├─ AI service initialization
   │ ├─ config service initialization
   │ └─ Help Service Initialization
   ├─ Load other plugins
   │ ├─ Register Skill to AI Services
   │ ├─ Register for help services
   │ └─ Set up the message processor
   └─ Connect to NapCat
```

### Plugin initialization process

```typescript
import { definePlugin } from "mioki";
import type { AIService, ConfigService } from "mioku";

export default definePlugin({
  name: "example",
  async setup(ctx) {
    // 1. Register for Skill
    const aiService = ctx.services?.ai as AIService | undefined;
    if (aiService && this.skill) {
      aiService.registerSkill(this.skill);
    }

    // 2. Register for help
    const helpService = ctx.services?.help as HelpService | undefined;
    if (helpService && this.help) {
      helpService.registerHelp(this.name, this.help);
    }

    // 3. Register the configuration
    const configService = ctx.services?.config as ConfigService | undefined;
    if (configService) {
      await configService.registerConfig(...);
    }

    // 4. Set up the message processor
    ctx.handle("message", async (e) => {
      // Process messages
    });

    // 5. Return to the cleanup function
    return () => {
      // Clean up resources
    };
  },
});
```

## Dependency Management

### Workspace structure

The project uses `bun` workspace management:

```json
{
  "workspaces": [
    "packages/*"
  ],
  "packageManager": "bun@1.2.0"
}
```

### Dependency hierarchy

```
mioku (root project)
├─ dependencies: mioki, napcat-sdk
├─ packages/mioku/
│ └─ 内置插件和服务
├─ packages/mioku-plugin-xxx/
│ └─ 插件独立依赖
└─ packages/mioku-service-xxx/
   └─ 服务独立依赖
```

### Advantages

1. **Isolation** - Dependencies of plugins/services do not affect each other
2. **Portability** - Can be released and installed independently
3. **Version Management** - Each module manages the version independently
4. **Fast Installation** - Using bun for optimal performance

## Configure the system

### Configure the hierarchy

```
1. Global Configuration (package.json)
   └─ mioki field

2. Plugin configuration (config/{plugin_name}/*.json)
   └─ Managed by the configuration service

3. Runtime configuration
   └─ Access via configService API
```

### Configuration example

```typescript
import type { ConfigService } from "mioku";

// Register the configuration
await configService.registerConfig("chat", "settings", {
  apiUrl: "https://api.openai.com/v1",
  apiKey: "your-api-key",
  model: "gpt-4",
});

// Read the configuration
const config = await configService.getConfig("chat", "settings");

// Update configuration
await configService.updateConfig("chat", "settings", {
  model: "gpt-4-turbo",
});

// Listen configuration changes
const unsubscribe = configService.onConfigChange(
  "chat",
  "settings",
  (newConfig) => {
    console.log("Configuration Updated:", newConfig);
  }
);
```

## Data Directory

Plugins and services should store data outside of `node_modules` to ensure data persistence.

Use the data path utilities provided by `mioku`:

```typescript
import {
  getDataDir,
  getPluginDataDir,
  getServiceDataDir,
  getConfigDir,
  getPluginConfigDir,
  getServiceConfigDir,
  ensureDataDir,
} from "mioku";

// Get plugin data directory: {cwd}/data/{pluginName}
const pluginDataDir = getPluginDataDir("my-plugin");

// Get service data directory: {cwd}/data/{serviceName}
const serviceDataDir = getServiceDataDir("my-service");

// Ensure directory exists
const myDataDir = ensureDataDir("my-plugin");
```

**Important:** Always use these utilities instead of hardcoding paths. This ensures your plugin works correctly when the project is installed in different locations.

## Best Practices

### 1. Plugin development

- ✅ Organize AI tools with the Skill system
- ✅ Register for help information
- ✅ Manage configurations using the configuration service
- ✅ Declare service dependencies
- ✅ Use data path utilities for file storage
- ❌ Don't access other plugins directly
- ❌ Don't share status between plugins

### 2. Service development

- ✅ Provide a clear API interface
- ✅ Implement the dispose method to clean up resources
- ✅ Use TypeScript type definitions
- ❌ Don't rely on specific plugins
- ❌ Don't cycle dependencies between services

### 3. AI Skill Design

- ✅ The Skill name is consistent with the plugin name
- ✅ Tool names are simple and clear
- ✅ Provide detailed tool descriptions
- ✅ Set up returnToAI properly
- ❌ Don't perform time-consuming operations in the tool
- ❌ Don't throw uncaught exceptions in the tool

## Scalability

### Add a new service

1. Create a new package in `packages/mioku-service-<name>/`
2. Implement the `MiokuService` interface
3. Export the service instance
4. Services are automatically discovered and loaded

### Add a new plugin

1. Create a new package in `packages/mioku-plugin-<name>/`
2. Implement the `MiokiPlugin` interface
3. Configure the `mioku` field for `package.json`
4. The plugin will be automatically discovered at startup

### Install plugins/services

Use `npx mioku` or the WebUI to install plugins and services:

```bash
# Interactive installation
npx mioku

# Or use WebUI at http://127.0.0.1:3339
```

## Summary

Through a layered design and skill system, the Mioku framework provides:

1. **Clear Architecture** - Core/Service/Plugin three-layer separation
2. **Flexible Extensions** - Plugins and services are developed independently
3. **Specification Management** - Skill system avoids conflicts
4. **Convenient Development** - Declarative dependencies and configurations
5. **Package Management** - Using bun workspace for efficient dependency management

This allows developers to focus on business logic without worrying about the underlying architecture.