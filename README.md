# AI Connected

**AI Connected** connects AI agents to an Obsidian vault.

It runs a local [Model Context Protocol](https://modelcontextprotocol.io) server on `127.0.0.1`,
exposing the vault to clients such as Claude Code, Cursor, Cline and Windsurf, and it also ships
an in-app agent panel that can read, search and edit notes through tool calling.

### Features

- Standard MCP server: Streamable HTTP (`/mcp`) plus legacy HTTP+SSE (`/sse`), Bearer-token auth, read-only mode.
- 15 vault tools: list, read, search, tags, metadata, backlinks, daily notes, create, append, patch, move, delete.
- Notes are exposed as MCP resources (`obsidian://vault/<path>`), and three prompts are included.
- Built-in agent panel: any OpenAI-compatible API, streaming output, multi-step tool calling.
- Chat history is persisted in the plugin folder, with a searchable history list and one-click export to a note.
- Desktop only (`isDesktopOnly: true`): the MCP server needs Node's `http` module.

### Install

Copy `main.js`, `manifest.json` and `styles.css` from the latest release into
`<vault>/.obsidian/plugins/ai-connected/`, then enable the plugin in Obsidian.
Alternatively install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using
`ArctiCat14/obsidian-ai-connected`.

### Security

The MCP server binds to `127.0.0.1` and requires a token generated on first run. Writes can be
disabled entirely, deletes go through Obsidian's trash, and paths containing `..` or pointing at
the Obsidian configuration folder are rejected. There is no telemetry; the only outbound request
is to the LLM endpoint you configure.

---

## 中文

把 Obsidian 笔记库变成 **AI Agent 可直接读写的工作区**。

AI Connected 是一个 Obsidian 插件，提供两条互补的接入路径：

1. **内置 MCP 服务器**（Model Context Protocol）— 让 Claude Code、Claude Desktop、Cursor、Cline、Windsurf、Continue 等任意支持 MCP 的客户端，通过本地 HTTP 接口搜索、阅读、创建、修改你的笔记。
2. **内置 Agent 对话面板** — 不依赖任何外部客户端，在 Obsidian 侧边栏直接和模型对话，模型通过 15 个工具操作笔记库。

> 不需要把笔记上传到任何第三方服务。MCP 服务只监听 `127.0.0.1`，并强制 Bearer Token 鉴权。

---

## 功能特性

- **标准 MCP 协议**：Streamable HTTP（`/mcp`）+ 旧版 HTTP+SSE（`/sse`）双传输，兼容面广。
- **15 个笔记工具**：列出 / 读取 / 搜索 / 全文检索 / 标签 / 元数据 / 双链 / 日记 / 创建 / 追加 / 局部修改 / 移动 / 删除。
- **结构化资源**：每篇笔记同时作为 MCP Resource 暴露（`obsidian://vault/<path>`），支持 `resources/read`。
- **提示模板**：`summarize_note`、`summarize_active_note`、`find_related_notes`，在支持 Prompts 的客户端里可直接调用。
- **内置 Agent**：OpenAI 兼容接口（DeepSeek / OpenAI / Kimi / 通义 / GLM / OpenRouter / Ollama / LM Studio…），支持流式输出与多轮工具调用。
- **对话不丢**：历史自动保存到插件目录，重载 Obsidian、关闭面板后自动恢复；支持历史列表（搜索、切换、删除）和一键导出成笔记。
- **安全默认值**：只监听本机、强制令牌、只读开关、破坏性操作二次确认、路径穿越防护、删除进回收站。
- **仅桌面端**：插件依赖 Node 运行时提供 MCP 服务，manifest 标记 `isDesktopOnly: true`，移动端不会加载。

---

## 安装

### 方式一：直接复制文件（推荐）

把以下三个文件放到你的库：

```
<你的库>/.obsidian/plugins/ai-connected/
├── main.js
├── manifest.json
└── styles.css
```

然后在 Obsidian 中打开 **设置 → 第三方插件**，关闭「安全模式」，在已安装插件列表中启用 **AI Connected**。

Windows 用户也可以用仓库里的脚本：

```powershell
# 在插件目录下执行，参数换成你的库路径
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Vault "C:\Users\Mark\Documents\mark\obsidian\university"
```

### 方式二：从源码构建

```bash
npm install
npm run build        # 类型检查 + 生成 main.js
```

开发模式（监听文件变化）：

```bash
npm run dev
```

更舒服的做法是直接把插件目录软链接到某个测试库的 `.obsidian/plugins/ai-connected`。

---

## 快速开始

1. 启用插件后，点击左侧功能区（ribbon）的机器人图标，或执行命令 **「AI Connected: 打开 AI Agent 面板」**。
2. 打开 **设置 → AI Connected**：
   - 在「内置 Agent」里选择服务商预设，填入 API Key（本地 Ollama / LM Studio 可留空），点「测试」确认连通。
   - 在「MCP 服务器」里确认端口与访问令牌，点「复制 MCP 配置」。
3. 在对话面板里直接提问，例如「总结我当前打开的笔记」「把今天的日记整理成待办」「找出和 [[项目 A]] 相关但没链接的笔记」。

---

## 对话记录

面板里的对话会自动保存，`Ctrl+R` 重载、关闭侧边栏、退出 Obsidian 都不会丢。

- 存储位置：`.obsidian/plugins/ai-connected/chats.json`（只存插件目录，不写进笔记库正文）
- 保留策略：最多 40 段对话、每段 300 条消息；工具输出落盘时截断到 4000 字符，避免文件膨胀
- 面板右上角 **历史** 按钮：搜索、切换、删除历史对话（`Ctrl+P` → `AI Connected: 打开对话历史`）
- 面板右上角 **导出** 按钮：把当前对话导出成 Markdown 笔记，默认存到 `AI 对话/` 文件夹
- 设置 → AI Connected → 对话记录：可关闭保存、修改导出文件夹、清空全部历史

> 关闭保存后仅当次会话生效，重载即清空。

---

## 接入外部 MCP 客户端

MCP 服务器默认地址：`http://127.0.0.1:37821/mcp`，鉴权头：`Authorization: Bearer <你的令牌>`。

### Claude Code

```bash
claude mcp add --transport http obsidian http://127.0.0.1:37821/mcp \
  --header "Authorization: Bearer <你的令牌>"
```

插件设置里「复制 Claude Code 命令」按钮会自动带上你的端口和令牌。

### Claude Desktop / Cursor / Cline / Windsurf

在客户端配置里添加一个 **Streamable HTTP** MCP 服务器：

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:37821/mcp",
      "headers": {
        "Authorization": "Bearer <你的令牌>"
      }
    }
  }
}
```

不支持 Streamable HTTP 的老客户端，可以使用旧版 SSE 传输：

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "sse",
      "url": "http://127.0.0.1:37821/sse",
      "headers": {
        "Authorization": "Bearer <你的令牌>"
      }
    }
  }
}
```

> 令牌在插件设置「访问令牌」处复制；泄露后点「重新生成」即可，客户端需同步更新。

### 手动验证

```bash
curl http://127.0.0.1:37821/health
# {"ok":true,"name":"ai-connected","protocolVersion":"2025-06-18","tools":15,"readOnly":false,...}

curl -X POST http://127.0.0.1:37821/mcp \
  -H "Authorization: Bearer <你的令牌>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 工具一览

| 工具 | 读写 | 说明 |
| --- | --- | --- |
| `list_notes` | 读 | 列出笔记，支持文件夹、glob、排序、分页 |
| `read_note` | 读 | 读取单篇笔记全文（可按字符数截断） |
| `search_notes` | 读 | 全文检索，返回命中行与上下文，支持正则 |
| `search_by_tag` | 读 | 按标签（含子标签）找笔记 |
| `get_metadata` | 读 | frontmatter、标签、标题大纲、链接、反向链接、字数 |
| `list_backlinks` | 读 | 谁链接到了这篇笔记 |
| `list_tags` | 读 | 全库标签及使用次数 |
| `get_active_note` | 读 | 当前打开的笔记 + 选中内容 + 光标位置 |
| `workspace_info` | 读 | 库名、笔记数、顶层文件夹、日记配置 |
| `daily_note` | 写 | 获取/创建/追加指定日期的日记 |
| `write_note` | 写 ⚠️ | 创建笔记，或覆盖已有笔记全文 |
| `append_note` | 写 | 在笔记末尾追加内容 |
| `patch_note` | 写 | 精确替换文本 / 在标题下插入 / 替换整节 |
| `move_note` | 写 ⚠️ | 移动或重命名（Obsidian 会自动更新链接） |
| `delete_note` | 写 ⚠️ | 删除（遵循 Obsidian 的删除偏好，默认进回收站） |

⚠️ 标记的工具带 `destructiveHint` 注解；客户端一般会据此提示用户确认。

---

## 安全设计

| 机制 | 说明 |
| --- | --- |
| 本机回环 | 默认只监听 `127.0.0.1`，不对外网开放 |
| Bearer 令牌 | 首次启动自动生成 48 位随机令牌，缺失或错误返回 401 |
| 只读模式 | 设置里一键开启，服务端直接拒绝所有写入类工具 |
| 路径防护 | 拒绝 `..` 穿越；禁止写入 `.obsidian` / `.trash` / `.git` |
| 二次确认 | 内置 Agent 调用覆盖 / 移动 / 删除前弹窗确认（可关闭） |
| 可恢复删除 | 默认移入 Obsidian 回收站，可从文件管理器恢复 |
| 数据本地 | 笔记、令牌、API Key 都只保存在本机 `data.json` |

> 注意：接入的 AI 客户端能读取你库里的**全部** Markdown 内容。请只使用你信任的客户端与模型服务商。

---

## 架构

```
src/
├── main.ts                 插件入口：命令、ribbon、状态栏、服务生命周期
├── settings.ts             设置模型、服务商预设、令牌生成
├── tools/
│   ├── index.ts            工具注册表（MCP 与 Agent 共用）
│   ├── types.ts            ToolDef / ToolContext / 结果类型
│   ├── helpers.ts          路径解析、模糊匹配、安全校验、格式化
│   ├── read.ts             读取类工具
│   ├── search.ts           检索类工具
│   └── write.ts            写入类工具
├── server/
│   └── mcpServer.ts        JSON-RPC 2.0 + Streamable HTTP + 旧版 SSE + 鉴权
├── agent/
│   ├── llm.ts              OpenAI 兼容客户端（流式 SSE、requestUrl 回退）
│   ├── agentLoop.ts        多轮工具调用循环
│   ├── chatStore.ts        对话历史持久化、截断、导出 Markdown
│   └── agentView.ts        Obsidian 侧边栏对话面板
└── ui/
    ├── settingsTab.ts      设置界面
    ├── historyModal.ts     历史对话列表（搜索 / 切换 / 删除）
    └── confirmModal.ts     破坏性操作确认框
```

工具层是唯一事实来源：MCP 的 `tools/list`、`tools/call` 和内置 Agent 的 function calling 都从同一份注册表生成 schema，行为完全一致。

### MCP 协议实现范围

- `initialize`（协议版本协商：2025-06-18 / 2025-03-26 / 2024-11-05）
- `notifications/initialized`、`ping`、`logging/setLevel`
- `tools/list`、`tools/call`（含 `readOnlyHint` / `destructiveHint` 注解）
- `resources/list`、`resources/templates/list`、`resources/read`
- `prompts/list`、`prompts/get`
- 传输：`POST /mcp`（JSON 或 SSE 响应）、`DELETE /mcp`、`GET /sse` + `POST /messages`
- CORS 预检、会话头 `Mcp-Session-Id`、请求体 8 MB 上限

---

## 开发与测试

```bash
npm run typecheck    # tsc --noEmit
npm test             # 载入检查 + MCP 协议 + Agent 循环 + 对话存储 四套冒烟测试
npm run build        # 产出 main.js
```

测试用 esbuild 的 `--alias:obsidian` 把官方 API 替换成 `test/obsidianStub.ts` 里的最小实现，因此可以在纯 Node 环境里跑真实的 HTTP 协议与工具调用链路：

- `test/load.test.cjs`：确认打包产物能在缺少 Node API 的环境（模拟移动端）下加载，证明 `require("http")` 是懒加载。
- `test/mcp.test.ts`：53 项断言，覆盖初始化、鉴权、15 个工具、资源、提示、SSE、只读模式。
- `test/agent.test.ts`：18 项断言，用本地 mock 的流式接口验证工具调用拼装、结果回填、中止处理。
- `test/chatStore.test.ts`：36 项断言，覆盖历史存取、截断、残缺工具轮次清理、条数上限、导出格式。

---

## 常见问题

**端口被占用 / 启动失败？**
设置里换一个端口（1024–65535），或先停止占用该端口的程序。状态栏会显示 `AI ● :端口`。

**客户端连上了但工具调用返回 401？**
检查请求头是否为 `Authorization: Bearer <令牌>`（注意 `Bearer` 后有空格），以及令牌是否在插件里重新生成过。

**流式输出没反应？**
部分接口不允许浏览器/Electron 直连（CORS）。插件会自动回退到 Obsidian 的 `requestUrl`（非流式），功能不受影响。

**移动端能用吗？**
不能。插件的 MCP 服务器依赖 Node 的 `http` 模块，manifest 已标记 `isDesktopOnly: true`，Obsidian 移动端不会加载它。想在手机上查看/编辑同一个库，用 Obsidian Sync 之类的同步方案，MCP 仍然在桌面端运行。

**对话记录存在哪？会不会写进我的笔记？**
只在 `.obsidian/plugins/ai-connected/chats.json`，不会出现在笔记库里。删除这个文件等于清空历史；也可以在设置里关闭保存。

**升级插件后对话还在吗？**
在。`chats.json` 和 `data.json` 都不在升级复制范围内，重新安装只覆盖 `main.js` / `manifest.json` / `styles.css`。

**会改坏我的笔记吗？**
覆盖、移动、删除默认需要确认；删除进回收站；改错了可以用「文件恢复」或 Git 插件回滚。建议在测试库先试用，或配合版本控制使用。

---

## License

MIT
