import {
  availableModels,
  getProviderBaseUrl,
  getInitialProviderId,
  getProviderKey,
  providerById,
  providers,
  setProviderBaseUrl,
  setProviderKey,
} from "./providers.js";
import { AgentHarness, NO_DATA_STATUS } from "./harness.js";
import { AgentToolRegistry } from "./tools.js";

const OLLAMA_HINT = "For Ollama, start the server with OLLAMA_ORIGINS allowing this page origin, for example OLLAMA_ORIGINS=http://localhost:8080. Models are read from /api/tags when reachable.";

export class AgentChatPanel {
  constructor(viewer, opts = {}) {
    this.viewer = viewer;
    this.el = document.getElementById("agent-panel");
    this.form = document.getElementById("agent-form");
    this.providerEl = document.getElementById("agent-provider");
    this.keyRow = document.getElementById("agent-key-row");
    this.keyEl = document.getElementById("agent-key");
    this.baseRow = document.getElementById("agent-base-row");
    this.baseEl = document.getElementById("agent-base-url");
    this.modelEl = document.getElementById("agent-model");
    this.modelOverrideEl = document.getElementById("agent-model-override");
    this.inputEl = document.getElementById("agent-input");
    this.outputEl = document.getElementById("agent-output");
    this.toolLogEl = document.getElementById("agent-tool-log");
    this.usageEl = document.getElementById("agent-usage");
    this.badgeEl = document.getElementById("agent-badge");
    this.noteEl = document.getElementById("agent-provider-note");
    this.ollamaHintEl = document.getElementById("agent-ollama-hint");
    this.statusEl = document.getElementById("agent-status");
    this.submitEl = document.getElementById("agent-submit");
    this.cancelEl = document.getElementById("agent-cancel");
    this.checkpointEl = document.getElementById("agent-checkpoint");
    this.checkpointMsgEl = document.getElementById("agent-checkpoint-msg");
    this.continueEl = document.getElementById("agent-continue");
    this.terminateEl = document.getElementById("agent-terminate");
    this.abort = null;
    this.checkpointResolve = null;
    this.modelLoadSeq = 0;

    this.tools = opts.tools ?? new AgentToolRegistry(viewer);
    this.harness = opts.harness ?? new AgentHarness(this.tools);

    this._populateProviders();
    this._bind();
    this._syncProvider();
    this._setStatus("Idle");
  }

  async refreshModels() {
    const seq = ++this.modelLoadSeq;
    const provider = providerById(this.providerEl.value);
    this.modelEl.disabled = true;
    this.modelEl.replaceChildren(new Option("Loading models...", provider.defaultModel));
    try {
      const models = await availableModels(provider.id, this.baseEl.value);
      if (seq !== this.modelLoadSeq) return;
      const list = models.length ? models : provider.seedModels;
      this.modelEl.replaceChildren(...list.map((model) => new Option(model, model)));
      this.modelEl.value = list.includes(provider.defaultModel) ? provider.defaultModel : (list[0] ?? provider.defaultModel);
      if (provider.id === "ollama") {
        this._setStatus(models.length ? "Ollama models loaded" : "Using Ollama seed models");
      }
    } catch (e) {
      if (seq !== this.modelLoadSeq) return;
      this.modelEl.replaceChildren(...provider.seedModels.map((model) => new Option(model, model)));
      this.modelEl.value = provider.defaultModel;
      this._setStatus(`Model list unavailable: ${e.message}`);
    } finally {
      if (seq === this.modelLoadSeq) this.modelEl.disabled = false;
    }
  }

  _populateProviders() {
    this.providerEl.replaceChildren(...providers().map((provider) => new Option(provider.label, provider.id)));
    this.providerEl.value = getInitialProviderId();
  }

  _bind() {
    document.getElementById("agent-close")?.addEventListener("click", () => this._setCollapsed(true));
    this.cancelEl?.addEventListener("click", () => this._cancel());
    this.continueEl?.addEventListener("click", () => this._resolveCheckpoint("continue"));
    this.terminateEl?.addEventListener("click", () => this._resolveCheckpoint("terminate"));
    this.providerEl.addEventListener("change", () => this._syncProvider());
    this.keyEl.addEventListener("change", () => setProviderKey(this.providerEl.value, this.keyEl.value.trim()));
    this.baseEl.addEventListener("change", () => {
      setProviderBaseUrl(this.providerEl.value, this.baseEl.value.trim());
      this.refreshModels();
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this._submit();
    });
  }

  async _syncProvider() {
    const provider = providerById(this.providerEl.value);
    this.keyRow.hidden = !provider.requiresKey;
    this.baseRow.hidden = !provider.configurableBaseUrl;
    this.keyEl.value = provider.requiresKey ? (getProviderKey(provider.id) ?? "") : "";
    this.baseEl.value = getProviderBaseUrl(provider.id);
    this.noteEl.textContent = provider.id === "ollama" ? "Local OpenAI-compatible Ollama endpoint." : (provider.setupNote ?? "");
    if (this.ollamaHintEl) {
      this.ollamaHintEl.hidden = provider.id !== "ollama";
      this.ollamaHintEl.textContent = provider.id === "ollama" ? OLLAMA_HINT : "";
    }
    await this.refreshModels();
  }

  async _submit() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this._cancel({ silent: true });
    this.abort = new AbortController();
    const provider = providerById(this.providerEl.value);
    const model = this.modelOverrideEl.value.trim() || this.modelEl.value || provider.defaultModel;
    const key = provider.requiresKey ? this.keyEl.value.trim() : null;
    if (provider.requiresKey) setProviderKey(provider.id, key);
    if (provider.configurableBaseUrl) setProviderBaseUrl(provider.id, this.baseEl.value.trim());

    this._setRunning(true);
    this._setBadge("loading");
    this._setStatus(`Thinking with ${provider.label} / ${model}`);
    this.outputEl.textContent = "";
    this.toolLogEl.textContent = "";
    this.usageEl.textContent = "Tokens: input 0, output 0";

    try {
      const result = await this.harness.run(text, {
        providerId: provider.id,
        model,
        key,
        baseUrl: this.baseEl.value,
        signal: this.abort.signal,
        callbacks: {
          onStatus: (status) => this._setStatus(status === "thinking" ? "Thinking..." : status),
          onCheckpoint: (info) => this._askCheckpoint(info),
          onTool: (entry) => this._logTool(entry),
          onUsage: (usage) => this._renderUsage(usage),
          onMessage: (content, meta) => {
            this.outputEl.textContent = content;
            this._setBadge(meta.status === NO_DATA_STATUS ? "nodata" : meta.status === "error" ? "nodata" : "live");
          },
        },
      });
      this._renderUsage(result.usage);
      this._setStatus(result.status === "ok" ? "Complete" : "Stopped");
      this.inputEl.value = "";
    } catch (e) {
      if (e.name === "AbortError") {
        this.outputEl.textContent = "Request cancelled.";
        this._setStatus("Cancelled");
        this._setBadge("idle");
        return;
      }
      this.outputEl.textContent = e.message;
      this._setStatus("Error");
      this._setBadge("nodata");
    } finally {
      this._resolveCheckpoint("terminate");
      this.abort = null;
      this._setRunning(false);
    }
  }

  _cancel(opts = {}) {
    // A pending budget checkpoint is resolved as terminate so an in-flight
    // cancel also unblocks the awaiting harness loop.
    this._resolveCheckpoint("terminate");
    if (!this.abort) return;
    this.abort.abort();
    if (!opts.silent) this._setStatus("Cancelling...");
  }

  // Show the continue/terminate prompt when the harness hits its tool-call
  // budget, and return a promise that resolves with the user's decision.
  _askCheckpoint(info) {
    if (!this.checkpointEl) return Promise.resolve("terminate");
    return new Promise((resolve) => {
      this.checkpointResolve = resolve;
      const pending = info.pending?.length ? ` Next: ${info.pending.join(", ")}.` : "";
      this.checkpointMsgEl.textContent =
        `Paused after ${info.usedCalls} tool calls.${pending} Continue for up to ${info.budget} more, or terminate?`;
      this.checkpointEl.hidden = false;
      this._setStatus("Waiting for continue or terminate");
    });
  }

  _resolveCheckpoint(decision) {
    if (!this.checkpointResolve) return;
    const resolve = this.checkpointResolve;
    this.checkpointResolve = null;
    if (this.checkpointEl) this.checkpointEl.hidden = true;
    resolve(decision);
  }

  _logTool(entry) {
    const line = document.createElement("div");
    line.className = `agent-tool ${entry.status ?? "running"}`;
    const result = entry.result?.status ? ` -> ${entry.result.status}` : "";
    line.textContent = `${entry.status ?? "running"}: ${entry.name}${result}`;
    line.title = JSON.stringify({ args: entry.args ?? {}, result: entry.result ?? null });
    this.toolLogEl.appendChild(line);
    this.toolLogEl.scrollTop = this.toolLogEl.scrollHeight;
  }

  _renderUsage(usage) {
    this.usageEl.textContent = `Tokens: input ${usage.input ?? 0}, output ${usage.output ?? 0}`;
  }

  _setRunning(running) {
    this.submitEl.disabled = running;
    this.cancelEl.hidden = !running;
    this.providerEl.disabled = running;
    this.keyEl.disabled = running;
    this.baseEl.disabled = running;
    this.modelEl.disabled = running;
    this.modelOverrideEl.disabled = running;
    this.inputEl.disabled = running;
  }

  _setStatus(status) {
    if (this.statusEl) this.statusEl.textContent = status;
  }

  _setBadge(state) {
    const map = {
      idle: ["-", "static"],
      loading: ["...", "loading"],
      live: ["LIVE", "live"],
      nodata: ["NO DATA", "demo"],
    };
    const [label, cls] = map[state] ?? map.idle;
    this.badgeEl.textContent = label;
    this.badgeEl.className = `badge ${cls}`;
  }

  _setCollapsed(collapsed) {
    this.el.classList.toggle("collapsed", collapsed);
    const toggle = document.getElementById("agent-toggle");
    const label = collapsed ? "Expand agent panel" : "Collapse agent panel";
    toggle?.setAttribute("aria-expanded", String(!collapsed));
    toggle?.setAttribute("aria-label", label);
    if (toggle) toggle.title = label;
  }
}