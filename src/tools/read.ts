import { MarkdownView, TFile, TFolder } from "obsidian";
import { json, ok, ToolResult, ToolContext } from "./types";
import {
  clampInt,
  ensureParentFolder,
  formatBytes,
  isoTime,
  normalizeUserPath,
  requireNote,
  truncate,
  wordCount,
} from "./helpers";

const DEFAULT_MAX_CHARS = 60000;

function noteHeader(path: string, size: number, mtime: number): string {
  return `--- ${path} | ${formatBytes(size)} | modified ${isoTime(mtime)} ---`;
}

export async function readNote(file: TFile, ctx: ToolContext, maxChars: number): Promise<ToolResult> {
  const raw = await ctx.app.vault.cachedRead(file);
  const { text, truncated } = truncate(raw, maxChars);
  const header = noteHeader(file.path, file.stat.size, file.stat.mtime);
  const footer = truncated
    ? `\n\n[... 内容已截断：显示前 ${maxChars} / 共 ${raw.length} 字符。可提高 maxChars 或先用 search_notes 定位。]`
    : "";
  return ok(`${header}\n${text}${footer}`);
}

export const readTools = [
  {
    name: "list_notes",
    title: "List notes",
    description:
      "List markdown notes in the vault (path, size, modified time). Use `folder` to scope to a directory and `pattern` for a glob such as 'projects/**/*.md'. Returns at most `limit` notes plus the total count.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        folder: { type: "string", description: "Vault-relative folder, e.g. 'Projects'. Omit for the whole vault." },
        pattern: { type: "string", description: "Optional glob applied to full paths, supports * and **." },
        recursive: { type: "boolean", description: "Include subfolders. Default true." },
        limit: { type: "number", description: "Max notes to return (1-2000). Default 200." },
        sort: { type: "string", enum: ["path", "modified", "created"], description: "Sort order. Default path." },
      },
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const folder = typeof args.folder === "string" ? normalizeUserPath(args.folder) : "";
      const recursive = args.recursive !== false;
      const limit = clampInt(args.limit, 1, 2000, 200);
      const sort = args.sort === "modified" || args.sort === "created" ? args.sort : "path";
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";

      let files = app.vault.getMarkdownFiles();
      if (folder) {
        const prefix = folder + "/";
        files = files.filter(
          (f) => f.path.startsWith(prefix) && (recursive || f.path.slice(prefix.length).indexOf("/") === -1),
        );
      }
      if (pattern) {
        const re = new RegExp(
          "^" +
            pattern
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "\uE000")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]")
              .replace(/\uE000/g, ".*") +
            "$",
          "i",
        );
        files = files.filter((f) => re.test(f.path));
      }

      const total = files.length;
      files.sort((a, b) => {
        if (sort === "modified") return b.stat.mtime - a.stat.mtime;
        if (sort === "created") return b.stat.ctime - a.stat.ctime;
        return a.path.localeCompare(b.path);
      });
      const notes = files.slice(0, limit).map((f) => ({
        path: f.path,
        size: f.stat.size,
        modified: isoTime(f.stat.mtime),
      }));
      return json({ total, returned: notes.length, truncated: total > notes.length, notes });
    },
  },

  {
    name: "read_note",
    title: "Read note",
    description:
      "Read the full markdown content of one note. Path may be relative to the vault root or just the note name when unambiguous. Long notes are truncated at maxChars.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path such as 'Inbox/Idea.md', or a unique note name." },
        maxChars: { type: "number", description: `Max characters returned (default ${DEFAULT_MAX_CHARS}).` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const file = requireNote(ctx.app, args.path);
      const maxChars = clampInt(args.maxChars, 500, 400000, DEFAULT_MAX_CHARS);
      return readNote(file, ctx, maxChars);
    },
  },

  {
    name: "get_metadata",
    title: "Get note metadata",
    description:
      "Return structured metadata for one note: frontmatter properties, tags, headings outline, internal/external links, backlinks and word count. Does not return the note body.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path or unique note name." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const file = requireNote(app, args.path);
      const cache = app.metadataCache.getFileCache(file);
      const raw = await app.vault.cachedRead(file);

      const tags = new Set<string>();
      for (const t of cache?.tags ?? []) tags.add(t.tag.replace(/^#/, ""));
      for (const t of normalizeTagFrontmatter(cache?.frontmatter?.tags)) tags.add(t.replace(/^#/, ""));

      const headings = (cache?.headings ?? []).map((h) => ({ level: h.level, heading: h.heading }));
      const links = (cache?.links ?? []).map((l) => l.link);
      const embeds = (cache?.embeds ?? []).map((l) => l.link);
      const backlinks = collectBacklinks(app.metadataCache.resolvedLinks, file.path);

      return json({
        path: file.path,
        basename: file.basename,
        folder: file.parent?.path === "/" ? "" : file.parent?.path ?? "",
        size: file.stat.size,
        created: isoTime(file.stat.ctime),
        modified: isoTime(file.stat.mtime),
        frontmatter: cache?.frontmatter ?? {},
        tags: Array.from(tags),
        headings,
        links,
        embeds,
        backlinks,
        wordCount: wordCount(raw),
        charCount: raw.length,
        lineCount: raw.split("\n").length,
      });
    },
  },

  {
    name: "get_active_note",
    title: "Get active note",
    description:
      "Return the note currently open in Obsidian, including the current text selection (if any) and cursor position. Optionally include the note body. Use this to understand what the user is looking at.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        includeContent: { type: "boolean", description: "Include the note body. Default true." },
        maxChars: { type: "number", description: "Max characters of body content. Default 20000." },
      },
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const file = app.workspace.getActiveFile();
      if (!file) return json({ active: null, message: "当前没有打开任何笔记" });
      const view = app.workspace.getActiveViewOfType(MarkdownView);
      let selection = "";
      let cursor: { line: number; ch: number } | null = null;
      try {
        if (view?.editor) {
          selection = view.editor.getSelection() ?? "";
          const c = view.editor.getCursor();
          cursor = { line: c.line, ch: c.ch };
        }
      } catch {
        /* editor not available */
      }
      const includeContent = args.includeContent !== false;
      const maxChars = clampInt(args.maxChars, 1000, 200000, 20000);
      let content: string | undefined;
      let truncated = false;
      if (includeContent) {
        const raw = await app.vault.cachedRead(file);
        const cut = truncate(raw, maxChars);
        content = cut.text;
        truncated = cut.truncated;
      }
      return json({ active: file.path, selection, cursor, truncated, content });
    },
  },

  {
    name: "list_tags",
    title: "List tags",
    description: "List all tags used in the vault with usage counts, most used first.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max tags to return (1-1000). Default 200." },
      },
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const limit = clampInt(args.limit, 1, 1000, 200);
      const counts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) continue;
        const seen = new Set<string>();
        for (const t of cache.tags ?? []) seen.add(t.tag.replace(/^#/, ""));
        for (const t of normalizeTagFrontmatter(cache.frontmatter?.tags)) seen.add(t.replace(/^#/, ""));
        for (const tag of seen) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const tags = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([tag, count]) => ({ tag, count }));
      return json({ total: counts.size, returned: tags.length, tags });
    },
  },

  {
    name: "daily_note",
    title: "Daily note",
    description:
      "Get (and create if missing) the daily note for a date, following the Daily Notes plugin settings. Can append text to it in the same call. Returns the note path and content.",
    readOnly: false,
    inputSchema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date as YYYY-MM-DD. Defaults to today." },
        append: { type: "string", description: "Optional markdown to append to the daily note." },
        open: { type: "boolean", description: "Open the note in the active leaf. Default false." },
      },
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const config = getDailyNoteConfig(app);
      const dateArg = typeof args.date === "string" ? args.date.trim() : "";
      const date = dateArg ? new Date(`${dateArg}T00:00:00`) : new Date();
      if (Number.isNaN(date.getTime())) throw new Error(`无效日期："${dateArg}"，请使用 YYYY-MM-DD`);

      const name = formatDate(date, config.format);
      const path = config.folder ? `${config.folder}/${name}.md` : `${name}.md`;
      let file = app.vault.getAbstractFileByPath(path);
      let created = false;
      if (!(file instanceof TFile)) {
        await ensureParentFolder(app, path);
        file = await app.vault.create(path, "");
        created = true;
      }
      if (!(file instanceof TFile)) throw new Error(`无法创建日记：${path}`);
      const target = file;
      const appendText = typeof args.append === "string" ? args.append : "";
      if (appendText.trim()) {
        const existing = await app.vault.read(target);
        const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
        await app.vault.modify(target, existing + sep + appendText);
      }
      if (args.open === true) {
        await app.workspace.getLeaf(false).openFile(target);
      }
      const content = await app.vault.read(target);
      const cut = truncate(content, 20000);
      return json({ path, created, content: cut.text, truncated: cut.truncated });
    },
  },

  {
    name: "workspace_info",
    title: "Vault overview",
    description:
      "High level overview of the workspace: vault name, note/folder counts, top level folders, the active note, daily note settings and whether the vault is in read-only mode.",
    readOnly: true,
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    async run(_args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const files = app.vault.getMarkdownFiles();
      const all = app.vault.getAllLoadedFiles();
      const folders = all
        .filter((f): f is TFolder => f instanceof TFolder)
        .map((f) => f.path)
        .filter((p) => p !== "/" && p !== "");
      const topLevel = folders.filter((p) => !p.includes("/")).sort();
      const vaultPath = (app.vault.adapter as any).getBasePath?.() ?? "";
      const active = app.workspace.getActiveFile();
      const daily = getDailyNoteConfig(app);
      return json({
        vaultName: app.vault.getName(),
        vaultPath,
        noteCount: files.length,
        fileCount: all.length - folders.length,
        folderCount: folders.length,
        topLevelFolders: topLevel.slice(0, 100),
        activeNote: active?.path ?? null,
        dailyNotes: { folder: daily.folder, format: daily.format },
        readOnly: ctx.settings.mcpReadOnly,
      });
    },
  },
];

function normalizeTagFrontmatter(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

function collectBacklinks(resolvedLinks: Record<string, Record<string, number>>, target: string): string[] {
  const out: string[] = [];
  for (const [source, targets] of Object.entries(resolvedLinks ?? {})) {
    if (targets && Object.prototype.hasOwnProperty.call(targets, target) && source !== target) {
      out.push(source);
    }
  }
  return out.sort();
}

export interface DailyNoteConfig {
  folder: string;
  format: string;
}

export function getDailyNoteConfig(app: any): DailyNoteConfig {
  try {
    const internal = app.internalPlugins?.getPluginById?.("daily-notes");
    const options = internal?.instance?.options ?? {};
    const folder = typeof options.folder === "string" ? options.folder.replace(/^\/+|\/+$/g, "") : "";
    const format = typeof options.format === "string" && options.format.trim() ? options.format : "YYYY-MM-DD";
    return { folder, format };
  } catch {
    return { folder: "", format: "YYYY-MM-DD" };
  }
}

function formatDate(date: Date, format: string): string {
  const moment = (window as any).moment;
  if (typeof moment === "function") return moment(date).format(format);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
