import { App, Modal, Setting } from "obsidian";

/** Small promise-based confirmation dialog used before destructive tool calls. */
export class ConfirmModal extends Modal {
  private resolved = false;
  private resolveFn: (value: boolean) => void = () => undefined;

  private constructor(
    app: App,
    private readonly heading: string,
    private readonly bodyText: string,
  ) {
    super(app);
  }

  static ask(app: App, heading: string, bodyText: string): Promise<boolean> {
    const modal = new ConfirmModal(app, heading, bodyText);
    return new Promise<boolean>((resolve) => {
      modal.resolveFn = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.heading);
    const pre = contentEl.createEl("pre", { cls: "ai-confirm-body" });
    pre.setText(this.bodyText);

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.finish(false);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("确认执行")
          .setWarning()
          .onClick(() => {
            this.finish(true);
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolveFn(false);
    }
  }

  private finish(value: boolean): void {
    this.resolved = true;
    this.resolveFn(value);
    this.close();
  }
}
