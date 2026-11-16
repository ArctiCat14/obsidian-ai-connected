import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AIConnectedPlugin from "../main";
import { type ChatSession, formatTime, groupSessionsByDate } from "./chatStore";
import { ConfirmModal } from "../ui/confirmModal";

export const VIEW_TYPE_HISTORY = "ai-connected-history";

/** Persistent conversation list, meant to live in the left sidebar. */
export class HistoryView extends ItemView {
  private plugin: AIConnectedPlugin;
  private query = "";
  private listEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AIConnectedPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HISTORY;
  }

  getDisplayText(): string {
    return "AI 对话";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.buildUi();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Re-render the list in place, keeping the search box focused. */
  refresh(): void {
    if (!this.listEl) return;
    this.renderList();
  }

  private buildUi(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ai-history-view");

    const header = root.createDiv({ cls: "ai-history-header" });
    const search = header.createEl("input", {
      cls: "ai-history-search",
      attr: { type: "search", placeholder: "搜索对话…", "aria-label": "搜索对话" },
    });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    const newButton = header.createEl("button", {
      cls: "ai-history-new",
      attr: { "aria-label": "新建对话", title: "新建对话" },
    });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", () => void this.newChat());

    this.listEl = root.createDiv({ cls: "ai-history-list" });
    this.renderList();
  }

  private async newChat(): Promise<void> {
    await this.plugin.startNewChat();
    this.refresh();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();

    const sessions = this.plugin.chats.sessions.filter((session) => this.matches(session));
    if (!sessions.length) {
      const empty = list.createDiv({ cls: "ai-history-empty" });
      empty.setText(this.plugin.chats.sessions.length ? "没有匹配的对话" : "还没有对话\n点击右上角 + 开始");
      return;
    }

    for (const group of groupSessionsByDate(sessions)) {
      const groupEl = list.createDiv({ cls: "ai-history-group" });
      groupEl.createDiv({ cls: "ai-history-group-title", text: group.label });
      for (const session of group.sessions) this.renderItem(groupEl, session);
    }

    list.createDiv({ cls: "ai-history-footer-note", text: `共 ${this.plugin.chats.sessions.length} 段对话` });
  }

  private renderItem(parent: HTMLElement, session: ChatSession): void {
    const item = parent.createDiv({ cls: "ai-history-item" });
    if (session.id === this.plugin.chats.activeId) item.addClass("is-current");

    const main = item.createDiv({ cls: "ai-history-main" });
    const titleRow = main.createDiv({ cls: "ai-history-title-row" });
    titleRow.createSpan({ cls: "ai-history-title", text: session.title || "未命名对话" });
    if (session.id === this.plugin.chats.activeId) {
      titleRow.createSpan({ cls: "ai-history-badge", text: "当前" });
    }

    const meta = main.createDiv({ cls: "ai-history-meta" });
    meta.setText(`${formatTime(session.updatedAt)} · ${session.messages.length} 条`);

    const preview = main.createDiv({ cls: "ai-history-preview" });
    preview.setText(this.previewOf(session));

    const actions = item.createDiv({ cls: "ai-history-actions" });
    const deleteButton = actions.createEl("button", {
      cls: "ai-icon-btn",
      attr: { "aria-label": "删除这段对话", title: "删除" },
    });
    setIcon(deleteButton, "trash-2");
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.confirmDelete(session);
    });

    item.addEventListener("click", () => {
      void this.plugin.openSession(session.id);
    });
  }

  private async confirmDelete(session: ChatSession): Promise<void> {
    const ok = await ConfirmModal.ask(
      this.app,
      "删除这段对话？",
      `「${session.title || "未命名对话"}」将从历史记录中移除，无法恢复。`,
    );
    if (!ok) return;
    await this.plugin.deleteChatSession(session.id);
    new Notice("对话已删除");
    this.refresh();
  }

  private matches(session: ChatSession): boolean {
    if (!this.query) return true;
    if (session.title.toLowerCase().includes(this.query)) return true;
    return session.messages.some((message) => message.content.toLowerCase().includes(this.query));
  }

  private previewOf(session: ChatSession): string {
    const last = [...session.messages].reverse().find((message) => message.content.trim());
    if (!last) return "（空对话）";
    const text = last.content.replace(/【[^】]*】/g, " ").replace(/\s+/g, " ").trim();
    return text.length > 70 ? `${text.slice(0, 70)}…` : text;
  }
}
