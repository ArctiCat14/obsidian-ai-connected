import { Notice, Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { AgentView, VIEW_TYPE_AGENT } from "./agent/agentView";
import { ChatStore, sanitizeFileName, sessionToMarkdown, type ChatSession } from "./agent/chatStore";
import type { LlmConfig } from "./agent/llm";
import { McpServer } from "./server/mcpServer";
import {
  AIConnectedSettings,
  DEFAULT_SETTINGS,
  generateToken,
  normalizeSettings,
} from "./settings";
import { ALL_TOOLS } from "./tools";
import { ensureFolder } from "./tools/helpers";
import type { ToolContext, ToolDef } from "./tools/types";
import { AIConnectedSettingTab } from "./ui/settingsTab";
import { ConfirmModal } from "./ui/confirmModal";

export default class AIConnectedPlugin extends Plugin {
  settings: AIConnectedSettings = { ...DEFAULT_SETTINGS };
  chats!: ChatStore;
  private mcp: McpServer | null = null;
  private statusBar: HTMLElement | null = null;
  private serverError = "";

  async onload(): Promise<void> {
    await this.loadSettings();

    this.chats = new ChatStore(this.app, this.chatStorePath(), this.settings.persistChatHistory);
    await this.chats.load();

    this.registerView(VIEW_TYPE_AGENT, (leaf) => new AgentView(leaf, this));

    this.addRibbonIcon("bot", "AI Connected：打开 Agent 面板", () => {
      void this.activateAgentView();
    });

    this.addCommand({
      id: "open-agent-panel",
      name: "打开 AI Agent 面板",
      callback: () => void this.activateAgentView(),
    });

    this.addCommand({
      id: "toggle-mcp-server",
      name: "启动 / 停止 MCP 服务器",
      callback: () => void this.toggleServer(),
    });

    this.addCommand({
      id: "restart-mcp-server",
      name: "重启 MCP 服务器",
      callback: () => void this.restartServer(true),
    });

    this.addCommand({
      id: "copy-mcp-config",
      name: "复制 MCP 客户端配置（JSON）",
      callback: () => void this.copyMcpConfig(),
    });

    this.addCommand({
      id: "copy-claude-code-setup",
      name: "复制 Claude Code 接入命令",
      callback: () => void this.copyClaudeCodeCommand(),
    });

    this.addCommand({
      id: "new-chat",
      name: "新建 AI 对话",
      callback: () => void this.startNewChat(),
    });

    this.addCommand({
      id: "open-chat-history",
      name: "打开对话历史",
      callback: () => void this.openChatHistory(),
    });

    this.addCommand({
      id: "export-current-chat",
      name: "导出当前对话为笔记",
      callback: () => void this.exportCurrentChat(),
    });

    this.addCommand({
      id: "send-active-note-to-agent",
      name: "把当前笔记发送给 Agent",
      callback: () => void this.sendActiveNoteToAgent(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (!selection.trim()) return;
        menu.addItem((item) =>
          item
            .setTitle("发送选中内容到 AI Agent")
            .setIcon("bot")
            .onClick(() => void this.sendSelectionToAgent(selection)),
        );
      }),
    );

    this.addSettingTab(new AIConnectedSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("ai-status-bar");
    this.statusBar.addEventListener("click", () => void this.toggleServer());
    this.updateStatusBar();

    if (this.settings.mcpEnabled) {
      void this.startServer();
    }
  }

  onunload(): void {
    void this.chats?.save();
    void this.stopServer();
  }

  // ------------------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) ?? {};
    this.settings = normalizeSettings(raw);
    if (!this.settings.mcpToken) {
      this.settings.mcpToken = generateToken();
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.updateStatusBar();
    this.refreshAgentStatus();
  }

  // --------------------------------------------------------------- integrations

  llmConfig(): LlmConfig {
    return {
      baseUrl: this.settings.baseUrl,
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      temperature: this.settings.temperature,
      stream: this.settings.stream,
    };
  }

  toolContext(): ToolContext {
    return { app: this.app, settings: this.settings };
  }

  availableTools(): ToolDef[] {
    return ALL_TOOLS;
  }

  async confirmTool(tool: ToolDef, args: Record<string, any>): Promise<boolean> {
    if (!this.settings.confirmDestructive) return true;
    const body = `${tool.description}\n\n参数：\n${JSON.stringify(args, null, 2)}`;
    return ConfirmModal.ask(this.app, `确认执行工具「${tool.name}」？`, body);
  }

  async activeNoteContext(): Promise<string | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    const content = await this.app.vault.cachedRead(file);
    const limit = 12000;
    const body = content.length > limit ? `${content.slice(0, limit)}\n\n[... 已截断 ${content.length - limit} 字符]` : content;
    return `【当前笔记：${file.path}】\n${body}`;
  }

  // ----------------------------------------------------------------- agent view

  async activateAgentView(): Promise<AgentView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_AGENT)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("无法创建侧边栏面板。");
        return null;
      }
      await leaf.setViewState({ type: VIEW_TYPE_AGENT, active: true });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof AgentView) {
      window.setTimeout(() => view.focusInput(), 60);
      return view;
    }
    return null;
  }

  private getAgentView(): AgentView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT)[0];
    return leaf?.view instanceof AgentView ? leaf.view : null;
  }

  private refreshAgentStatus(): void {
    this.getAgentView()?.refreshStatus();
  }

  // ------------------------------------------------------------- chat history

  private chatStorePath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/chats.json`;
  }
  get chatHistoryPath(): string {
    return this.chats?.path ?? this.chatStorePath();
  }

  get chatHistoryCount(): number {
    return this.chats?.sessions.length ?? 0;
  }

  async setChatPersistence(enabled: boolean): Promise<void> {
    this.settings.persistChatHistory = enabled;
    await this.saveSettings();
    await this.chats.setPersistenceEnabled(enabled);
  }

  async clearChatHistory(): Promise<void> {
    await this.chats.clearAll();
    this.getAgentView()?.newChat();
    new Notice("对话历史已清空。");
  }

  async startNewChat(): Promise<void> {
    const view = await this.activateAgentView();
    view?.newChat();
  }

  async openChatHistory(): Promise<void> {
    const view = await this.activateAgentView();
    view?.openHistory();
  }

  async exportCurrentChat(): Promise<void> {
    const view = await this.activateAgentView();
    await view?.exportChat();
  }

  /** Writes a transcript into the vault and returns its path. */
  async exportSessionToNote(session: ChatSession): Promise<string> {
    const folder = this.settings.chatExportFolder;
    if (folder) await ensureFolder(this.app, folder);

    const base = sanitizeFileName(session.title || "AI 对话");
    let path = folder ? `${folder}/${base}.md` : `${base}.md`;
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path) && index < 1000) {
      path = folder ? `${folder}/${base} ${index}.md` : `${base} ${index}.md`;
      index++;
    }
    await this.app.vault.create(path, sessionToMarkdown(session));
    return path;
  }

  async sendActiveNoteToAgent(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("当前没有打开任何笔记。");
      return;
    }
    const view = await this.activateAgentView();
    if (!view) return;
    const content = await this.app.vault.cachedRead(file);
    const limit = 12000;
    const body = content.length > limit ? `${content.slice(0, limit)}\n\n[... 已截断]` : content;
    view.attachContent(file.path, body);
    view.focusInput();
  }

  async sendSelectionToAgent(selection: string): Promise<void> {
    if (!selection.trim()) return;
    const view = await this.activateAgentView();
    if (!view) return;
    const file = this.app.workspace.getActiveFile();
    const label = file ? file.path : "选中内容";
    view.insertIntoComposer(`以下是来自「${label}」的片段：\n\n> ${selection.split("\n").join("\n> ")}\n\n`);
  }

  // ----------------------------------------------------------------- mcp server

  get server(): McpServer | null {
    return this.mcp;
  }

  async startServer(): Promise<void> {
    if (!Platform.isDesktopApp) {
      this.serverError = "MCP 服务器需要桌面版 Obsidian";
      this.updateStatusBar();
      return;
    }
    await this.stopServer();
    this.serverError = "";

    const server = new McpServer({
      host: this.settings.mcpHost,
      port: this.settings.mcpPort,
      token: this.settings.mcpToken,
      requireAuth: this.settings.mcpRequireAuth,
      readOnly: this.settings.mcpReadOnly,
      version: this.manifest.version,
      getTools: () => this.availableTools(),
      getContext: () => this.toolContext(),
      onLog: (message) => console.debug(`[ai-connected] ${message}`),
    });

    try {
      await server.start();
      this.mcp = server;
      this.updateStatusBar();
    } catch (error) {
      this.serverError = describeServerError(error, this.settings.mcpPort);
      this.mcp = null;
      this.updateStatusBar();
      new Notice(`MCP 服务器启动失败：${this.serverError}`, 8000);
    }
  }

  async stopServer(): Promise<void> {
    const server = this.mcp;
    this.mcp = null;
    this.updateStatusBar();
    if (server) await server.stop();
  }

  async restartServer(notify = false): Promise<void> {
    await this.startServer();
    if (notify && this.mcp) new Notice("MCP 服务器已重启。");
  }

  async toggleServer(): Promise<void> {
    if (this.mcp) {
      await this.stopServer();
      new Notice("MCP 服务器已停止。");
    } else {
      await this.startServer();
    }
  }

  serverStatusText(): string {
    if (!Platform.isDesktopApp) return "MCP 不可用（移动端）";
    if (this.mcp) return `MCP :${this.mcp.port}`;
    if (this.serverError) return "MCP 启动失败";
    return this.settings.mcpEnabled ? "MCP 未运行" : "MCP 已关闭";
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const label = Platform.isDesktopApp && this.mcp ? `AI ● :${this.mcp.port}` : "AI ○";
    this.statusBar.setText(label);
    this.statusBar.setAttr(
      "title",
      `AI Connected\n${this.serverStatusText()}\n点击启动 / 停止 MCP 服务器`,
    );
    this.statusBar.toggleClass("is-running", !!this.mcp);
  }

  // ------------------------------------------------------------------ clipboard

  mcpConfigJson(): string {
    const url = this.mcp?.endpoint ?? `http://${this.settings.mcpHost}:${this.settings.mcpPort}/mcp`;
    const useToken = this.settings.mcpRequireAuth && !!this.settings.mcpToken;
    const config = {
      mcpServers: {
        obsidian: {
          type: "http",
          url,
          ...(useToken ? { headers: { Authorization: `Bearer ${this.settings.mcpToken}` } } : {}),
        },
      },
    };
    return JSON.stringify(config, null, 2);
  }

  claudeCodeCommand(): string {
    const url = this.mcp?.endpoint ?? `http://${this.settings.mcpHost}:${this.settings.mcpPort}/mcp`;
    const useToken = this.settings.mcpRequireAuth && !!this.settings.mcpToken;
    const header = useToken ? ` --header "Authorization: Bearer ${this.settings.mcpToken}"` : "";
    return `claude mcp add --transport http obsidian ${url}${header}`;
  }

  async copyMcpConfig(): Promise<void> {
    await this.copyToClipboard(this.mcpConfigJson());
    new Notice("MCP 配置已复制到剪贴板。");
  }

  async copyClaudeCodeCommand(): Promise<void> {
    await this.copyToClipboard(this.claudeCodeCommand());
    new Notice("Claude Code 接入命令已复制。");
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to a hidden textarea */
    }
    const textarea = createEl("textarea", { cls: "ai-clipboard-helper" });
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }

  // -------------------------------------------------------------------- helpers

  getToolNames(): string[] {
    return ALL_TOOLS.map((tool) => tool.name);
  }
}

function describeServerError(error: unknown, port: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE/i.test(message)) {
    return `端口 ${port} 已被占用，请在设置中换一个端口`;
  }
  if (/EACCES|EPERM/i.test(message)) {
    return `没有权限监听端口 ${port}`;
  }
  return message;
}
