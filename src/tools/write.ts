import { TFile } from "obsidian";
import { json, ok, ToolContext, ToolResult } from "./types";
import {
  assertWritablePath,
  ensureParentFolder,
  findNotes,
  isoTime,
  normalizeUserPath,
  requireNote,
  trashFile,
} from "./helpers";

function normalizeTargetPath(raw: unknown): string {
  let path = normalizeUserPath(raw);
  if (!path) throw new Error("path 不能为空");
  if (!/\.[a-z0-9]{1,8}$/i.test(path)) path = `${path}.md`;
  assertWritablePath(path);
  return path;
}

export const writeTools = [
  {
    name: "write_note",
    title: "Create or overwrite note",
    description:
      "Create a note, or replace its entire content when it already exists (set overwrite=false to fail instead). Parent folders are created automatically. Prefer append_note / patch_note for small edits.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path, e.g. 'Projects/Plan.md'. '.md' is added when missing." },
        content: { type: "string", description: "Full markdown content of the note." },
        overwrite: { type: "boolean", description: "Replace an existing note. Default true." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const path = normalizeTargetPath(args.path);
      const content = typeof args.content === "string" ? args.content : "";
      const overwrite = args.overwrite !== false;

      const existing = app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) {
        throw new Error(`"${path}" 是一个文件夹，无法写入笔记`);
      }
      if (existing instanceof TFile) {
        if (!overwrite) throw new Error(`笔记已存在：${path}。如需覆盖请传 overwrite=true`);
        await app.vault.modify(existing, content);
        return json({ path, created: false, chars: content.length, modified: isoTime(Date.now()) });
      }
      await ensureParentFolder(app, path);
      await app.vault.create(path, content);
      return json({ path, created: true, chars: content.length });
    },
  },

  {
    name: "append_note",
    title: "Append to note",
    description:
      "Append markdown to the end of an existing note. Creates the note when it does not exist. Good for daily logs, meeting notes and changelogs.",
    readOnly: false,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path or unique note name." },
        content: { type: "string", description: "Markdown to append." },
        createIfMissing: { type: "boolean", description: "Create the note when missing. Default true." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const addition = typeof args.content === "string" ? args.content : "";
      if (!addition.trim()) throw new Error("content 不能为空");

      const matches = findNotes(app, args.path);
      if (matches.length > 1) {
        throw new Error(`路径 "${String(args.path)}" 匹配到多篇笔记，请写完整路径：${matches.map((m) => m.path).join("、")}`);
      }
      const file = matches[0];

      if (!file) {
        if (args.createIfMissing === false) throw new Error(`找不到笔记：${String(args.path)}`);
        const path = normalizeTargetPath(args.path);
        await ensureParentFolder(app, path);
        await app.vault.create(path, addition);
        return json({ path, created: true, appendedChars: addition.length });
      }

      const existing = await app.vault.read(file);
      const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      const combined = existing + separator + addition;
      await app.vault.modify(file, combined);
      return json({
        path: file.path,
        created: false,
        appendedChars: addition.length,
        totalChars: combined.length,
      });
    },
  },

  {
    name: "patch_note",
    title: "Patch note",
    description:
      "Make a surgical edit without rewriting the whole note. Modes: 'replace' swaps an exact text block (oldText -> newText), 'insert_after_heading' inserts markdown right below a heading, 'replace_section' replaces the body of a section (until the next heading of the same or higher level).",
    readOnly: false,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path or unique note name." },
        mode: {
          type: "string",
          enum: ["replace", "insert_after_heading", "replace_section"],
          description: "Edit mode. Default replace.",
        },
        oldText: { type: "string", description: "Exact text to replace (mode=replace)." },
        newText: { type: "string", description: "Replacement / inserted markdown." },
        heading: { type: "string", description: "Heading text without # marks (heading modes)." },
        all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const file = requireNote(app, args.path);
      const original = await app.vault.read(file);
      const mode = typeof args.mode === "string" ? args.mode : "replace";
      const newText = typeof args.newText === "string" ? args.newText : "";

      let updated: string;

      if (mode === "replace") {
        const oldText = typeof args.oldText === "string" ? args.oldText : "";
        if (!oldText) throw new Error("mode=replace 需要 oldText");
        const parts = original.split(oldText);
        const count = parts.length - 1;
        if (count === 0) {
          throw new Error("在笔记中没有找到 oldText，请先 read_note 确认原文（包括空格和换行）");
        }
        if (count > 1 && args.all !== true) {
          throw new Error(`oldText 匹配到 ${count} 处，请提供更长的上下文，或传 all=true 全部替换`);
        }
        updated = args.all === true ? parts.join(newText) : original.replace(oldText, () => newText);
      } else if (mode === "insert_after_heading" || mode === "replace_section") {
        const heading = typeof args.heading === "string" ? args.heading.trim() : "";
        if (!heading) throw new Error(`mode=${mode} 需要 heading`);
        const lines = original.split("\n");
        const index = findHeadingLineIndex(lines, heading);
        if (index < 0) throw new Error(`没有找到标题："${heading}"`);
        const level = lines[index].match(/^#{1,6}/)?.[0].length ?? 1;
        const end = findSectionEnd(lines, index, level);

        const headPart = lines.slice(0, index + 1).join("\n");
        const tailPart = lines.slice(end).join("\n").replace(/^\n+/, "");
        const insert = newText.replace(/^\n+/, "").replace(/\n+$/, "");
        const pieces = [headPart];
        if (insert.trim()) pieces.push(insert);
        if (mode === "insert_after_heading") {
          const sectionBody = lines
            .slice(index + 1, end)
            .join("\n")
            .replace(/^\n+/, "")
            .replace(/\n+$/, "");
          if (sectionBody.trim()) pieces.push(sectionBody);
        }
        if (tailPart.trim()) pieces.push(tailPart);
        updated = pieces.join("\n\n");
        if (original.endsWith("\n")) updated += "\n";
      } else {
        throw new Error(`未知的 mode："${mode}"`);
      }

      if (updated === original) return json({ path: file.path, changed: false, message: "内容没有变化" });
      await app.vault.modify(file, updated);
      return json({
        path: file.path,
        changed: true,
        before: original.length,
        after: updated.length,
        delta: updated.length - original.length,
      });
    },
  },

  {
    name: "move_note",
    title: "Move or rename note",
    description:
      "Move or rename a note. Obsidian updates links pointing to it. The target must not exist.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Current vault-relative path or unique note name." },
        to: { type: "string", description: "New vault-relative path." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const file = requireNote(app, args.from ?? args.path);
      const target = normalizeTargetPath(args.to);
      if (file.path === target) return json({ path: target, moved: false, message: "源路径与目标路径相同" });
      const existing = app.vault.getAbstractFileByPath(target);
      if (existing) throw new Error(`目标已存在：${target}`);
      await ensureParentFolder(app, target);
      await (app.fileManager as any).renameFile(file, target);
      return json({ from: file.path, to: target, moved: true });
    },
  },

  {
    name: "delete_note",
    title: "Delete note",
    description:
      "Move a note to the Obsidian trash (recoverable) or permanently delete it with permanent=true. Always confirm with the user before deleting.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Vault-relative path or unique note name." },
        permanent: { type: "boolean", description: "Delete permanently instead of moving to trash. Default false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const file = requireNote(app, args.path);
      const path = file.path;
      if (args.permanent === true) {
        await app.vault.delete(file);
        return ok(`已永久删除：${path}`);
      }
      await trashFile(app, file);
      return ok(`已移入回收站（可在 Obsidian 中恢复）：${path}`);
    },
  },
];

function findHeadingLineIndex(lines: string[], heading: string): number {
  const target = heading
    .replace(/^#+\s*/, "")
    .replace(/\s*#+$/, "")
    .trim()
    .toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    if (m[2].trim().toLowerCase() === target) return i;
  }
  return -1;
}

function findSectionEnd(lines: string[], headingIndex: number, level: number): number {
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) return i;
  }
  return lines.length;
}
