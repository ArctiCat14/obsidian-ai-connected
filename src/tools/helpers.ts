import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

/** Characters/patterns that we never allow tools to touch. */
const FORBIDDEN_PREFIXES = [".obsidian", ".trash", ".git", ".npm-cache"];

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/**
 * Turns arbitrary user/agent input into a clean vault-relative path.
 * Rejects `..` traversal and absolute paths.
 */
export function normalizeUserPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let p = raw.trim();
  if (!p) return "";
  // Accept obsidian:// URIs and plain paths.
  p = p.replace(/^obsidian:\/\/(?:open|new)?\??(?:vault=[^&]*&file=)?/i, "");
  p = p.replace(/^obsidian:\/\/[^/]*\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw string */
  }
  p = toPosix(p).replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) {
    throw new Error(`非法路径 "${raw}"：不允许使用 ".." 跳出笔记库`);
  }
  if (!parts.length) return "";
  return normalizePath(parts.join("/"));
}

export function stripMarkdownExt(p: string): string {
  return p.replace(/\.md$/i, "");
}

export function assertWritablePath(path: string): void {
  const lower = path.toLowerCase();
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + "/")) {
      throw new Error(`路径 "${path}" 位于受保护的目录（${prefix}），插件拒绝写入`);
    }
  }
}

export function looksLikeMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Resolve a user supplied reference to one or more note files (fuzzy). */
export function findNotes(app: App, raw: unknown): TFile[] {
  const p = normalizeUserPath(raw);
  if (!p) return [];
  const vault = app.vault;

  const direct = vault.getAbstractFileByPath(p);
  if (direct instanceof TFile) return [direct];

  const withMd = looksLikeMarkdown(p) ? p : `${p}.md`;
  const second = vault.getAbstractFileByPath(withMd);
  if (second instanceof TFile) return [second];

  const files = vault.getMarkdownFiles();
  const lowerFull = withMd.toLowerCase();
  const exact = files.filter((f) => f.path.toLowerCase() === lowerFull);
  if (exact.length) return exact;

  const bare = stripMarkdownExt(p).toLowerCase();
  const byName = files.filter((f) => f.basename.toLowerCase() === bare);
  if (byName.length) return byName;

  const bySuffix = files.filter((f) => f.path.toLowerCase().endsWith("/" + lowerFull));
  if (bySuffix.length) return bySuffix;

  const byNameSuffix = files.filter(
    (f) => stripMarkdownExt(f.path).toLowerCase().endsWith("/" + bare) || f.basename.toLowerCase().endsWith(bare),
  );
  return byNameSuffix;
}

/** Like findNotes, but throws a helpful error when the reference is missing/ambiguous. */
export function requireNote(app: App, raw: unknown): TFile {
  const matches = findNotes(app, raw);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`找不到笔记："${String(raw)}"。可以先用 list_notes 或 search_notes 定位准确路径。`);
  }
  const candidates = matches.slice(0, 8).map((f) => f.path).join("\n- ");
  throw new Error(`路径 "${String(raw)}" 匹配到多篇笔记，请写完整路径：\n- ${candidates}`);
}

export async function ensureFolder(app: App, dir: string): Promise<void> {
  const clean = normalizeUserPath(dir);
  if (!clean) return;
  const segments = clean.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing instanceof TFile) throw new Error(`无法创建文件夹："${current}" 已被同名文件占用`);
    await app.vault.createFolder(current);
  }
}

export async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf("/");
  if (idx <= 0) return;
  await ensureFolder(app, filePath.slice(0, idx));
}

/** Resolve a path that may point at a folder; returns "" for the vault root. */
export function normalizeFolder(raw: unknown): string {
  const p = normalizeUserPath(raw);
  return p === "/" ? "" : p;
}

export function isUnderFolder(file: TFile, folder: string, recursive: boolean): boolean {
  if (!folder) return true;
  const prefix = folder + "/";
  if (file.path.startsWith(prefix)) {
    return recursive || file.path.slice(prefix.length).indexOf("/") === -1;
  }
  return false;
}

export function parentPathOf(file: TAbstractFile): string {
  const parent = (file as any).parent as TFolder | null | undefined;
  const p = parent?.path ?? "";
  return p === "/" ? "" : p;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function isoTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function wordCount(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9_][A-Za-z0-9_'’-]*/g)?.length ?? 0;
  return cjk + latin;
}

/** Very small glob matcher: supports *, **, ?. Case insensitive. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function normalizeTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
      .flatMap((v) => v.split(/[,\s]+/))
      .filter(Boolean);
  }
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").trim().toLowerCase();
}

/** Move a file to the Obsidian trash (recoverable). */
export async function trashFile(app: App, file: TAbstractFile): Promise<void> {
  const fm = app.fileManager as any;
  if (typeof fm.trashFile === "function") {
    await fm.trashFile(file);
    return;
  }
  await fm.trash(file);
}
