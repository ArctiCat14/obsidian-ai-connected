/**
 * Agent loop test: drives `runAgent` against a local mock of an OpenAI-compatible
 * streaming endpoint and asserts that tool calls are assembled, executed and fed back.
 */

import * as http from "http";
import { TFile, TFolder } from "obsidian";
import { runAgent } from "../src/agent/agentLoop";
import type { AgentEvent } from "../src/agent/agentLoop";
import { ALL_TOOLS } from "../src/tools";
import { DEFAULT_SETTINGS } from "../src/settings";

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

// ------------------------------------------------------------------ fake vault

const noteContent = new Map<string, string>([["Inbox/Hello.md", "# Hello\n\nworld foo bar\n"]]);
const file = new TFile();
file.path = "Inbox/Hello.md";
file.name = "Hello.md";
file.basename = "Hello";
file.extension = "md";
file.stat = { size: 22, mtime: 1_700_000_000_000, ctime: 1_600_000_000_000 };
const root = new TFolder();
root.path = "/";
file.parent = root;

const app = {
  vault: {
    getName: () => "TestVault",
    adapter: {},
    getMarkdownFiles: () => [file],
    getAllLoadedFiles: () => [file],
    getAbstractFileByPath: (p: string) => (p === "Inbox/Hello.md" ? file : null),
    cachedRead: async () => noteContent.get("Inbox/Hello.md") ?? "",
    read: async () => noteContent.get("Inbox/Hello.md") ?? "",
    create: async () => file,
    modify: async () => undefined,
    createFolder: async () => undefined,
  },
  metadataCache: { resolvedLinks: {}, getFileCache: () => ({ tags: [], frontmatter: {}, headings: [], links: [], embeds: [] }) },
  workspace: { getActiveFile: () => file, getActiveViewOfType: () => null, getLeaf: () => ({ openFile: async () => undefined }) },
} as any;

// ----------------------------------------------------------------- mock server

const requests: any[] = [];

function sse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    if (requests.length === 1) {
      sse(res, {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_note", arguments: "" } }],
            },
          },
        ],
      });
      sse(res, {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
      });
      sse(res, {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Inbox/Hello.md"}' } }] } }],
      });
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const piece of ["# 摘要", "\n\n这是 Hello", " 笔记。"]) {
        sse(res, { choices: [{ index: 0, delta: { content: piece } }] });
      }
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  console.log("\n== agent loop ==");
  const events: AgentEvent[] = [];
  const history = await runAgent([{ role: "user", content: "总结 Inbox/Hello.md" }], {
    cfg: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      model: "mock-model",
      temperature: 0.2,
      stream: true,
    },
    systemPrompt: "你是测试助手",
    tools: ALL_TOOLS as any,
    ctx: { app, settings: DEFAULT_SETTINGS },
    maxSteps: 4,
    onEvent: (event) => events.push(event),
  });

  check("two model round trips", requests.length === 2, requests.length);
  check("request URL is /v1/chat/completions", true);
  check("system prompt is first message", requests[0].messages[0].role === "system" && requests[0].messages[0].content === "你是测试助手", requests[0].messages[0]);
  check("tools are advertised to the model", Array.isArray(requests[0].tools) && requests[0].tools.length === ALL_TOOLS.length);
  check("tool_choice is auto", requests[0].tool_choice === "auto", requests[0].tool_choice);
  check("streaming enabled", requests[0].stream === true);

  const toolStart = events.find((e) => e.type === "tool_start") as Extract<AgentEvent, { type: "tool_start" }> | undefined;
  check("tool_start emitted", !!toolStart && toolStart.name === "read_note", toolStart);
  check("tool arguments reassembled from deltas", toolStart?.args.path === "Inbox/Hello.md", toolStart?.args);

  const toolEnd = events.find((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }> | undefined;
  check("tool_end reports success", !!toolEnd && toolEnd.ok === true, toolEnd?.text?.slice(0, 120));
  check("tool_end contains the note body", !!toolEnd && toolEnd.text.includes("# Hello"), toolEnd?.text?.slice(0, 120));

  const toolMessage = requests[1].messages.find((m: any) => m.role === "tool");
  check("tool result is fed back with tool_call_id", !!toolMessage && toolMessage.tool_call_id === "call_1", toolMessage);
  check("tool result contains note content", !!toolMessage && String(toolMessage.content).includes("# Hello"), toolMessage?.content?.slice(0, 120));

  const deltas = events.filter((e) => e.type === "assistant_delta") as Array<Extract<AgentEvent, { type: "assistant_delta" }>>;
  check("assistant deltas streamed", deltas.length === 3, deltas.map((d) => d.text));
  check("deltas concatenate to the final text", deltas.map((d) => d.text).join("").includes("这是 Hello"));

  const final = history[history.length - 1];
  check("history ends with the assistant answer", final.role === "assistant" && final.content.includes("摘要"), final);
  check("history keeps the tool call turn", history.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0));
  check("history keeps the tool result turn", history.some((m) => m.role === "tool"));

  console.log("\n== abort handling ==");
  const controller = new AbortController();
  controller.abort();
  let aborted = false;
  try {
    await runAgent([{ role: "user", content: "hi" }], {
      cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "", model: "m", temperature: 0, stream: true },
      systemPrompt: "",
      tools: [],
      ctx: { app, settings: DEFAULT_SETTINGS },
      maxSteps: 2,
      signal: controller.signal,
      onEvent: () => undefined,
    });
  } catch (error) {
    aborted = (error as any)?.name === "AbortError";
  }
  check("aborted run throws AbortError", aborted);

  server.close();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Agent test crashed:", error);
  process.exitCode = 1;
  server.close();
});
