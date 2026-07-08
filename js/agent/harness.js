import { completeChat } from "./providers.js";
import { noData } from "./tools.js";

export const NO_DATA_STATUS = "no_data";

export const GROUNDED_SYSTEM_PROMPT = `You operate Wiki Globe by calling tools.

Hard rule: for factual, geographic, quantitative, or visual claims, only state what a tool returned in this conversation. If no available tool covers the request, say that the data is not available instead of answering from memory. Never invent borders, rankings, routes, coordinates, or numeric values.

When a tool returns status "no_data", treat that as a real result. Explain the limitation briefly and do not fill the gap from training knowledge. Prefer clearing previous agent overlays before starting a new independent map request unless the user asks to add to the existing view.`;

const DEFAULT_TOOL_BUDGET = 12;

export class AgentHarness {
  constructor(toolRegistry, opts = {}) {
    this.tools = toolRegistry;
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_TOOL_BUDGET;
    this.systemPrompt = opts.systemPrompt ?? GROUNDED_SYSTEM_PROMPT;
    this.chatComplete = opts.chatComplete ?? completeChat;
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  reset() {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  async run(userText, opts = {}) {
    const callbacks = opts.callbacks ?? {};
    const user = String(userText ?? "").trim();
    if (!user) throw new Error("Ask the agent something first.");

    const chatComplete = opts.chatComplete ?? this.chatComplete;
    const maxToolCalls = opts.maxToolCalls ?? this.maxToolCalls;
    this.messages.push({ role: "user", content: user });
    let usedCalls = 0;
    let lastUsage = { input: 0, output: 0, total: null };

    while (true) {
      callbacks.onStatus?.("thinking");
      const response = await chatComplete({
        providerId: opts.providerId,
        model: opts.model,
        key: opts.key,
        baseUrl: opts.baseUrl,
        messages: this.messages,
        tools: this.tools.schemas(),
        signal: opts.signal,
      });
      lastUsage = addUsage(lastUsage, response.usage);
      callbacks.onUsage?.(lastUsage);

      const message = response.message;
      this.messages.push(message);
      const toolCalls = normalizeToolCalls(message.tool_calls);
      if (toolCalls.length === 0) {
        const content = String(message.content ?? "").trim();
        if (!content || response.finishReason === "tool_calls") {
          const fallback = "The selected model did not return a usable message or tool call. It may not support OpenAI-style tool use reliably.";
          callbacks.onMessage?.(fallback, { usage: lastUsage, status: "error" });
          return { content: fallback, usage: lastUsage, status: "error" };
        }
        callbacks.onMessage?.(content, { usage: lastUsage, status: "ok" });
        return { content, usage: lastUsage, status: "ok" };
      }

      if (usedCalls + toolCalls.length > maxToolCalls) {
        const msg = `Stopped after ${maxToolCalls} tool calls to avoid a runaway loop.`;
        this.messages.push({ role: "tool", tool_call_id: "tool-budget", name: "tool_budget", content: JSON.stringify(noData(msg)) });
        callbacks.onMessage?.(msg, { usage: lastUsage, status: NO_DATA_STATUS });
        return { content: msg, usage: lastUsage, status: NO_DATA_STATUS };
      }

      for (const call of toolCalls) {
        usedCalls++;
        const parsed = parseToolArguments(call);
        callbacks.onTool?.({ name: call.name, args: parsed.args, status: parsed.error ? "error" : "running" });
        const result = parsed.error
          ? noData(`Malformed arguments for ${call.name}: ${parsed.error}`)
          : await this._executeTool(call.name, parsed.args);
        callbacks.onTool?.({ name: call.name, args: parsed.args, result, status: result.status });
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      }
    }
  }

  async _executeTool(name, args) {
    try {
      return await this.tools.execute(name, args);
    } catch (e) {
      return noData(`Tool ${name} failed: ${e.message}`);
    }
  }
}

function normalizeToolCalls(toolCalls) {
  return (toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `tool-${Date.now()}-${index}`,
    name: call.function?.name ?? call.name,
    arguments: call.function?.arguments ?? call.arguments ?? "{}",
  })).filter((call) => call.name);
}

function parseToolArguments(call) {
  if (typeof call.arguments === "object" && call.arguments !== null) return { args: call.arguments };
  try {
    return { args: JSON.parse(call.arguments || "{}") };
  } catch (e) {
    return { args: {}, error: e.message };
  }
}

function addUsage(a, b) {
  const input = (a.input ?? 0) + (b.input ?? 0);
  const output = (a.output ?? 0) + (b.output ?? 0);
  const total = a.total != null || b.total != null ? (a.total ?? 0) + (b.total ?? 0) : null;
  return { input, output, total };
}
