import { App, Modal, Setting } from "obsidian";

type Mode = "create" | "unlock";

/** Collects a passphrase for encrypting or unlocking the stored API key. */
export class PassphraseModal extends Modal {
  private value = "";
  private confirmValue = "";
  private resolveFn: (value: string | null) => void = () => undefined;
  private settled = false;

  private constructor(
    app: App,
    private readonly mode: Mode,
    private readonly message: string,
  ) {
    super(app);
  }

  static ask(app: App, mode: Mode, message: string): Promise<string | null> {
    const modal = new PassphraseModal(app, mode, message);
    return new Promise<string | null>((resolve) => {
      modal.resolveFn = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.mode === "create" ? "设置加密口令" : "输入口令解锁");

    contentEl.createEl("p", { cls: "ai-passphrase-hint", text: this.message });

    const first = contentEl.createEl("input", {
      cls: "ai-passphrase-input",
      attr: {
        type: "password",
        placeholder: this.mode === "create" ? "输入新口令（至少 6 位）" : "输入口令",
        "aria-label": "口令",
      },
    });
    first.addEventListener("input", () => {
      this.value = first.value;
      this.updateConfirmState();
    });
    first.focus();

    let second: HTMLInputElement | null = null;
    if (this.mode === "create") {
      second = contentEl.createEl("input", {
        cls: "ai-passphrase-input",
        attr: { type: "password", placeholder: "再输入一次", "aria-label": "确认口令" },
      });
      second.addEventListener("input", () => {
        this.confirmValue = second?.value ?? "";
        this.updateConfirmState();
      });
    }

    const warning = contentEl.createEl("p", { cls: "ai-warning ai-passphrase-warning" });
    warning.setText(
      this.mode === "create"
        ? "口令不会保存。忘记口令只能重新填写 API Key，请自行记牢。"
        : "口令仅用于本次会话解密，退出 Obsidian 后需再次输入。",
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.finish(null);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(this.mode === "create" ? "加密" : "解锁")
          .setCta()
          .onClick(() => {
            if (!this.isValid()) return;
            this.finish(this.value);
          }),
      );

    const submit = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.isValid()) this.finish(this.value);
    };
    first.addEventListener("keydown", submit);
    second?.addEventListener("keydown", submit);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveFn(null);
    }
  }

  private isValid(): boolean {
    if (this.value.length < 6) return false;
    if (this.mode === "create" && this.value !== this.confirmValue) return false;
    return true;
  }

  private updateConfirmState(): void {
    // Keep the button state in sync without rebuilding the modal.
    const buttons = this.contentEl.querySelectorAll("button");
    const primary = buttons[buttons.length - 1] as HTMLButtonElement | undefined;
    if (primary) primary.disabled = !this.isValid();
  }

  private finish(value: string | null): void {
    this.settled = true;
    this.resolveFn(value);
    this.close();
  }
}
