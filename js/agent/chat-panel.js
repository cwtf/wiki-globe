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
import { AgentHarness, ERROR_STATUS, NO_DATA_STATUS, UNVERIFIED_STATUS } from "./harness.js";
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
    this.transcriptEl = document.getElementById("agent-transcript");
    this.emptyEl = this.transcriptEl?.querySelector(".agent-empty");
    this.outputEl = document.getElementById("agent-output");
    this.toolLogEl = document.getElementById("agent-tool-log");
    this.usageEl = document.getElementById("agent-usage");
    this.badgeEl = document.getElementById("agent-badge");
    this.settingsEl = document.getElementById("agent-settings");
    this.settingsToggleEl = document.getElementById("agent-settings-toggle");
    this.historyEl = document.getElementById("agent-history");
    this.historyToggleEl = document.getElementById("agent-history-toggle");
    this.historyListEl = document.getElementById("agent-history-list");
    this.newSessionEl = document.getElementById("agent-new-session");
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
    this.activeAssistantEl = null;
    this.activeToolGroup = null;
    this.pendingToolEls = new Map();
    this.currentSessionTitle = null;

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
    this.settingsToggleEl?.addEventListener("click", () => this._toggleSettings());
    this.historyToggleEl?.addEventListener("click", () => this._toggleHistory());
    this.newSessionEl?.addEventListener("click", () => this._newSession());
    this.cancelEl?.addEventListener("click", () => this._cancel());
    this.continueEl?.addEventListener("click", () => this._resolveCheckpoint(this.continueEl.dataset.decision || "continue", { record: true }));
    this.terminateEl?.addEventListener("click", () => this._resolveCheckpoint(this.terminateEl.dataset.decision || "terminate", { record: true }));
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
    this.currentSessionTitle ??= text;
    this._appendMessage("user", text);
    this.activeAssistantEl = this._appendMessage("assistant", "Thinking...", { state: "thinking" });
    this.activeToolGroup = null;
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
          onConfirmCompute: (info) => this._askComputeConfirmation(info),
          onTool: (entry) => this._logTool(entry),
          onUsage: (usage) => this._renderUsage(usage),
          onMessage: (content, meta) => {
            this._updateAssistantMessage(content, meta);
            this._setBadge(meta.status === UNVERIFIED_STATUS ? "unverified" : meta.status === ERROR_STATUS ? "error" : meta.status === NO_DATA_STATUS ? "nodata" : "live");
          },
        },
      });
      this._renderUsage(result.usage);
      this._setStatus(statusLabel(result.status));
      this.inputEl.value = "";
    } catch (e) {
      if (e.name === "AbortError") {
        this._updateAssistantMessage("Request cancelled.", { status: "stopped" });
        this._setStatus("Cancelled");
        this._setBadge("idle");
        return;
      }
      this._updateAssistantMessage(e.message, { status: ERROR_STATUS });
      this._setStatus("Error");
      this._setBadge("error");
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

  _askCheckpoint(info) {
    const pending = info.pending?.length ? ` Next: ${info.pending.join(", ")}.` : "";
    return this._askDecision({
      message: `Paused after ${info.usedCalls} tool calls.${pending} Continue for up to ${info.budget} more, or terminate?`,
      primaryLabel: "Continue",
      secondaryLabel: "Terminate",
      primaryDecision: "continue",
      secondaryDecision: "terminate",
      status: "Waiting for continue or terminate",
    });
  }

  _askComputeConfirmation(info) {
    return this._askDecision({
      message: `${info.title ?? "Run compute-heavy tool"}: ${info.detail ?? info.tool ?? ""} ${info.estimate ?? ""}`.replace(/\s+/g, " ").trim(),
      primaryLabel: "Proceed",
      secondaryLabel: "Stop",
      primaryDecision: "proceed",
      secondaryDecision: "stop",
      status: "Waiting for compute approval",
    });
  }

  // Reusable two-choice prompt used for both tool-budget checkpoints and
  // compute-heavy tool approval.
  _askDecision({ message, primaryLabel, secondaryLabel, primaryDecision, secondaryDecision, status }) {
    if (!this.checkpointEl) return Promise.resolve("terminate");
    return new Promise((resolve) => {
      this.checkpointResolve = resolve;
      this.continueEl.textContent = primaryLabel;
      this.terminateEl.textContent = secondaryLabel;
      this.continueEl.dataset.decision = primaryDecision;
      this.terminateEl.dataset.decision = secondaryDecision;
      this.checkpointMsgEl.textContent = message;
      this.checkpointEl.hidden = false;
      this.transcriptEl?.appendChild(this.checkpointEl);
      this._setStatus(status);
      this._scrollTranscript();
    });
  }

  _resolveCheckpoint(decision, opts = {}) {
    if (!this.checkpointResolve) return;
    const resolve = this.checkpointResolve;
    this.checkpointResolve = null;
    if (this.checkpointEl) this.checkpointEl.hidden = true;
    if (this.continueEl) {
      this.continueEl.textContent = "Continue";
      delete this.continueEl.dataset.decision;
    }
    if (this.terminateEl) {
      this.terminateEl.textContent = "Terminate";
      delete this.terminateEl.dataset.decision;
    }
    if (opts.record) this._appendNotice(`Decision: ${decision}`);
    resolve(decision);
  }

  _logTool(entry) {
    const status = entry.status ?? "running";
    const line = status === "running" ? this._createToolLine(entry) : this._takePendingToolLine(entry.name);
    const result = entry.result?.status ? ` -> ${entry.result.status}` : "";
    line.className = `agent-tool ${status}`;
    line.textContent = `${status}: ${entry.name}${result}`;
    line.title = JSON.stringify({ args: entry.args ?? {}, result: entry.result ?? null });
    const group = this._ensureToolGroup();
    if (!line.parentElement) group.list.appendChild(line);
    if (status !== "running") group.completed += 1;
    this._renderToolGroupSummary(group);
    const mirror = document.createElement("div");
    mirror.className = line.className;
    mirror.textContent = line.textContent;
    mirror.title = line.title;
    this.toolLogEl.appendChild(mirror);
    this.toolLogEl.scrollTop = this.toolLogEl.scrollHeight;
    this._scrollTranscript();
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
    if (this.newSessionEl) this.newSessionEl.disabled = running;
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
      error: ["ERROR", "demo"],
      unverified: ["UNVERIFIED", "demo"],
    };
    const [label, cls] = map[state] ?? map.idle;
    this.badgeEl.textContent = label;
    this.badgeEl.className = `badge ${cls}`;
  }

  _toggleSettings(force) {
    if (!this.settingsEl || !this.settingsToggleEl) return;
    const open = force ?? this.settingsEl.hidden;
    this.settingsEl.hidden = !open;
    this.settingsToggleEl.setAttribute("aria-expanded", String(open));
    if (open) this._toggleHistory(false);
  }

  _toggleHistory(force) {
    if (!this.historyEl || !this.historyToggleEl) return;
    const open = force ?? this.historyEl.hidden;
    this.historyEl.hidden = !open;
    this.historyToggleEl.setAttribute("aria-expanded", String(open));
    if (open) {
      this._toggleSettings(false);
      this._renderHistory();
    }
  }

  _newSession() {
    if (this.abort) return;
    this.harness.reset();
    this._resolveCheckpoint("terminate");
    this.pendingToolEls.clear();
    this.activeAssistantEl = null;
    this.activeToolGroup = null;
    this.outputEl.textContent = "";
    this.toolLogEl.textContent = "";
    this.usageEl.textContent = "Tokens: input 0, output 0";
    this.inputEl.value = "";
    this.currentSessionTitle = null;
    this._setStatus("New session");
    this._setBadge("idle");
    this._toggleSettings(false);
    this._toggleHistory(false);
    this.transcriptEl.replaceChildren();
    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "agent-empty";
    this.emptyEl.textContent = "Ask the globe agent to search, reason, and draw on the map.";
    this.transcriptEl.append(
      ...[this.emptyEl, this.checkpointEl, this.outputEl, this.toolLogEl].filter(Boolean),
    );
    if (this.checkpointEl) this.checkpointEl.hidden = true;
    this._renderHistory();
  }

  _renderHistory() {
    if (!this.historyListEl) return;
    this.historyListEl.replaceChildren();
    const item = document.createElement("button");
    item.className = "agent-history-item";
    item.type = "button";
    item.disabled = true;

    const title = document.createElement("span");
    title.className = "agent-history-item-title";
    title.textContent = this.currentSessionTitle ? truncate(this.currentSessionTitle, 58) : "Current session";

    const meta = document.createElement("span");
    meta.className = "agent-history-item-meta";
    meta.textContent = this.currentSessionTitle ? "Open now" : "No messages yet";

    item.append(title, meta);
    this.historyListEl.append(item);
  }

  _appendMessage(role, content, opts = {}) {
    this._hideEmpty();
    const row = document.createElement("div");
    row.className = `agent-message ${role}`;
    if (opts.state) row.dataset.state = opts.state;

    const meta = document.createElement("div");
    meta.className = "agent-message-meta";
    meta.textContent = role === "user" ? "You" : "Agent";

    const bubble = document.createElement("div");
    bubble.className = "agent-bubble";
    bubble.textContent = content;

    row.append(meta, bubble);
    this.transcriptEl.appendChild(row);
    this._scrollTranscript();
    return row;
  }

  _ensureToolGroup() {
    if (this.activeToolGroup) return this.activeToolGroup;
    this._hideEmpty();

    const details = document.createElement("details");
    details.className = "agent-tool-group";

    const summary = document.createElement("summary");
    summary.className = "agent-tool-summary";

    const label = document.createElement("span");
    label.className = "agent-tool-summary-label";

    const meta = document.createElement("span");
    meta.className = "agent-tool-summary-meta";

    const list = document.createElement("div");
    list.className = "agent-tool-list";

    summary.append(label, meta);
    details.append(summary, list);
    this.transcriptEl.appendChild(details);

    this.activeToolGroup = { details, summary, label, meta, list, completed: 0 };
    this._renderToolGroupSummary(this.activeToolGroup);
    this._scrollTranscript();
    return this.activeToolGroup;
  }

  _renderToolGroupSummary(group) {
    const total = group.list.children.length;
    group.label.textContent = `Tool calls (${total})`;
    group.meta.textContent = total === 0
      ? "Waiting"
      : group.completed < total
        ? `${group.completed}/${total} complete`
        : "Complete";
  }

  _updateAssistantMessage(content, meta = {}) {
    const row = this.activeAssistantEl ?? this._appendMessage("assistant", "");
    delete row.dataset.state;
    row.dataset.status = meta.status ?? "ok";
    const bubble = row.querySelector(".agent-bubble");
    if (bubble) bubble.textContent = content;
    this.outputEl.textContent = content;
    this.activeAssistantEl = row;
    this._scrollTranscript();
  }

  _appendNotice(text) {
    this._hideEmpty();
    const notice = document.createElement("div");
    notice.className = "agent-notice";
    notice.textContent = text;
    this.transcriptEl.appendChild(notice);
    this._scrollTranscript();
  }

  _createToolLine(entry) {
    this._hideEmpty();
    const line = document.createElement("div");
    const list = this.pendingToolEls.get(entry.name) ?? [];
    list.push(line);
    this.pendingToolEls.set(entry.name, list);
    return line;
  }

  _takePendingToolLine(name) {
    const list = this.pendingToolEls.get(name) ?? [];
    const line = list.shift() ?? document.createElement("div");
    if (list.length) this.pendingToolEls.set(name, list);
    else this.pendingToolEls.delete(name);
    return line;
  }

  _hideEmpty() {
    if (this.emptyEl) this.emptyEl.hidden = true;
  }

  _scrollTranscript() {
    if (this.transcriptEl) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  _setCollapsed(collapsed) {
    this.el.classList.toggle("collapsed", collapsed);
    if (collapsed) this._toggleSettings(false);
    if (collapsed) this._toggleHistory(false);
    const toggle = document.getElementById("agent-toggle");
    const label = collapsed ? "Expand agent panel" : "Collapse agent panel";
    toggle?.setAttribute("aria-expanded", String(!collapsed));
    toggle?.setAttribute("aria-label", label);
    if (toggle) toggle.title = label;
  }
}

function truncate(text, max) {
  const str = String(text ?? "").trim();
  return str.length > max ? `${str.slice(0, max - 1)}...` : str;
}

function statusLabel(status) {
  if (status === "ok") return "Complete";
  if (status === ERROR_STATUS) return "Tool error - retryable";
  if (status === NO_DATA_STATUS) return "No data available";
  if (status === UNVERIFIED_STATUS) return "Unverified - from model memory";
  if (status === "stopped") return "Stopped";
  return "Done";
}
