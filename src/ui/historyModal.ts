import { App, Modal, Notice, setIcon } from "obsidian";
import type { ChatSession } from "../agent/chatStore";
import { formatTime } from "../agent/chatStore";

/** Searchable list of saved conversations. */
export class HistoryModal extends Modal {
  private listEl!: HTMLElement;
  private query = "";

  constructor(
    app: App,
    private readonly sessions: ChatSession[],
    private readonly currentId: string | null,
    private readonly onSelect: (id: string) => void,
    private readonly onDelete: (id: string) => void,
    private readonly onNew: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-history-modal");
    this.titleEl.setText("对话历史");

    const search = contentEl.createEl("input", {
      cls: "ai-history-search",
      attr: { type: "search", placeholder: "搜索对话标题或内容…" },
    });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "ai-history-list" });
    this.renderList();

    const footer = contentEl.createDiv({ cls: "ai-history-footer" });
    const newButton = footer.createEl("button", { cls: "mod-cta", text: "新建对话" });
    newButton.addEventListener("click", () => {
      this.onNew();
      this.close();
    });
    search.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderList(): void {
    this.listEl.empty();
    const visible = this.sessions.filter((session) => this.matches(session));

    if (!visible.length) {
      this.listEl.createDiv({
        cls: "ai-history-empty",
        text: this.sessions.length ? "没有匹配的对话" : "还没有保存过对话",
      });
      return;
    }

    for (const session of visible) {
      const item = this.listEl.createDiv({ cls: "ai-history-item" });
      if (session.id === this.currentId) item.addClass("is-current");

      const main = item.createDiv({ cls: "ai-history-main" });
      const titleRow = main.createDiv({ cls: "ai-history-title-row" });
      titleRow.createSpan({ cls: "ai-history-title", text: session.title || "未命名对话" });
      if (session.id === this.currentId) titleRow.createSpan({ cls: "ai-history-badge", text: "当前" });

      const meta = main.createDiv({ cls: "ai-history-meta" });
      meta.setText(`${formatTime(session.updatedAt)} · ${session.messages.length} 条消息`);

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
        this.onDelete(session.id);
        item.remove();
        new Notice("对话已删除");
        if (!this.listEl.querySelector(".ai-history-item")) this.renderList();
      });

      item.addEventListener("click", () => {
        this.onSelect(session.id);
        this.close();
      });
    }
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
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
}
