import { completeChat } from "./providers.js";
import { ERROR_STATUS, isErrorResult, isNoDataResult, noData, NO_DATA_STATUS, toolError } from "./tools.js";

export { NO_DATA_STATUS, ERROR_STATUS };

// Set when the model answers from its own knowledge as a last resort (after
// tools returned no_data/error). The model signals this by beginning its reply
// with the [UNVERIFIED] tag; the harness detects it, strips the tag, and flags
// the message so the UI can badge it distinctly from grounded answers.
export const UNVERIFIED_STATUS = "unverified";
const UNVERIFIED_TAG = /^\s*\[UNVERIFIED\]\s*/i;

export const GROUNDED_SYSTEM_PROMPT = `You operate Wiki Globe by calling tools.

Grounding rule: for factual, geographic, quantitative, or visual claims, tools come first. Always try the applicable tools before answering, and when a tool returns data, base your answer only on that data. Never present your own memory as if it were tool-sourced.

Tool results use three statuses:
- {"status":"ok","data":...} — grounded data you may use.
- {"status":"no_data","reason":"...","data":null} — the request is genuinely outside tool coverage or returned nothing. Treat this as authoritative for what the tools can retrieve.
- {"status":"error","reason":"...","data":null} — a transient failure (network, timeout, rate limit). This does NOT mean the data does not exist. Report the actual reason from the result and offer to retry; do NOT invent a cause such as "connectivity issues", and do NOT jump straight to memory — a retry may succeed.

For country economic and development statistics (GDP per capita, GNI, HDI, life expectancy, population indicators) and World Bank income-group classification, use the country_stats tool first — it reads bundled World Bank/UNDP data with no network dependency. Do not fall back to wiki_search/wikidata_sparql for these; Wikidata does not reliably carry GDP-per-capita or income group.

Last-resort memory fallback: if — and only if — you have actually tried the applicable tools and they all returned no_data (or an error you could not resolve by retrying), you MAY answer from your own knowledge instead of refusing outright. This applies to VISUALIZATIONS too, not just text: if the user asked to see something on the globe (a choropleth, labels, pins, an outline, a route) and no tool has the real data, you MUST still call the relevant map tool (color_countries, label_countries, highlight_country, draw_route, add_pin) using your own best-effort remembered values — do not refuse to render just because the values are unverified. Withholding the visualization is the wrong behavior here; disclosing that it is unverified is the right one. When you use this fallback you MUST:
1. Begin the reply with the exact tag [UNVERIFIED] as the very first characters. This is required every time any part of the answer (including a rendered overlay) comes from memory, not only when there is no tool call at all.
2. State plainly that the answer/overlay comes from model knowledge with no Wiki Globe tool data behind it, may be outdated or incomplete, and name roughly how many entries or how wide the classification is (e.g. "~120 jurisdictions, approximate").
3. Still call the map tool(s) needed to render what the user asked for, using your remembered values as the input — the disclosure is additional to the overlay, not a substitute for it.
Never use this fallback before trying tools, and never use it to paper over a transient error you should retry. Prefer a partial grounded answer (what the tools did return) plus a clearly-marked unverified remainder over a fully unverified one. Do not silently mix remembered facts into an otherwise grounded answer — if any part is unverified, tag the whole reply.

Prefer clearing previous agent overlays before starting a new independent map request unless the user asks to add to the existing view.`;

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
    let hadError = false;
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
        // A memory-fallback answer is self-declared with the [UNVERIFIED] tag;
        // its provenance overrides the tool-derived statuses since the model
        // chose to answer despite no grounded data.
        const unverified = UNVERIFIED_TAG.test(content);
        const finalContent = unverified ? content.replace(UNVERIFIED_TAG, "") : content;
        const status = unverified ? UNVERIFIED_STATUS : hadError ? ERROR_STATUS : hadNoData ? NO_DATA_STATUS : "ok";
        callbacks.onMessage?.(finalContent, { usage: lastUsage, status });
        return { content: finalContent, usage: lastUsage, status };
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
          : await this._executeTool(call.name, parsed.args, callbacks);
        if (isNoDataResult(result)) hadNoData = true;
        if (isErrorResult(result)) hadError = true;
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

  async _executeTool(name, args, callbacks = {}) {
    try {
      return await this.tools.execute(name, args, {
        confirmCompute: callbacks.onConfirmCompute,
      });
    } catch (e) {
      // A thrown tool is a transient/unexpected failure, not evidence the data
      // is out of coverage. Surface it as a retryable error so the model does
      // not treat it as license to answer from memory.
      return toolError(`Tool ${name} failed: ${e.message}`, { retryable: true });
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
