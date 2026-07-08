import { completeChat } from "./providers.js";
import { isNoDataResult, noData, NO_DATA_STATUS } from "./tools.js";

export { NO_DATA_STATUS };

export const GROUNDED_SYSTEM_PROMPT = `You operate Wiki Globe by calling tools.

Hard rule: for factual, geographic, quantitative, or visual claims, only state what a tool returned in this conversation. If no available tool covers the request, say that the data is not available instead of answering from memory. Never invent borders, rankings, routes, coordinates, or numeric values.

Tool results have this contract: {"status":"ok","data":...} means grounded data is available; {"status":"no_data","reason":"...","detail":...,"data":null} means the requested data or operation is outside tool coverage or unavailable. Treat "no_data" as authoritative, not as permission to guess.

If a user asks for something like historical/dynastic borders, unsourced rankings, unknown coordinates, or any claim no tool can actually retrieve or compute, explicitly refuse with a short explanation that Wiki Globe has no tool data for that request. Prefer clearing previous agent overlays before starting a new independent map request unless the user asks to add to the existing view.`;

const DEFAULT_TOOL_BUDGET = 20;

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
    let budgetLimit = maxToolCalls;
    let hadNoData = false;
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
        const status = hadNoData ? NO_DATA_STATUS : "ok";
        callbacks.onMessage?.(content, { usage: lastUsage, status });
        return { content, usage: lastUsage, status };
      }

      // Budget checkpoint: instead of hard-stopping mid-task, pause and let the
      // user continue (grant another budget's worth of calls) or terminate
      // cleanly. The loop cannot advance past this point without a decision, so
      // an unbounded runaway is still impossible.
      if (usedCalls + toolCalls.length > budgetLimit) {
        const decision = await requestCheckpoint(callbacks, {
          usedCalls,
          budget: maxToolCalls,
          pending: toolCalls.map((call) => call.name),
        });
        if (decision === "continue") {
          budgetLimit += maxToolCalls;
        } else {
          // Terminate cleanly. Every pending tool_call the model just requested
          // still needs a matching tool result, or the next turn's messages
          // array is malformed (dangling tool_calls). Overlays drawn so far are
          // left in place.
          for (const call of toolCalls) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify(noData("Stopped by user at the tool-call checkpoint; not executed.")),
            });
          }
          const msg = `Stopped at your request after ${usedCalls} tool calls. Overlays drawn so far are kept.`;
          callbacks.onMessage?.(msg, { usage: lastUsage, status: NO_DATA_STATUS });
          return { content: msg, usage: lastUsage, status: "stopped" };
        }
      }

      for (const call of toolCalls) {
        usedCalls++;
        const parsed = parseToolArguments(call);
        callbacks.onTool?.({ name: call.name, args: parsed.args, status: parsed.error ? "error" : "running" });
        const result = parsed.error
          ? noData(`Malformed arguments for ${call.name}: ${parsed.error}`)
          : await this._executeTool(call.name, parsed.args);
        if (isNoDataResult(result)) hadNoData = true;
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

// Ask the UI whether to continue past the tool-call budget. With no handler
// wired (headless/test callers), default to terminate so the loop stays bounded.
async function requestCheckpoint(callbacks, info) {
  if (!callbacks.onCheckpoint) return "terminate";
  const decision = await callbacks.onCheckpoint(info);
  return decision === "continue" ? "continue" : "terminate";
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
