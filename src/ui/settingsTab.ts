import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type AIConnectedPlugin from "../main";
import { testConnection } from "../agent/llm";
import { generateToken, PROVIDER_PRESETS } from "../settings";
import { ALL_TOOLS } from "../tools";
import { ConfirmModal } from "./confirmModal";

export class AIConnectedSettingTab extends PluginSettingTab {
  private plugin: AIConnectedPlugin;

  constructor(app: App, plugin: AIConnectedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-settings");

    containerEl.createEl("h2", { text: "AI Connected" });
    containerEl.createEl("p", {
      cls: "ai-settings-intro",
      text: "把笔记库变成 AI Agent 可读写的工作区：内置 MCP 服务器供 Claude Code / Cursor / Cline 等客户端接入，同时提供一个能直接操作笔记的对话面板。",
    });

    this.renderMcpSection(containerEl);
    this.renderAgentSection(containerEl);
    this.renderChatSection(containerEl);
    this.renderSafetySection(containerEl);
    this.renderToolsSection(containerEl);
  }

  // ---------------------------------------------------------------- MCP server

  private renderMcpSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    containerEl.createEl("h3", { text: "MCP 服务器" });

    if (!Platform.isDesktopApp) {
      containerEl.createEl("p", {
        cls: "ai-warning",
        text: "移动端没有 Node 运行时，MCP 服务器只在桌面版 Obsidian 中可用。对话面板仍然可以使用。",
      });
    }

    const status = containerEl.createDiv({ cls: "ai-server-status" });
    const dot = status.createSpan({ cls: "ai-server-dot" });
    dot.toggleClass("is-running", !!this.plugin.server);
    status.createSpan({ text: this.plugin.serverStatusText() });
    if (this.plugin.server) {
      const code = status.createEl("code", { text: this.plugin.server.endpoint });
      code.addClass("ai-endpoint");
    }

    new Setting(containerEl)
      .setName("启用 MCP 服务器")
      .setDesc("Obsidian 启动时自动监听本地端口，供外部 AI 客户端连接。")
      .addToggle((toggle) =>
        toggle.setValue(settings.mcpEnabled).onChange(async (value) => {
          settings.mcpEnabled = value;
          await this.plugin.saveSettings();
          if (value) await this.plugin.startServer();
          else await this.plugin.stopServer();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("监听地址")
      .setDesc("默认只监听本机回环地址。改成 0.0.0.0 会暴露到局域网，请务必保留访问令牌。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("127.0.0.1", "127.0.0.1（仅本机，推荐）")
          .addOption("0.0.0.0", "0.0.0.0（局域网，风险）")
          .setValue(settings.mcpHost)
          .onChange(async (value) => {
            settings.mcpHost = value;
            await this.plugin.saveSettings();
            if (this.plugin.server) await this.plugin.restartServer();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("端口")
      .setDesc("默认 37821。被占用时换一个 1024-65535 之间的端口。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setValue(String(settings.mcpPort))
          .onChange(async (value) => {
            const port = Number(value);
            if (!Number.isFinite(port) || port < 1024 || port > 65535) return;
            settings.mcpPort = Math.round(port);
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener("blur", async () => {
          if (this.plugin.settings.mcpEnabled) await this.plugin.restartServer();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("要求访问令牌")
      .setDesc("客户端必须在 Authorization: Bearer <token> 中携带令牌，否则返回 401。强烈建议开启。")
      .addToggle((toggle) =>
        toggle.setValue(settings.mcpRequireAuth).onChange(async (value) => {
          settings.mcpRequireAuth = value;
          await this.plugin.saveSettings();
          if (this.plugin.server) await this.plugin.restartServer();
          this.display();
        }),
      );

    const tokenSetting = new Setting(containerEl)
      .setName("访问令牌")
      .setDesc("自动生成，仅保存在本机插件数据中。泄露后请立即重新生成。");

    tokenSetting.addText((text) => {
      text.setValue(settings.mcpToken).setDisabled(true);
      text.inputEl.addClass("ai-token-input");
    });
    tokenSetting.addButton((button) =>
      button.setButtonText("复制").onClick(async () => {
        await navigator.clipboard.writeText(settings.mcpToken);
        this.notice("访问令牌已复制");
      }),
    );
    tokenSetting.addButton((button) =>
      button.setButtonText("重新生成").onClick(async () => {
        settings.mcpToken = generateToken();
        await this.plugin.saveSettings();
        if (this.plugin.server) await this.plugin.restartServer();
        this.display();
      }),
    );

    new Setting(containerEl)
      .setName("只读模式")
      .setDesc("开启后 MCP 客户端只能读取笔记，所有写入 / 删除 / 移动工具都会被拒绝。")
      .addToggle((toggle) =>
        toggle.setValue(settings.mcpReadOnly).onChange(async (value) => {
          settings.mcpReadOnly = value;
          await this.plugin.saveSettings();
          if (this.plugin.server) await this.plugin.restartServer();
          this.notice(value ? "MCP 已切换为只读模式" : "MCP 已允许写入");
        }),
      );

    if (Platform.isDesktopApp) {
      new Setting(containerEl)
        .setName("服务控制")
        .setDesc("修改配置后如未生效，可手动重启。")
        .addButton((button) =>
          button.setButtonText("重启服务器").onClick(async () => {
            await this.plugin.restartServer(true);
            this.display();
          }),
        )
        .addButton((button) =>
          button.setButtonText("复制 MCP 配置").setCta().onClick(async () => {
            await this.plugin.copyMcpConfig();
          }),
        )
        .addButton((button) =>
          button.setButtonText("复制 Claude Code 命令").onClick(async () => {
            await this.plugin.copyClaudeCodeCommand();
          }),
        );

      const preview = containerEl.createDiv({ cls: "ai-config-preview" });
      preview.createEl("h4", { text: "客户端配置（Claude Desktop / Cursor / Cline 等）" });
      const pre = preview.createEl("pre");
      pre.createEl("code", { text: this.plugin.mcpConfigJson() });
      preview.createEl("h4", { text: "Claude Code CLI" });
      const cmd = preview.createEl("pre");
      cmd.createEl("code", { text: this.plugin.claudeCodeCommand() });
    }
  }

  // -------------------------------------------------------------------- agent

  private renderAgentSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    containerEl.createEl("h3", { text: "内置 Agent" });
    containerEl.createEl("p", {
      cls: "ai-settings-intro",
      text: "支持任意 OpenAI 兼容接口。API Key 保存在本机插件数据文件（data.json）中，不会上传到其他地方。",
    });

    new Setting(containerEl)
      .setName("服务商预设")
      .setDesc("选择预设会自动填好 Base URL 与模型名，之后仍可手动修改。")
      .addDropdown((dropdown) => {
        for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
          dropdown.addOption(key, preset.label);
        }
        dropdown.setValue(settings.provider).onChange(async (value) => {
          settings.provider = value;
          const preset = PROVIDER_PRESETS[value];
          if (preset && value !== "custom") {
            settings.baseUrl = preset.baseUrl;
            settings.model = preset.model;
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("例如 https://api.deepseek.com/v1，插件会自动补上 /chat/completions。")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(settings.baseUrl)
          .onChange(async (value) => {
            settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("本地模型（Ollama / LM Studio）可以留空。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("例如 deepseek-chat、gpt-4o-mini、qwen-plus。")
      .addText((text) =>
        text
          .setPlaceholder("deepseek-chat")
          .setValue(settings.model)
          .onChange(async (value) => {
            settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("发送一个最小请求，验证 Base URL、Key 与模型是否可用。")
      .addButton((button) =>
        button.setButtonText("测试").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("测试中…");
          try {
            const reply = await testConnection(this.plugin.llmConfig());
            this.notice(`连接成功：${reply.slice(0, 60)}`);
          } catch (error) {
            this.notice(`连接失败：${error instanceof Error ? error.message : String(error)}`, 8000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("测试");
          }
        }),
      );

    new Setting(containerEl)
      .setName("温度")
      .setDesc("越低越稳定，越高越有创造性。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1.5, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("最大工具调用轮数")
      .setDesc("一次提问中 Agent 最多可以连续调用多少轮工具。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(settings.maxSteps)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxSteps = Math.round(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("流式输出")
      .setDesc("逐字显示回复。若接口不支持流式或出现跨域问题，插件会自动回退到普通请求。")
      .addToggle((toggle) =>
        toggle.setValue(settings.stream).onChange(async (value) => {
          settings.stream = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("自动附带当前笔记")
      .setDesc("每次发送消息时，把当前打开笔记的内容作为上下文一起发给模型。")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoAttachActiveNote).onChange(async (value) => {
          settings.autoAttachActiveNote = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("定义 Agent 的角色、工作方式与输出语言。")
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.addClass("ai-prompt-input");
        area.setValue(settings.systemPrompt).onChange(async (value) => {
          settings.systemPrompt = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // ------------------------------------------------------------- chat history

  private renderChatSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    containerEl.createEl("h3", { text: "对话记录" });

    new Setting(containerEl)
      .setName("保存对话历史")
      .setDesc(
        `对话自动保存到 ${this.plugin.chatHistoryPath}，重载 Obsidian 或关闭面板后仍可恢复。只存在插件目录，不会写入你的笔记。`,
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.persistChatHistory).onChange(async (value) => {
          await this.plugin.setChatPersistence(value);
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("导出文件夹")
      .setDesc("「导出为笔记」保存到的文件夹，不存在会自动创建。")
      .addText((text) =>
        text
          .setPlaceholder("AI 对话")
          .setValue(settings.chatExportFolder)
          .onChange(async (value) => {
            settings.chatExportFolder = value.trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("历史记录")
      .setDesc(`当前保存了 ${this.plugin.chatHistoryCount} 段对话，最多保留 40 段。`)
      .addButton((button) =>
        button.setButtonText("查看历史").onClick(async () => {
          await this.plugin.openChatHistory();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("清空全部")
          .setWarning()
          .onClick(async () => {
            const confirmed = await ConfirmModal.ask(
              this.app,
              "清空全部对话历史？",
              "这会删除所有已保存的对话，且无法恢复。插件设置不受影响。",
            );
            if (!confirmed) {
              this.notice("已取消");
              return;
            }
            await this.plugin.clearChatHistory();
            this.display();
          }),
      );
  }

  // -------------------------------------------------------------------- safety

  private renderSafetySection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    containerEl.createEl("h3", { text: "安全" });

    new Setting(containerEl)
      .setName("执行破坏性操作前确认")
      .setDesc("Agent 面板在覆盖笔记、移动或删除笔记前会弹出确认框。")
      .addToggle((toggle) =>
        toggle.setValue(settings.confirmDestructive).onChange(async (value) => {
          settings.confirmDestructive = value;
          await this.plugin.saveSettings();
        }),
      );

    const notes = containerEl.createEl("ul", { cls: "ai-safety-list" });
    notes.createEl("li", { text: "MCP 服务器默认只监听 127.0.0.1，并强制 Bearer 令牌校验。" });
    notes.createEl("li", { text: "工具无法访问 .obsidian / .trash / .git 等目录，路径中的 .. 会被拒绝。" });
    notes.createEl("li", { text: "删除操作默认移入 Obsidian 回收站，可在文件管理器中恢复。" });
    notes.createEl("li", { text: "请只接入你信任的 AI 客户端，它们能读取你笔记库中的全部内容。" });
  }

  // --------------------------------------------------------------------- tools

  private renderToolsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: `可用工具（${ALL_TOOLS.length}）` });
    const list = containerEl.createDiv({ cls: "ai-tool-list" });
    for (const tool of ALL_TOOLS) {
      const item = list.createDiv({ cls: "ai-tool-item" });
      const badge = item.createEl("code", { text: tool.name });
      badge.toggleClass("is-readonly", tool.readOnly);
      badge.toggleClass("is-destructive", tool.destructive === true);
      item.createSpan({ cls: "ai-tool-desc", text: tool.description });
    }

    containerEl.createEl("h3", { text: "外部客户端接入示例" });
    const example = containerEl.createEl("pre", { cls: "ai-config-preview" });
    example.setText(
      [
        "# Claude Code",
        this.plugin.claudeCodeCommand(),
        "",
        "# 其他客户端（Cursor / Cline / Claude Desktop / Windsurf）",
        "# 添加一个 Streamable HTTP MCP 服务器，URL 与 Authorization 见上方配置。",
        "",
        "# 健康检查",
        `curl http://${this.plugin.settings.mcpHost}:${this.plugin.settings.mcpPort}/health`,
      ].join("\n"),
    );
  }

  private notice(message: string, timeout = 3000): void {
    new Notice(message, timeout);
  }
}
