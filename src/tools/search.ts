import { App, TFile } from "obsidian";
import { json, ok, ToolContext, ToolResult } from "./types";
import { clampInt, normalizeFolder, normalizeTag, normalizeTagList, requireNote } from "./helpers";

interface SearchHit {
  path: string;
  line: number;
  snippet: string;
}

function buildSnippet(lines: string[], index: number, context: number): string {
  const start = Math.max(0, index - context);
  const end = Math.min(lines.length, index + context + 1);
  const text = lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export async function searchVault(
  app: App,
  opts: {
    query: string;
    regex?: boolean;
    caseSensitive?: boolean;
    folder?: string;
    limit?: number;
    context?: number;
    perFile?: number;
    glob?: string;
  },
): Promise<{ hits: SearchHit[]; scanned: number; total: number; truncated: boolean }> {
  const query = opts.query;
  if (!query) throw new Error("query 不能为空");
  const limit = clampInt(opts.limit, 1, 500, 50);
  const perFile = clampInt(opts.perFile, 1, 50, 3);
  const context = clampInt(opts.context, 0, 5, 1);
  const caseSensitive = opts.caseSensitive === true;

  let matcher: (line: string) => boolean;
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } catch (e) {
      throw new Error(`正则表达式无效：${(e as Error).message}`);
    }
    matcher = (line) => {
      re.lastIndex = 0;
      return re.test(line);
    };
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const folder = normalizeFolder(opts.folder);
  let files = app.vault.getMarkdownFiles();
  if (folder) files = files.filter((f) => f.path.startsWith(folder + "/"));
  if (opts.glob) {
    const re = new RegExp(
      "^" +
        opts.glob
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
  const hits: SearchHit[] = [];
  let scanned = 0;
  let truncated = false;

  for (const file of files) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    const content = await app.vault.cachedRead(file);
    scanned++;
    const lines = content.split("\n");
    let perFileHits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue;
      hits.push({ path: file.path, line: i + 1, snippet: buildSnippet(lines, i, context) });
      perFileHits++;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      if (perFileHits >= perFile) break;
    }
  }

  return { hits, scanned, total, truncated };
}

export function fileMatchesTag(app: App, file: TFile, tag: string, exact: boolean): boolean {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return false;
  const wanted = normalizeTag(tag);
  if (!wanted) return false;
  const tags = new Set<string>();
  for (const t of cache.tags ?? []) tags.add(normalizeTag(t.tag));
  for (const t of normalizeTagList(cache.frontmatter?.tags)) tags.add(normalizeTag(t));
  for (const t of tags) {
    if (t === wanted) return true;
    if (!exact && t.startsWith(wanted + "/")) return true;
  }
  return false;
}

export const searchTools = [
  {
    name: "search_notes",
    title: "Search note contents",
    description:
      "Full-text search across markdown notes and return matching lines with surrounding context. Supports plain text or regular expressions. Use this before reading files when you do not know where something lives.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Text or regular expression to search for." },
        regex: { type: "boolean", description: "Treat query as a regular expression. Default false." },
        caseSensitive: { type: "boolean", description: "Case sensitive matching. Default false." },
        folder: { type: "string", description: "Limit the search to a folder." },
        glob: { type: "string", description: "Limit to paths matching a glob such as 'Projects/**'." },
        limit: { type: "number", description: "Max hits (1-500). Default 50." },
        context: { type: "number", description: "Context lines before/after each hit (0-5). Default 1." },
        perFile: { type: "number", description: "Max hits per note (1-50). Default 3." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const result = await searchVault(ctx.app, {
        query: typeof args.query === "string" ? args.query : "",
        regex: args.regex === true,
        caseSensitive: args.caseSensitive === true,
        folder: typeof args.folder === "string" ? args.folder : undefined,
        glob: typeof args.glob === "string" ? args.glob : undefined,
        limit: args.limit,
        context: args.context,
        perFile: args.perFile,
      });
      if (!result.hits.length) {
        return json({
          query: args.query,
          matches: 0,
          scanned: result.scanned,
          totalNotes: result.total,
          results: [],
          hint: "没有匹配结果，可以换关键词或放宽条件",
        });
      }
      return json({
        query: args.query,
        matches: result.hits.length,
        scanned: result.scanned,
        totalNotes: result.total,
        truncated: result.truncated,
        results: result.hits,
      });
    },
  },

  {
    name: "search_by_tag",
    title: "Find notes by tag",
    description:
      "List notes carrying a tag (from inline #tags or frontmatter tags). Sub-tags are included unless exact=true.",
    readOnly: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        tag: { type: "string", description: "Tag name, with or without a leading #." },
        exact: { type: "boolean", description: "Only the exact tag, exclude sub-tags. Default false." },
        limit: { type: "number", description: "Max notes (1-1000). Default 200." },
      },
      required: ["tag"],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { app } = ctx;
      const tag = typeof args.tag === "string" ? args.tag : "";
      if (!normalizeTag(tag)) throw new Error("tag 不能为空");
      const limit = clampInt(args.limit, 1, 1000, 200);
      const paths: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        if (fileMatchesTag(app, file, tag, args.exact === true)) paths.push(file.path);
      }
      paths.sort((a, b) => a.localeCompare(b));
      return json({
        tag: normalizeTag(tag),
        count: paths.length,
        returned: Math.min(paths.length, limit),
        notes: paths.slice(0, limit),
      });
    },
  },

  {
    name: "list_backlinks",
    title: "List backlinks",
    description: "List the notes that link to a given note.",
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
      const resolved = app.metadataCache.resolvedLinks ?? {};
      const backlinks: string[] = [];
      for (const [source, targets] of Object.entries(resolved)) {
        if (source !== file.path && targets && Object.prototype.hasOwnProperty.call(targets, file.path)) {
          backlinks.push(source);
        }
      }
      backlinks.sort((a, b) => a.localeCompare(b));
      return ok(JSON.stringify({ path: file.path, count: backlinks.length, backlinks }, null, 2));
    },
  },
];
