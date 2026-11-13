import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AIConnectedPlugin from "../main";
import type { AgentEvent } from "./agentLoop";
import { runAgent } from "./agentLoop";
import { deriveTitle, type ChatSession } from "./chatStore";
import { isAbortError, type LlmMessage } from "./llm";
import { HistoryModal } from "../ui/historyModal";

export const VIEW_TYPE_AGENT = "ai-connected-agent";

interface Attachment {
  label: string;
  content: string;
}

const SUGGESTIONS = [
  { label: "总结当前笔记", prompt: "用 get_active_note 读取我当前打开的笔记，给出摘要、要点和待办。" },
  { label: "整理今天的笔记", prompt: "读取今天的日记（daily_note），整理成结构化的要点，并补充缺失的 [[双链]]。" },
  { label: "查找未链接的笔记", prompt: "用 list_notes 和 search_notes 找出与当前笔记相关但还没有互相链接的笔记，给出建议的双链。" },
  { label: "写一篇新笔记", prompt: "帮我创建一篇新笔记，先问我主题，然后写大纲、正文，保存到合适的文件夹。" },
];

export class AgentView extends ItemView {
  private plugin: AIConnectedPlugin;
  private chat: ChatSession | null = null;
  private attachments: Attachment[] = [];

  private messagesEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;

  private markdownComponent: Component;
  private busy = false;
  private abort: AbortController | null = null;
  private streamBody: HTMLElement | null = null;
  private streamBuffer = "";
  private streamFrame = 0;
  private liveToolBlock: HTMLElement | null = null;
  private toolBlocks = new Map<string, HTMLElement>();

  constructor(leaf: WorkspaceLeaf, plugin: AIConnectedPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.markdownComponent = new Component();
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT;
  }

  getDisplayText(): string {
    return "AI Agent";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.markdownComponent.load();
    this.buildUi();
    this.openActiveSession();
  }

  async onClose(): Promise<void> {
    this.abort?.abort();
    await this.plugin.chats.save();
    this.markdownComponent.unload();
    this.contentEl.empty();
  }

  // ------------------------------------------------------------------ public API

  focusInput(): void {
    this.inputEl?.focus();
  }

  refreshStatus(): void {
    this.updateStatus();
  }

  insertIntoComposer(text: string, submit = false): void {
    if (!this.inputEl) return;
    const existing = this.inputEl.value;
    this.inputEl.value = existing ? `${existing}\n\n${text}` : text;
    this.autoResize();
    this.inputEl.focus();
    if (submit) void this.send();
  }

  attachContent(label: string, content: string): void {
    this.attachments.push({ label, content });
    this.renderAttachments();
    this.inputEl?.focus();
  }

  async sendText(text: string): Promise<void> {
    if (!this.inputEl) return;
    if (this.busy) {
      new Notice("Agent 正在处理，请稍候或先停止。");
      return;
    }
    this.inputEl.value = text;
    await this.send();
  }

  newChat(): void {
    this.plugin.chats.create();
    this.chat = this.plugin.chats.active;
    this.renderSession();
    this.inputEl?.focus();
  }

  openHistory(): void {
    const store = this.plugin.chats;
    new HistoryModal(
      this.app,
      [...store.sessions],
      this.chat?.id ?? null,
      (id) => {
        const session = store.get(id);
        if (!session) return;
        store.setActive(id);
        this.chat = session;
        this.renderSession();
      },
      (id) => {
        store.remove(id);
        if (this.chat?.id === id) {
          this.chat = store.active ?? store.create();
          this.renderSession();
        }
      },
      () => this.newChat(),
    ).open();
  }

  async exportChat(): Promise<void> {
    if (!this.chat || !this.chat.messages.length) {
      new Notice("当前对话还没有内容。");
      return;
    }
    try {
      const path = await this.plugin.exportSessionToNote(this.chat);
      new Notice(`已导出到 ${path}`);
    } catch (error) {
      new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------------- layout

  private buildUi(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ai-connected-view");

    const header = root.createDiv({ cls: "ai-header" });
    const title = header.createDiv({ cls: "ai-title" });
    const iconEl = title.createSpan({ cls: "ai-title-icon" });
    setIcon(iconEl, "bot");
    title.createSpan({ cls: "ai-title-text", text: "AI Agent" });

    const actions = header.createDiv({ cls: "ai-header-actions" });
    this.iconButton(actions, "plus", "新对话", () => this.newChat());
    this.iconButton(actions, "history", "历史对话", () => this.openHistory());
    this.iconButton(actions, "download", "导出为笔记", () => void this.exportChat());
    this.iconButton(actions, "clipboard-list", "把当前笔记作为附件", () => void this.addActiveNoteAttachment());
    this.iconButton(actions, "settings", "插件设置", () => this.openSettings());

    this.messagesEl = root.createDiv({ cls: "ai-messages" });

    const composer = root.createDiv({ cls: "ai-composer" });
    this.attachmentsEl = composer.createDiv({ cls: "ai-attachments" });
    this.renderAttachments();

    const inputRow = composer.createDiv({ cls: "ai-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "ai-input",
      attr: {
        placeholder: "问问你的笔记库…… （Enter 发送，Shift+Enter 换行）",
        rows: "3",
        "aria-label": "发给 AI Agent 的消息",
      },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoResize());

    const buttonRow = composer.createDiv({ cls: "ai-button-row" });
    this.sendButton = buttonRow.createEl("button", { cls: "ai-send-btn", attr: { "aria-label": "发送" } });
    this.sendButton.createSpan({ text: "发送" });
    const sendIcon = this.sendButton.createSpan({ cls: "ai-send-icon" });
    setIcon(sendIcon, "arrow-up");
    this.sendButton.addEventListener("click", () => void this.send());

    this.stopButton = buttonRow.createEl("button", { cls: "ai-stop-btn", attr: { "aria-label": "停止" } });
    this.stopButton.createSpan({ text: "停止" });
    this.stopButton.addClass("is-hidden");
    this.stopButton.addEventListener("click", () => this.stop());

    this.statusEl = composer.createDiv({ cls: "ai-status" });
    this.updateStatus();
  }

  private iconButton(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "ai-icon-btn", attr: { "aria-label": tooltip, title: tooltip } });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  private renderWelcome(): void {
    const welcome = this.messagesEl.createDiv({ cls: "ai-welcome" });
    welcome.createDiv({ cls: "ai-welcome-title", text: "让 AI 直接读写你的笔记库" });
    welcome.createDiv({
      cls: "ai-welcome-sub",
      text: "Agent 可以搜索、阅读、创建和修改笔记。路径默认相对于笔记库根目录。",
    });
    const list = welcome.createDiv({ cls: "ai-suggestions" });
    for (const suggestion of SUGGESTIONS) {
      const button = list.createEl("button", { cls: "ai-suggestion", text: suggestion.label });
      button.addEventListener("click", () => void this.sendText(suggestion.prompt));
    }
  }

  // ---------------------------------------------------------------- session flow

  private openActiveSession(): void {
    const store = this.plugin.chats;
    this.chat = store.active ?? store.create();
    this.renderSession();
  }

  private renderSession(): void {
    this.messagesEl.empty();
    this.toolBlocks.clear();
    this.liveToolBlock = null;
    const messages = this.chat?.messages ?? [];
    if (!messages.length) {
      this.renderWelcome();
      this.updateStatus();
      return;
    }
    for (const message of messages) this.renderStoredMessage(message);
    this.scrollToBottom();
    this.updateStatus();
  }

  private renderStoredMessage(message: LlmMessage): void {
    if (message.role === "user") {
      this.addUserBubble(visibleUserText(message.content), []);
      return;
    }
    if (message.role === "assistant") {
      if (message.content.trim()) {
        const bubble = this.createAssistantBubble();
        this.renderMarkdown(bubble.body, message.content);
      }
      for (const call of message.tool_calls ?? []) {
        const block = this.addToolBlock(call.function.name, parseArgs(call.function.arguments), "done");
        this.toolBlocks.set(call.id, block);
      }
      return;
    }
    if (message.role === "tool") {
      const block = message.tool_call_id ? this.toolBlocks.get(message.tool_call_id) : undefined;
      if (block) this.appendToolOutput(block, message.content, !message.content.startsWith("错误"));
      else {
        const standalone = this.addToolBlock(message.name ?? "tool", {}, "done");
        this.appendToolOutput(standalone, message.content, true);
      }
    }
  }

  private persist(): void {
    if (!this.chat) return;
    this.plugin.chats.update(this.chat);
  }

  // ------------------------------------------------------------------ attachments

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.empty();
    this.attachmentsEl.toggleClass("is-empty", this.attachments.length === 0);
    this.attachments.forEach((attachment, index) => {
      const chip = this.attachmentsEl.createDiv({ cls: "ai-attachment-chip" });
      const iconEl = chip.createSpan({ cls: "ai-attachment-icon" });
      setIcon(iconEl, "paperclip");
      chip.createSpan({ cls: "ai-attachment-label", text: attachment.label });
      const remove = chip.createEl("button", { cls: "ai-attachment-remove", attr: { "aria-label": "移除附件" } });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.attachments.splice(index, 1);
        this.renderAttachments();
      });
    });
  }

  private async addActiveNoteAttachment(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("当前没有打开任何笔记。");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const truncated = content.length > 20000 ? `${content.slice(0, 20000)}\n\n[... 已截断]` : content;
    this.attachContent(file.path, truncated);
  }

  // ------------------------------------------------------------------------ send

  private async send(): Promise<void> {
    if (this.busy || !this.inputEl) return;
    const raw = this.inputEl.value.trim();
    if (!raw) return;

    if (!this.chat) {
      this.chat = this.plugin.chats.create();
    }
    const chat = this.chat;

    const attachments = this.attachments;
    this.attachments = [];
    this.inputEl.value = "";
    this.autoResize();
    this.renderAttachments();

    const content = await this.composeUserContent(raw, attachments);
    const isFirstMessage = chat.messages.length === 0;
    chat.messages.push({ role: "user", content });
    if (isFirstMessage || !chat.title || chat.title === "新对话") {
      chat.title = deriveTitle(raw);
    }
    this.persist();

    this.clearWelcome();
    this.addUserBubble(raw, attachments);

    await this.runTurn();
  }

  private async composeUserContent(text: string, attachments: Attachment[]): Promise<string> {
    const blocks: string[] = [];
    if (this.plugin.settings.autoAttachActiveNote) {
      const context = await this.plugin.activeNoteContext();
      if (context) blocks.push(context);
    }
    for (const attachment of attachments) {
      blocks.push(`【附件：${attachment.label}】\n${attachment.content}`);
    }
    if (!blocks.length) return text;
    return `${blocks.join("\n\n")}\n\n---\n\n${text}`;
  }

  private async runTurn(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.setBusy(true);
    this.abort = new AbortController();
    this.streamBody = null;
    this.streamBuffer = "";
    this.liveToolBlock = null;

    try {
      chat.messages = await runAgent(chat.messages, {
        cfg: this.plugin.llmConfig(),
        systemPrompt: this.plugin.settings.systemPrompt,
        tools: this.plugin.availableTools(),
        ctx: this.plugin.toolContext(),
        maxSteps: this.plugin.settings.maxSteps,
        signal: this.abort.signal,
        confirm: (tool, args) => this.plugin.confirmTool(tool, args),
        onEvent: (event) => this.handleEvent(event),
      });
    } catch (error) {
      if (isAbortError(error) || this.abort?.signal.aborted) {
        this.addNotice("已停止生成。");
      } else {
        this.addError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.abort = null;
      this.setBusy(false);
      this.persist();
      this.plugin.chats.save();
      this.scrollToBottom();
    }
  }

  private stop(): void {
    if (!this.abort) return;
    this.abort.abort();
    this.addNotice("正在停止……");
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.contentEl.toggleClass("is-busy", busy);
    this.sendButton.toggleClass("is-hidden", busy);
    this.stopButton.toggleClass("is-hidden", !busy);
    if (!busy) this.updateStatus();
    else this.setStatus("思考中…");
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const model = this.plugin.settings.model || "未配置模型";
    const mcp = this.plugin.serverStatusText();
    const saved = this.plugin.settings.persistChatHistory ? "" : " · 历史未保存";
    this.statusEl.setText(`${model} · ${mcp}${saved}`);
  }

  // ---------------------------------------------------------------------- events

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "step":
        this.setStatus(event.index === 0 ? "思考中…" : `继续思考…（第 ${event.index + 1} 步）`);
        break;

      case "assistant_delta": {
        if (!this.streamBody) {
          const bubble = this.createAssistantBubble();
          this.streamBody = bubble.body;
          this.streamBuffer = "";
        }
        this.streamBuffer += event.text;
        this.queueStreamRender();
        break;
      }

      case "assistant_message": {
        const body = this.streamBody;
        this.streamBody = null;
        this.streamBuffer = "";
        if (body) {
          if (event.text.trim()) this.renderMarkdown(body, event.text);
          else body.closest(".ai-msg")?.remove();
        } else if (event.text.trim()) {
          const bubble = this.createAssistantBubble();
          this.renderMarkdown(bubble.body, event.text);
        }
        break;
      }

      case "tool_start":
        this.setStatus(`调用工具：${event.name}`);
        this.liveToolBlock = this.addToolBlock(event.name, event.args, "running");
        break;

      case "tool_end":
        this.completeToolBlock(event.text, event.ok);
        this.persist();
        this.setStatus(event.ok ? "思考中…" : `工具出错：${event.name}`);
        break;

      case "error":
        this.addError(event.message);
        break;
    }
    this.scrollToBottom();
  }

  private queueStreamRender(): void {
    if (this.streamFrame) return;
    this.streamFrame = window.requestAnimationFrame(() => {
      this.streamFrame = 0;
      if (this.streamBody) this.streamBody.setText(this.streamBuffer);
      this.scrollToBottom();
    });
  }

  // -------------------------------------------------------------------- messages

  private clearWelcome(): void {
    this.messagesEl.querySelector(".ai-welcome")?.remove();
  }

  private addUserBubble(text: string, attachments: Attachment[]): void {
    const wrapper = this.messagesEl.createDiv({ cls: "ai-msg ai-msg-user" });
    const bubble = wrapper.createDiv({ cls: "ai-bubble" });
    const body = bubble.createDiv({ cls: "ai-bubble-text" });
    body.setText(text);
    if (attachments.length) {
      const chips = bubble.createDiv({ cls: "ai-bubble-chips" });
      for (const attachment of attachments) {
        const chip = chips.createSpan({ cls: "ai-bubble-chip" });
        const iconEl = chip.createSpan();
        setIcon(iconEl, "paperclip");
        chip.createSpan({ text: attachment.label });
      }
    }
    this.scrollToBottom();
  }

  private createAssistantBubble(): { root: HTMLElement; body: HTMLElement } {
    const root = this.messagesEl.createDiv({ cls: "ai-msg ai-msg-assistant" });
    const avatar = root.createDiv({ cls: "ai-avatar" });
    setIcon(avatar, "bot");
    const body = root.createDiv({ cls: "ai-bubble ai-markdown" });
    this.scrollToBottom();
    return { root, body };
  }

  private addToolBlock(name: string, args: Record<string, any>, state: "running" | "done" | "error"): HTMLElement {
    const details = this.messagesEl.createEl("details", {
      cls: "ai-tool",
      attr: { "data-tool": name },
    });
    details.addEventListener("toggle", () => this.scrollToBottom());
    const summary = details.createEl("summary", { cls: "ai-tool-summary" });
    const iconEl = summary.createSpan({ cls: "ai-tool-icon" });
    setIcon(iconEl, "wrench");
    summary.createSpan({ cls: "ai-tool-name", text: name });
    summary.createSpan({ cls: "ai-tool-status", text: state === "running" ? "运行中…" : "完成" });
    const pre = details.createEl("pre", { cls: "ai-tool-args" });
    pre.setText(JSON.stringify(args, null, 2));
    details.setAttr("data-state", state);
    if (state === "running") details.setAttr("open", "true");
    return details;
  }

  private completeToolBlock(text: string, ok: boolean): void {
    const target = this.liveToolBlock;
    this.liveToolBlock = null;
    if (!target) return;
    this.appendToolOutput(target, text, ok);
  }

  private appendToolOutput(block: HTMLElement, text: string, ok: boolean): void {
    block.setAttr("data-state", ok ? "done" : "error");
    const status = block.querySelector(".ai-tool-status");
    if (status) status.setText(ok ? "完成" : "失败");
    const output = block.createEl("pre", { cls: "ai-tool-output" });
    output.setText(text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text);
  }

  private addNotice(text: string): void {
    this.messagesEl.createDiv({ cls: "ai-notice", text });
  }

  private addError(message: string): void {
    this.messagesEl.createDiv({ cls: "ai-error", text: message });
  }

  private renderMarkdown(el: HTMLElement, markdown: string): void {
    el.empty();
    el.addClass("ai-markdown");
    MarkdownRenderer.render(this.app, markdown, el, "", this.markdownComponent).catch((error) => {
      el.setText(markdown);
      console.error("[ai-connected] markdown render failed", error);
    });
  }

  // ----------------------------------------------------------------------- helpers

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private autoResize(): void {
    if (!this.inputEl) return;
    this.inputEl.setCssProps({ height: "auto" });
    this.inputEl.setCssProps({ height: `${Math.min(220, this.inputEl.scrollHeight)}px` });
  }

  private openSettings(): void {
    const setting = (this.app as any).setting;
    try {
      setting?.open?.();
      setting?.openTabById?.(this.plugin.manifest.id);
    } catch (error) {
      console.error("[ai-connected] cannot open settings", error);
    }
  }
}

function parseArgs(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Restored user messages carry the context preamble; show only what the user typed. */
function visibleUserText(content: string): string {
  const marker = content.lastIndexOf("\n\n---\n\n");
  if (marker > 0 && content.slice(0, marker).includes("【")) {
    return content.slice(marker + 7).trim();
  }
  return content;
}
