import { toolsForLlm } from "../tools";
import type { ToolContext, ToolDef } from "../tools/types";
import { chatCompletion, ChatResult, isAbortError, LlmConfig, LlmMessage, LlmToolCall } from "./llm";

export type AgentEvent =
  | { type: "step"; index: number }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string; toolCallNames: string[] }
  | { type: "tool_start"; name: string; args: Record<string, any> }
  | { type: "tool_end"; name: string; ok: boolean; text: string }
  | { type: "error"; message: string };

export interface AgentRunOptions {
  cfg: LlmConfig;
  systemPrompt: string;
  tools: ToolDef[];
  ctx: ToolContext;
  maxSteps: number;
  signal?: AbortSignal;
  confirm?: (tool: ToolDef, args: Record<string, any>) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
}

const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_API_MESSAGES = 60;

export async function runAgent(messages: LlmMessage[], options: AgentRunOptions): Promise<LlmMessage[]> {
  // Mutated in place: the panel keeps a live reference to the same array so every
  // tool result can be persisted mid-turn.
  const history = messages;
  const schemas = toolsForLlm(options.tools);

  for (let step = 0; step < options.maxSteps; step++) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    options.onEvent({ type: "step", index: step });

    let result: ChatResult;
    try {
      result = await chatCompletion(options.cfg, withSystemPrompt(forApi(history), options.systemPrompt), schemas, {
        signal: options.signal,
        onDelta: (text) => options.onEvent({ type: "assistant_delta", text }),
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      options.onEvent({ type: "error", message: errorMessage(error) });
      throw error;
    }

    const assistant: LlmMessage = { role: "assistant", content: result.content };
    if (result.toolCalls.length) assistant.tool_calls = result.toolCalls;
    history.push(assistant);

    options.onEvent({
      type: "assistant_message",
      text: result.content,
      toolCallNames: result.toolCalls.map((c) => c.function.name),
    });

    if (!result.toolCalls.length) return history;

    for (const call of result.toolCalls) {
      history.push(await executeToolCall(call, options));
    }
  }

  const message = `已达到最大工具调用轮数（${options.maxSteps} 步），本轮到此为止。可以在设置中提高「最大步数」，或把任务拆小一点。`;
  options.onEvent({ type: "error", message });
  return history;
}

async function executeToolCall(call: LlmToolCall, options: AgentRunOptions): Promise<LlmMessage> {
  const name = call.function.name;
  const tool = options.tools.find((t) => t.name === name);
  const base = { role: "tool" as const, tool_call_id: call.id, name };

  const args = parseArguments(call.function.arguments);
  if (!args.ok) {
    const text = `参数不是合法 JSON：${args.error}`;
    options.onEvent({ type: "tool_end", name, ok: false, text });
    return { ...base, content: text };
  }

  if (!tool) {
    const text = `不存在名为 "${name}" 的工具。可用工具：${options.tools.map((t) => t.name).join(", ")}`;
    options.onEvent({ type: "tool_end", name, ok: false, text });
    return { ...base, content: text };
  }

  options.onEvent({ type: "tool_start", name, args: args.value });

  if (tool.destructive && options.confirm) {
    const approved = await options.confirm(tool, args.value);
    if (!approved) {
      const text = "用户拒绝了这次操作。请询问用户接下来怎么做，不要重复尝试。";
      options.onEvent({ type: "tool_end", name, ok: false, text });
      return { ...base, content: text };
    }
  }

  try {
    const result = await tool.run(args.value, options.ctx);
    const text = clamp(result.text);
    options.onEvent({ type: "tool_end", name, ok: !result.isError, text });
    return { ...base, content: result.isError ? `错误：${text}` : text };
  } catch (error) {
    const text = `工具执行失败：${errorMessage(error)}`;
    options.onEvent({ type: "tool_end", name, ok: false, text });
    return { ...base, content: text };
  }
}

function parseArguments(raw: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, any> };
    }
    return { ok: false, error: "参数必须是 JSON 对象" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function clamp(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[... 工具输出过长，已截断 ${text.length - MAX_TOOL_RESULT_CHARS} 字符]`;
}

function withSystemPrompt(messages: LlmMessage[], systemPrompt: string): LlmMessage[] {
  if (!systemPrompt.trim()) return messages;
  return [{ role: "system", content: systemPrompt }, ...messages];
}

function forApi(messages: LlmMessage[]): LlmMessage[] {
  if (messages.length <= MAX_API_MESSAGES) return messages;
  let start = messages.length - MAX_API_MESSAGES;
  while (start < messages.length && messages[start].role !== "user") start++;
  return messages.slice(start);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
