const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const STORAGE_PREFIX = "wikiglobe.agent";

const OPENROUTER_SHORTLIST = [
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "anthropic/claude-sonnet-4",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
];

const PROVIDERS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    modelSource: "openrouter",
    defaultModel: "openai/gpt-4.1-mini",
    seedModels: OPENROUTER_SHORTLIST,
    setupNote: "Uses your OpenRouter key in this browser. DeepSeek models are also available here.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    requiresKey: true,
    defaultModel: "deepseek-chat",
    seedModels: ["deepseek-chat", "deepseek-reasoner"],
    setupNote: "DeepSeek direct CORS preflight succeeded for http://localhost:8080 on 2026-07-09.",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    configurableBaseUrl: true,
    modelSource: "ollama",
    defaultModel: "llama3.1",
    seedModels: ["llama3.1", "qwen2.5", "mistral-nemo"],
    setupNote: "Start Ollama with OLLAMA_ORIGINS allowing this page origin, for example OLLAMA_ORIGINS=http://localhost:8080.",
  },
];

let openRouterModelsPromise = null;

export function providers() {
  return PROVIDERS.map((provider) => ({ ...provider, seedModels: [...provider.seedModels] }));
}

export function providerById(id) {
  return providers().find((provider) => provider.id === id) ?? providers()[0];
}

export function getInitialProviderId() {
  const params = currentParams();
  return providerById(params.get("agentProvider") || params.get("provider")).id;
}

export function getProviderKey(providerId) {
  const provider = providerById(providerId);
  if (!provider.requiresKey) return null;

  const params = currentParams();
  const providerParam = params.get(`${provider.id}Key`) || params.get(`agent-${provider.id}-key`);
  if (providerParam) {
    setProviderKey(provider.id, providerParam);
    return providerParam;
  }

  const genericParam = params.get("key");
  if (genericParam && provider.id === getInitialProviderId()) {
    setProviderKey(provider.id, genericParam);
    return genericParam;
  }

  try { return localStorage.getItem(keyStorageName(provider.id)); } catch { return null; }
}

export function setProviderKey(providerId, key) {
  const provider = providerById(providerId);
  if (!provider.requiresKey) return;
  try {
    if (key) localStorage.setItem(keyStorageName(provider.id), key);
    else localStorage.removeItem(keyStorageName(provider.id));
  } catch { /* private mode */ }
}

export function getProviderBaseUrl(providerId) {
  const provider = providerById(providerId);
  const params = currentParams();
  const fromUrl = params.get(`${provider.id}BaseUrl`) || params.get(`agent-${provider.id}-base-url`);
  if (fromUrl) {
    setProviderBaseUrl(provider.id, fromUrl);
    return stripTrailingSlash(fromUrl);
  }
  try {
    return stripTrailingSlash(localStorage.getItem(baseUrlStorageName(provider.id)) || provider.baseUrl);
  } catch {
    return provider.baseUrl;
  }
}

export function setProviderBaseUrl(providerId, baseUrl) {
  try {
    const provider = providerById(providerId);
    const value = stripTrailingSlash(baseUrl || provider.baseUrl);
    if (value && value !== provider.baseUrl) localStorage.setItem(baseUrlStorageName(provider.id), value);
    else localStorage.removeItem(baseUrlStorageName(provider.id));
  } catch { /* private mode */ }
}

export async function availableModels(providerId, baseUrl = null) {
  const provider = providerById(providerId);
  if (provider.modelSource === "openrouter") {
    const live = await fetchOpenRouterModels();
    const liveIds = new Set(live.map((model) => model.id));
    const curated = provider.seedModels.filter((id) => liveIds.has(id));
    return curated.length ? curated : provider.seedModels;
  }
  if (provider.modelSource === "ollama") {
    const live = await fetchOllamaModels(baseUrl || getProviderBaseUrl(providerId));
    return live.length ? live : provider.seedModels;
  }
  return provider.seedModels;
}

export function buildChatCompletionRequest({ providerId, model, key, baseUrl, messages, tools }) {
  const provider = providerById(providerId);
  if (provider.requiresKey && !key) {
    throw new Error(`${provider.label} needs an API key.`);
  }

  const url = `${stripTrailingSlash(baseUrl || provider.baseUrl)}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (provider.requiresKey) headers.Authorization = `Bearer ${key}`;
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = globalThis.location?.origin ?? "https://wiki-globe.local";
    headers["X-Title"] = "Wiki Globe";
  }

  const body = {
    model: model || provider.defaultModel,
    messages,
    tools,
    tool_choice: tools?.length ? "auto" : undefined,
  };

  return { provider, url, headers, body };
}

export async function completeChat({ providerId, model, key, baseUrl, messages, tools, signal, fetchImpl = fetch }) {
  const { provider, url, headers, body } = buildChatCompletionRequest({
    providerId,
    model,
    key,
    baseUrl,
    messages,
    tools,
  });

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message ?? ""; } catch { /* ignore */ }
    throw new Error(`${provider.label} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  return parseChatCompletionResponse(await res.json());
}

export function parseChatCompletionResponse(data) {
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    id: data.id ?? null,
    message: normalizeAssistantMessage(message),
    usage: normalizeUsage(data.usage),
    finishReason: choice.finish_reason ?? null,
    raw: data,
  };
}

function normalizeAssistantMessage(message) {
  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
}

function normalizeUsage(usage) {
  return {
    input: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    total: usage?.total_tokens ?? null,
  };
}

async function fetchOpenRouterModels() {
  openRouterModelsPromise ??= fetch(OPENROUTER_MODELS_URL)
    .then((res) => res.ok ? res.json() : null)
    .then((data) => Array.isArray(data?.data) ? data.data : [])
    .catch(() => []);
  return openRouterModelsPromise;
}

async function fetchOllamaModels(baseUrl) {
  try {
    const root = stripTrailingSlash(baseUrl).replace(/\/v1$/, "");
    const res = await fetch(`${root}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.models ?? [])
      .map((model) => model.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function currentParams() {
  return new URLSearchParams(globalThis.location?.search ?? "");
}

function keyStorageName(providerId) {
  return `${STORAGE_PREFIX}.${providerId}.key`;
}

function baseUrlStorageName(providerId) {
  return `${STORAGE_PREFIX}.${providerId}.baseUrl`;
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}
