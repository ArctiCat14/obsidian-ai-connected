/**
 * Minimal stand-in for the `obsidian` module so the plugin's server + tools can be
 * exercised in plain Node (see `test/mcp.test.ts`). Only the surface used by the
 * bundled code is implemented.
 */

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { size: 0, mtime: 0, ctime: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Component {
  load(): void {}
  unload(): void {}
}

export function normalizePath(path: string): string {
  const cleaned = String(path)
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return cleaned || "/";
}

export class MarkdownView {}
export class ItemView {}
export class Plugin {}
export class Modal {}
export class Setting {}
export class PluginSettingTab {}
export class Notice {
  constructor(_message?: string, _timeout?: number) {}
}
export class WorkspaceLeaf {}
export function setIcon(): void {}
export const MarkdownRenderer = { render: async (): Promise<void> => undefined };
export const moment = () => ({ format: (f: string) => f });
export const Platform = { isDesktopApp: true, isMobile: false, isMobileApp: false };
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in tests");
}
export const App = class {};
export type App = any;
