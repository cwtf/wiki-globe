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

export class AgentChatPanel {
  constructor(viewer) {
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
    this.abort = null;

    this.tools = new AgentToolRegistry(viewer);
    this.harness = new AgentHarness(this.tools);

    this._populateProviders();
    this._bind();
    this._syncProvider();
  }

  async refreshModels() {
    const provider = providerById(this.providerEl.value);
    this.modelEl.replaceChildren(new Option("Loading models...", provider.defaultModel));
    const models = await availableModels(provider.id, this.baseEl.value);
    this.modelEl.replaceChildren(...models.map((model) => new Option(model, model)));
    this.modelEl.value = models.includes(provider.defaultModel) ? provider.defaultModel : (models[0] ?? provider.defaultModel);
  }

  _populateProviders() {
    this.providerEl.replaceChildren(...providers().map((provider) => new Option(provider.label, provider.id)));
    this.providerEl.value = getInitialProviderId();
  }

  _bind() {
    document.getElementById("agent-close")?.addEventListener("click", () => this._setCollapsed(true));
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
    this.noteEl.textContent = provider.setupNote ?? "";
    await this.refreshModels();
  }

  async _submit() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.abort) this.abort.abort();
    this.abort = new AbortController();
    const provider = providerById(this.providerEl.value);
    const model = this.modelOverrideEl.value.trim() || this.modelEl.value || provider.defaultModel;
    const key = provider.requiresKey ? this.keyEl.value.trim() : null;
    if (provider.requiresKey) setProviderKey(provider.id, key);
    if (provider.configurableBaseUrl) setProviderBaseUrl(provider.id, this.baseEl.value.trim());

    this._setBadge("loading");
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
          onTool: (entry) => this._logTool(entry),
          onUsage: (usage) => this._renderUsage(usage),
          onMessage: (content, meta) => {
            this.outputEl.textContent = content;
            this._setBadge(meta.status === NO_DATA_STATUS ? "nodata" : "live");
          },
        },
      });
      this._renderUsage(result.usage);
      this.inputEl.value = "";
    } catch (e) {
      if (e.name === "AbortError") return;
      this.outputEl.textContent = e.message;
      this._setBadge("nodata");
    } finally {
      this.abort = null;
    }
  }

  _logTool(entry) {
    const line = document.createElement("div");
    line.className = `agent-tool ${entry.status ?? "running"}`;
    const result = entry.result?.status ? ` -> ${entry.result.status}` : "";
    line.textContent = `${entry.name}${result}`;
    this.toolLogEl.appendChild(line);
  }

  _renderUsage(usage) {
    this.usageEl.textContent = `Tokens: input ${usage.input ?? 0}, output ${usage.output ?? 0}`;
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
