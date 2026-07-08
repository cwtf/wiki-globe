# Design spec: BYOK LLM agent harness for globe manipulation

Status: **Design only, nothing implemented.** This document captures the
feasibility discussion for letting a user bring their own LLM API key
(OpenRouter, DeepSeek, or a local Ollama server) and ask natural-language
queries ("show me newly industrialized countries", "colour grade countries by
closeness to high-income status") that an LLM answers by calling tools which
manipulate the Cesium globe and pull facts from keyless public sources.

Read this alongside:

- `js/ais.js` (existing BYOK-key pattern)
- `js/wiki-panel.js` (`_placePin`, Wikipedia/Nominatim fetches)
- `js/search.js` (`_highlightCountry`)
- `js/layers/shipping.js` (`_buildRoute`, polyline rendering)
- `js/layers/heatmap.js` (`fillFeature`, `colorFor`, live/bundled indicator modes)
- `js/country-geo.js` (`loadCountryGeo`, `countryAreaKm2`, `countryAt`)
- `js/layers/truesize.js` (area-preserving outline overlay)
- `js/bodies.js` (existing Wikidata SPARQL usage)

---

## 1. Product goal

A chat-style entry point where the user types a query, the LLM (using the
user's own key) plans a sequence of tool calls, and those tools read from
keyless public data sources and/or mutate the existing Cesium viewer — dropping
pins, outlining countries, drawing routes, colour-grading choropleths, or
labelling every country at once.

## 2. Non-goals (explicitly out of scope)

- **General web search.** No free, keyless, CORS-enabled general search API
  exists — Google/Bing/Brave block unauthenticated browser access by design.
  The harness is scoped to Wikipedia, Wikidata, and Nominatim instead of
  promising Google-grade search.
- **Transit/public-transport itinerary routing** (e.g. "Sunway University to
  KLCC via public transport"). Real transit directions need a schedule- and
  transfer-aware routing engine over GTFS data; no keyless general-purpose API
  exists, and self-hosting OpenTripPlanner per region is a separate
  infrastructure project. Excluded per product decision — out of scope for
  this spec.
- **A backend/server component.** The app is a static site with no build step;
  the harness must stay pure ES modules, calling the OpenRouter/DeepSeek/Ollama
  APIs directly from the browser and public keyless endpoints directly, same
  as every other layer in this codebase.

## 3. Architecture overview

- **Multi-provider, direct-from-browser.** OpenRouter, DeepSeek, and Ollama all
  speak the OpenAI-compatible `chat/completions` shape (request
  `messages`+`tools`, response `tool_calls`, follow-up `role: "tool"` messages
  carrying results) — one adapter covers all three, rather than a bespoke
  adapter per provider like Anthropic's Messages API would need.
  - **OpenRouter** — `https://openrouter.ai/api/v1/chat/completions`,
    `Authorization: Bearer <key>`. Explicitly designed for direct client-side
    use (CORS-enabled, documents `HTTP-Referer`/`X-Title` attribution
    headers) — the easiest of the three to integrate. Also the simplest path
    to DeepSeek's models (`deepseek/deepseek-chat`, `deepseek/deepseek-r1`)
    without a separate DeepSeek key, since OpenRouter proxies them.
  - **DeepSeek direct** — `https://api.deepseek.com/chat/completions`,
    OpenAI-SDK-compatible, supports tool calling. **CORS support for direct
    browser calls is unverified** — DeepSeek's docs are written for
    server-side SDK use, not browser-first the way OpenRouter's are. Needs a
    quick real test (`fetch` from the page, check for a CORS error) before
    committing to it; if blocked, fall back to calling the same
    `deepseek/*` models through OpenRouter instead — no other code changes
    needed since both speak the same adapter shape.
  - **Ollama (local)** — `http://localhost:11434/v1/chat/completions` (its
    OpenAI-compatible route), no key at all — the only genuinely free/local/
    private option here. Requires the user to start Ollama with
    `OLLAMA_ORIGINS` set to allow the page's origin (e.g.
    `OLLAMA_ORIGINS=http://localhost:8080`, or `*`) — otherwise the browser
    gets a CORS error. This is a manual one-time setup step on the user's
    machine, not something the app can do for them; needs documenting
    in-app (a setup hint in the chat panel when the Ollama provider is
    selected). Base URL should be a configurable field, not hardcoded, since
    Ollama may run on a different host/port. `GET /api/tags` on the same
    server lists locally-pulled models — use this to populate a model
    dropdown dynamically instead of hardcoding model names, since it varies
    per user.
- **Key storage**: same pattern as `js/ais.js` (`getAisKey`/`setAisKey`,
  `?key=` URL param or `localStorage`), keyed per-provider so a user can have
  an OpenRouter key and a DeepSeek key saved at once. No key is stored/needed
  for Ollama.
- **Agent loop**: one OpenAI-style tool-use loop — send `messages` + `tools`;
  while the response includes `tool_calls`, execute them client-side against
  the viewer/data layer and append `role: "tool"` results; repeat until a
  plain assistant message. Same loop shape regardless of which of the three
  providers is selected, since all three share the request/response shape.
- **New modules** (none of this exists yet):
  - `js/agent/providers.js` — provider registry (`id`, `label`, `baseUrl`,
    `requiresKey`, default/available models, setup notes) and the shared
    OpenAI-compatible request/response adapter.
  - `js/agent/harness.js` — the tool-use loop, provider-agnostic.
  - `js/agent/tools.js` — tool registry: schema + implementation per tool.
  - `js/agent/chat-panel.js` — UI surface: provider selector, per-provider key
    field (hidden for Ollama), model selector, streamed response, visible log
    of which tools fired — transparency matters since tools mutate the globe.

**Decided (was open questions):**

- **Placement**: a collapsible sidebar tab on the right, mirroring the
  existing Wikipedia panel exactly — `#wiki-panel` + `#wp-toggle`
  (`side-collapse-toggle wiki-toggle`, `aria-controls`/`aria-expanded`) at
  [index.html:376](index.html:376) is the pattern to clone: same toggle-button
  shape, same collapse behavior, new `#agent-panel`/`#agent-toggle` pair.
- **Model selection**: a curated dropdown per provider, plus a free-text field
  to enter any other model ID not in the curated list — covers OpenRouter's
  much larger catalog and any future Ollama pull without the dropdown needing
  to be maintained in lockstep. Concrete seed lists per provider:
  - **DeepSeek direct**: `deepseek-chat`, `deepseek-reasoner` — DeepSeek only
    has a couple of models, so this list is small and stable.
  - **Ollama**: `llama3.1`, `qwen2.5`, `mistral-nemo` — the tool-calling-capable
    models already called out in §8 — but this is really just a seed; the
    dropdown should be populated dynamically from `GET /api/tags` on the
    user's own server (§3), since it depends on what they've pulled locally.
  - **OpenRouter is the gap this spec doesn't close yet**: no concrete curated
    list is decided here, and it shouldn't be hardcoded as fixed strings —
    OpenRouter model slugs get renamed/added over time. OpenRouter exposes a
    keyless `GET https://openrouter.ai/api/v1/models` listing endpoint (same
    shape of trick as Ollama's `/api/tags`); the curated shortlist should be a
    small set of preferred model IDs (flagship Claude/GPT/Gemini/DeepSeek
    entries) filtered against that live list at load time, not typed in as
    literal strings that can silently go stale. **Before starting task 1.2/1.5
    below, pick the actual shortlist by querying that endpoint** — don't
    invent slugs from memory.

## 4. Reuse map

| Capability | Existing code | Status |
|---|---|---|
| Drop a pin | `js/wiki-panel.js` `_placePin` | Reusable almost as-is; needs generalizing to accept a label and to tag entities as agent-owned (see §7). |
| Highlight a country outline | `js/search.js` `_highlightCountry` (uses `loadCountryGeo`/rings) | Reusable as-is for a single country; no bulk form. |
| Draw a route between points | `js/layers/shipping.js` `_buildRoute` (`EllipsoidGeodesic` sampling + polyline) | Reusable as-is for arbitrary point lists. |
| Choropleth rendering | `js/layers/heatmap.js` `fillFeature`/`colorFor` (line/value/stops → colour) | Renderer already takes arbitrary `(value, stops)` — reusable. The *mode* wiring around it is fixed to named indicators, not reusable as-is. |
| Country polygon data | `js/country-geo.js` `loadCountryGeo`, `countryAt` | Reusable as-is. |
| Country area | `js/country-geo.js` `countryAreaKm2` | Reusable as-is — no network call needed for area-based queries. |
| True-size outline overlay | `js/layers/truesize.js` | Reusable for a single rigid, area-preserving overlay; does not tile/pack multiple copies. |
| Wikipedia search/extracts | `js/wiki-panel.js` (`en.wikipedia.org/w/api.php`, REST summary) | Reusable as-is for prose/list-style facts. |
| Wikidata SPARQL | `js/bodies.js` (`query.wikidata.org/sparql`) | Pattern reusable, but currently scoped to body/globe QIDs — needs generalizing to arbitrary property queries (e.g. `P474` calling codes). |
| Reverse geocoding | `js/wiki-panel.js` (Nominatim `/reverse`) | Forward geocoding (`/search`) is the sibling endpoint, not yet used — small addition. |
| BYOK key pattern | `js/ais.js` (`getAisKey`/`setAisKey`) | Directly reusable pattern, namespaced per-provider for the OpenRouter/DeepSeek keys (§3). |

## 5. Tool inventory

### 5.1 Map manipulation (mostly wrapping existing code)

| Tool | Backing code | New work |
|---|---|---|
| `add_pin(lat, lon, label)` | `_placePin` | Tag entity as agent-owned; accept/render label. |
| `highlight_country(iso3, color?)` | `_highlightCountry` | Tag entity as agent-owned. |
| `draw_route(points[])` | `_buildRoute` | None beyond exposing as a tool. |
| `clear_agent_overlays()` | — | **New.** Nothing today tracks "entities the agent added this session" separately from other layers' own entities; needed so a new query can reset the board. |

### 5.2 Bulk primitives (genuine gaps)

| Tool | Gap |
|---|---|
| `label_countries({iso3: text})` | **New.** No bulk multi-country labelling exists — today's tools are all single-target. Needs (a) centroid computation per country from existing bbox data, (b) label-density/zoom-level culling so ~195 simultaneous labels don't collide at low zoom — a real rendering gap, not just plumbing. |
| `color_countries({iso3: number}, stops?)` | **New, but renderer is already reusable.** `fillFeature`/`colorFor` take arbitrary values today; what's missing is a generic entry point that accepts an externally computed value map, decoupled from `heatmap.js`'s fixed named-indicator mode switch. |
| `tile_shape_into_country(shapeIso3, targetIso3)` *(stretch, gated)* | **New.** "How many Ukraines fit in China" as a literal packed-tiling visual needs polygon packing on the sphere, extending `truesize.js`'s single rigid-rotation overlay. Real computational-geometry work — worth building, but must run behind the compute-heavy confirmation dialog (§8) rather than firing automatically whenever a query resembles this shape. |

### 5.3 Knowledge / data tools

| Tool | Backing endpoint | Notes |
|---|---|---|
| `wiki_search(query)` / `wiki_extract(title)` | `en.wikipedia.org/w/api.php`, REST summary | Best for fuzzy/contested concepts (e.g. "newly industrialized countries") where an LLM reads prose and extracts a list — prefer this only when there's no clean structured property. |
| `wikidata_sparql(query)` | `query.wikidata.org/sparql` | Prefer this over `wiki_search` whenever the fact is a scalar per-entity property at scale (e.g. `P474` calling code, `P2046` area) — far less hallucination risk than parsing a 195-row table out of prose. |
| `geocode(placeName)` | Nominatim `/search` | New — forward-geocode counterpart to the reverse call already used. |
| `country_area(iso3)` | `countryAreaKm2` (local, no network) | Exposes existing computed data as a callable tool; powers ratio questions like the China/Ukraine example with zero network calls. |
| `fx_rates()` *(example)* | `frankfurter.app` (free, keyless, CORS-enabled) | Concrete instance of "dedicated live-data tool" — exchange rates are a live-numeric-data problem, not a search problem, and shouldn't be answered from Wikipedia/Wikidata. Follows the same live-fetch-with-fallback shape already used per indicator in `heatmap.js`. |

### 5.4 Ephemeris / time-varying astronomy tools (new category)

The §5.3 knowledge tools are all country/currency/prose-fact oriented and
none of them can answer a "where on Earth is astronomical event X" query — the
umbral track of a solar eclipse, a satellite ground track, a sub-solar point,
etc. These are **computed from ephemeris, not fetched from Wikipedia/Wikidata**,
and are exactly the class of query where an LLM will fabricate a
plausible-looking polyline from training memory if no tool covers it (§9). This
is a distinct tool category the country-centric §5.3 inventory did not
anticipate.

The enabling fact: `astronomy-engine` is **already loaded** in this codebase
(`astronomy.browser.min.js` at [index.html:59](index.html:59), used throughout
`js/layers/body.js` via `Astronomy.GeoVector` etc.), so — unlike the genuinely
unsolvable exclusions in §2 (transit routing) and §9 (dynastic borders) — this
gap is closable *locally* with no new data source and no key. It is a missing
tool, not a missing dataset.

| Tool | Backing | Notes |
|---|---|---|
| `eclipse_path(date?)` | `astronomy-engine` (local, no network) | Compute the central line (path of totality) of the next global solar eclipse from the given date as an ordered `[{lat, lon, time}]` list, then render via `draw_route` (§5.1). **Non-trivial:** `Astronomy.SearchGlobalSolarEclipse` returns only peak time + the point of greatest eclipse, *not* the full track — the central line must be reconstructed by sampling the Sun–Moon shadow axis over the eclipse window and intersecting it with the ellipsoid. Real computational geometry → route through the compute-heavy confirmation dialog (§8), same as `tile_shape_into_country`. Return the §9 `NO DATA` signal when no eclipse falls in range or the date is outside ephemeris coverage. |

Both the §5.1 rendering half (`draw_route` takes arbitrary point lists as-is)
and the §7 agent-session tagging apply unchanged — the only genuinely new work
is the ephemeris computation itself and its `NO DATA`/compute-heavy wiring,
both of which reuse patterns already defined elsewhere in this spec.

## 6. Example query → tool trace

Sanity-check the tool inventory against the queries discussed:

- **"Newly industrialized countries"** → `wiki_extract("Newly industrialized country")` → LLM reads the list → `highlight_country` per match (map name → ISO3 via existing country-geo lookup).
- **"Telephone country code of all countries"** → `wikidata_sparql(P474 query)` → `label_countries({...})`.
- **"Colour grade by closeness to high-income status"** → existing World Bank GNI data (already live/bundled in `heatmap.js`/`country-data.js`) + a sourced high-income threshold constant → LLM/tool computes `(threshold − value) / threshold` per country → `color_countries({...})`.
- **"How many Ukraines fit into China"** → `country_area("UKR")`, `country_area("CHN")` → arithmetic (no network) → state the ratio, optionally `tile_shape_into_country` if the stretch feature ships, otherwise fall back to a single `truesize.js` overlay for eyeballing.
- **"Exchange rate of currencies on the globe"** → `fx_rates()` → `color_countries` or per-country `add_pin` labels.
- **"Trace the path of the upcoming solar eclipse"** → `eclipse_path()` (astronomy-engine finds the next global eclipse, reconstructs the central line as sampled `{lat, lon, time}` points, behind the compute-heavy confirmation dialog) → `draw_route(points)`. If no eclipse falls in the searched range, returns `NO DATA` and the model says so rather than drawing a guessed track (§9).

## 7. Entity lifecycle & session model

Today's pin/highlight/route code is fire-and-forget, created by direct user
interaction (click a search result, click the globe). An agent issuing many
tool calls across a multi-turn conversation needs entities tracked as a
distinct group so they can be cleared or replaced without touching
non-agent-owned entities (satellites, flights, shipping lanes, etc.). This is
new bookkeeping, not present anywhere in the current layer model — every
agent-adding tool should tag its Cesium entities/primitives with an
`agent-session` marker, and `clear_agent_overlays()` sweeps only those.

Open product question: does a new query clear the previous query's overlays
by default, or stack? Recommend defaulting to clear-on-new-query (simpler
mental model), with the LLM able to skip the clear when the user's phrasing
implies "also show...".

## 8. Rate limits, cost, and safety

- **Third-party usage policies.** Nominatim's public instance caps at ~1
  request/sec and requires a real User-Agent; an LLM issuing bursty tool calls
  (e.g. geocoding many places, or SPARQL per country in a loop instead of one
  batched query) could violate this. The tool executor should throttle/batch
  rather than trusting the model to self-limit.
- **BYOK usage transparency — decided.** Show raw token usage (input/output
  counts) per turn, not a dollar cost estimate. This applies uniformly across
  providers, including Ollama — token counts are still meaningful with no
  per-token price attached, so nothing needs hiding per-provider, and the
  harness avoids having to source/maintain a per-model pricing table (which
  changes often and isn't needed if the display never converts to $).
- **Guardrails against runaway loops — decided.** Track a per-turn tool-call
  budget and sanity-check bulk operations (e.g. `label_countries` is naturally
  bounded by the ~195 real countries, but nothing stops a model from calling
  `add_pin` in a tight loop). **When the budget is reached, do not silently
  hard-stop the agent mid-task** — leaving a half-drawn board with no
  explanation is a worse experience than either finishing or aborting cleanly.
  Instead, pause the loop and prompt the user with an explicit
  **"continue (grant another N calls) / terminate"** choice:
  - The pause is a checkpoint, not a kill. State is preserved
    (`messages` so far, tools already fired) so **continue** simply resumes the
    same loop with a freshly refilled budget — no re-planning, no lost context.
  - **Terminate** stops the loop cleanly, keeps whatever overlays were already
    drawn (the user can `clear_agent_overlays()` if they want a reset), and
    returns control to the chat without a crash or a dangling `role:"tool"`
    message.
  - The prompt should surface *why* it paused (calls used, what the model was
    about to do next if known) so the user can judge whether it's making real
    progress or spinning. This reuses the same confirmation-dialog surface as
    the compute-heavy gate below rather than inventing a second modal.
  - The budget therefore acts as a *pacing checkpoint*, not a ceiling — an
    unbounded runaway is still impossible (the loop cannot advance past the
    checkpoint without an explicit human OK), but a legitimately long-but-valid
    task is no longer amputated halfway.
- **Compute-heavy tool confirmation — decided.** Any tool flagged as
  computationally heavy (starting with `tile_shape_into_country`'s polygon
  packing, §5.2) must pop a confirmation dialog before running rather than
  executing silently — the user approves the heavy operation the same way
  they'd approve any other consequential action. This is a general pattern,
  not unique to tiling: any future tool doing non-trivial client-side
  computation should route through the same confirmation UI rather than each
  tool inventing its own warning.
- **Tool-calling reliability varies by model**, especially for Ollama's local
  models. Only some (Llama 3.1+, Qwen 2.5, Mistral-Nemo, and similar
  tool-tuned releases) reliably emit well-formed `tool_calls`; smaller/older
  local models may ignore the `tools` schema entirely or emit malformed JSON.
  The harness needs to detect a malformed/missing tool call and fail
  gracefully (tell the user the selected model doesn't support tool use well,
  rather than silently doing nothing or crashing the loop) — this matters far
  less for OpenRouter/DeepSeek's flagship models, which reliably support tool
  calling.

## 9. Groundedness: refusing when data isn't available

Every tool in §5 has a bounded, known scope — Wikidata SPARQL answers
structured per-entity facts, `country_area` only works for present-day
polygons already loaded, `fx_rates` covers whatever `frankfurter.app`
publishes. The harness's most important behavioral requirement is that when a
query falls outside every tool's actual coverage, the model says so instead
of answering from parametric memory.

This came up concretely while scoping "show me the evolution of the Chinese
border from Qin Dynasty till present" as an example query: real dynastic
boundary polygon data essentially doesn't exist as a live or complete bundled
dataset — no keyless source exists, and the one real academic dataset, CHGIS,
would require a dedicated curation effort that hasn't happened. An LLM asked
this will happily describe a
plausible-sounding border from training knowledge if not explicitly told not
to. On a globe UI a fabricated boundary rendered as a polygon looks exactly
as authoritative as a real one — a more dangerous failure mode than a wrong
text answer, since the visualization itself carries false confidence. The
same discipline generalizes to any query outside a tool's real coverage, not
just historical borders — a Wikidata query returning zero rows, a
`wiki_search` turning up nothing relevant, or a `color_countries` metric
whose threshold constant was never sourced.

Concrete requirements:

- **Tools must return an explicit "no data" signal**, distinguishable from an
  empty-but-valid result, rather than throwing an opaque error the model
  might paper over or reinterpret as license to guess.
- **System prompt must instruct the model**: for any factual, geographic, or
  quantitative claim, only state what a tool actually returned; if no tool
  covers the request, say so explicitly rather than answering from training
  knowledge. This is a hard behavioral rule, not a style preference, and
  should be tested with adversarial-ish prompts (obscure/ancient/contested
  entities) before shipping.
- **The chat UI should visually distinguish "answered from tool data" vs. "the
  model declined"**, so a partial answer (e.g. "no historical boundary data
  available, but here's the present-day border") reads as an explicit partial
  result rather than a silent success — extending the existing `LIVE`/`DATA`/
  idle/`…` badge convention (CLAUDE.md design principle #2) with a `NO DATA`
  state for agent-added overlays.
- **Time-series/historical boundary visualization stays unbuilt** unless and
  until a properly sourced, hand-curated dataset is actually added — until
  then this class of query is exactly the case the model should be refusing,
  not attempting from memory.

## 10. Phasing

1. **Harness core**: provider registry + shared OpenAI-compatible adapter
   (OpenRouter, DeepSeek, Ollama), per-provider BYOK key management (reuse
   `ais.js` pattern), agent loop, chat panel UI, and wrap the three
   single-target map tools (`add_pin`, `highlight_country`, `draw_route`) plus
   `clear_agent_overlays`. Verify DeepSeek-direct's CORS support early in this
   phase (§3) since it decides whether DeepSeek needs its own key at all or
   should just be offered as OpenRouter models. The groundedness system
   prompt and "no data" tool-result convention (§9) belong in this phase too
   — it's a foundational behavioral contract, not a later polish pass.
2. **Knowledge tools**: `wiki_search`/`wiki_extract`, generalized
   `wikidata_sparql`, `geocode`. Unlocks the "newly industrialized countries"
   class of query.
3. **Bulk primitives**: `label_countries` (+ LOD/culling), `color_countries`
   (generic value-map choropleth mode). Unlocks calling-codes and
   high-income-proximity queries.
4. **Geometry tool**: `country_area` exposed as a callable. Unlocks
   area-ratio questions with zero network calls.
5. **Stretch**: `tile_shape_into_country` polygon packing/tiling visualization,
   and `eclipse_path` ephemeris tool (§5.4) — both gated behind the §8
   compute-heavy confirmation dialog, both reusing `draw_route`/geometry
   rendering. Independent of each other; either can ship without the other.

Explicitly deferred indefinitely: general web search, transit/public-transport
routing (see §2).

## 11. Open questions

- Clear-vs-stack default for agent overlays across turns (§7).
- Resolved 2026-07-09: DeepSeek-direct responded to an `OPTIONS` preflight for
  `https://api.deepseek.com/chat/completions` with
  `access-control-allow-origin: http://localhost:8080`, `POST`, and
  `content-type,authorization`, so keep the direct provider for Phase 1 unless
  full browser POST testing with a real key proves otherwise.
- Should Anthropic (or other providers) be added later as a fourth adapter
  behind `js/agent/providers.js`, given its tool-use format differs from the
  OpenAI-compatible shape the other three share — worth designing the
  registry so a non-OpenAI-shaped adapter can slot in later without a rewrite?
- How to actually validate the groundedness rule (§9) pre-ship — needs a set
  of adversarial test prompts (obscure/ancient/contested/nonexistent
  entities) that should reliably produce a refusal, checked per provider and
  per model, since smaller/local Ollama models may be less reliable at
  following the "don't answer from memory" instruction than flagship
  OpenRouter models.

Resolved: chat panel placement (§3), cost/usage display (§8), model selection
UX (§3), and the `tile_shape_into_country` build-vs-skip question (§5.2, §8)
— see the referenced sections.

---

## 12. Development todo list

**Read this first if you are an LLM picking up this work.** Everything above is
design; nothing here is implemented yet (the `js/agent/` directory does not
exist). This section is the actionable, hand-off-safe task breakdown. Work it
top to bottom — tasks are ordered so each builds on the last, mirroring the
phasing in §10. Before starting any task, (a) re-read the section it cites for
the decided behavior, (b) read the existing code named in §4's reuse map so you
copy the established pattern instead of inventing one, and (c) confirm the app
still runs (`preview_start` against the `wiki-globe` launch config, port 8080).

**Ground rules for every task:**

- No build step, no npm, no bundler — plain ES modules loaded from
  `index.html`, same as every other file in `js/`. Do not add a package.json
  dependency for the harness.
- Follow CLAUDE.md's design principles: live-data-first with bundled fallback,
  truthful `LIVE`/`DATA`/`…`/`NO DATA` badges, interaction parity across bodies.
- When you finish a task: tick its box, add a one-line note of what shipped and
  any deviation from the plan, and verify in the browser before moving on
  (there is no test suite — exercise the feature in the UI).
- If a task's design assumption turns out wrong while implementing, stop and
  record it in §11 (Open questions) rather than silently improvising — the next
  picker-upper relies on this doc staying accurate.

### Phase 1 — Harness core (§10.1)

- [ ] **1.1 Scaffold `js/agent/` modules.** Create empty-but-wired
  `providers.js`, `harness.js`, `tools.js`, `chat-panel.js` per §3's "New
  modules" list. Export the class/functions each will own; stub bodies are
  fine. Wire `chat-panel.js` init into `js/app.js` boot and add its instance to
  window.__globe (CLAUDE.md convention). *Done when:* app boots with the four
  modules loaded and no console errors. **Started 2026-07-09:** modules, app boot wiring, `#agent-panel`, and `window.__globe.agent` landed; browser console verification still pending.
- [x] **1.2 Verify DeepSeek-direct CORS, and pick the OpenRouter model
  shortlist** (§3, §11) — do this *before* 1.3, since 1.3 builds the registry
  around these two facts. `fetch` DeepSeek's endpoint from the page and check
  for a CORS error; record the result in §11 — if blocked, drop the
  DeepSeek-direct provider entirely and offer `deepseek/*` models through
  OpenRouter only (no adapter change needed). Separately, query OpenRouter's
  `GET /api/v1/models` and pick the actual curated shortlist (§3) — don't
  hardcode remembered slugs. **Shipped 2026-07-09:** DeepSeek preflight succeeded; OpenRouter live shortlist selected as `openai/gpt-4.1`, `openai/gpt-4.1-mini`, `anthropic/claude-sonnet-4`, `google/gemini-2.5-pro`, `google/gemini-2.5-flash`, `deepseek/deepseek-chat`, and `deepseek/deepseek-r1`.
- [x] **1.3 Provider registry + OpenAI-compatible adapter** (`providers.js`,
  §3). Register OpenRouter, (DeepSeek-direct if 1.2 confirmed it works), and
  Ollama with `id`, `label`, `baseUrl`, `requiresKey`, the model shortlist from
  1.2, and setup notes. One shared adapter builds the `messages`+`tools`
  request and parses `tool_calls`/`role:"tool"` responses for all three. *Done
  when:* a hardcoded test call to one provider returns a parsed assistant
  message. **Shipped 2026-07-09:** `providers.js` registers OpenRouter, DeepSeek-direct, and Ollama; `buildChatCompletionRequest`/`parseChatCompletionResponse` back the shared adapter; a mocked Ollama-compatible `completeChat` smoke test returned a parsed assistant message, tool call, and token usage.
- [x] **1.4 Per-provider BYOK key storage** (§3, §8). Clone the
  `getAisKey`/`setAisKey` pattern from `js/ais.js` (`?key=` param or
  `localStorage`), keyed per-provider so OpenRouter and DeepSeek keys coexist;
  Ollama needs none. *Done when:* keys persist across reload and are namespaced
  per provider. **Shipped 2026-07-09:** OpenRouter and DeepSeek keys persist under provider-specific localStorage names; provider-specific URL params win; generic `?key=` seeds only the initial provider (`?provider=deepseek&key=...` works); Ollama ignores key storage. Mocked localStorage smoke test passed.
- [x] **1.5 Agent tool-use loop** (`harness.js`, §3). Send `messages`+`tools`;
  while the response has `tool_calls`, execute against the registry and append
  `role:"tool"` results; stop on a plain assistant message. Enforce the
  per-turn tool-call budget (§8) and the malformed/missing-tool-call graceful
  failure (§8, tell the user the model doesn't support tool use well). *Done
  when:* a multi-step query completes a full loop with a capped call count. **Shipped 2026-07-09:** `AgentHarness` now supports injected chat completion for deterministic testing, appends `role:"tool"` results, aggregates token usage, caps tool calls, converts malformed arguments/tool exceptions into `no_data` results, and returns a clear tool-use support error when a model finishes with missing tool calls. Mocked smoke tests covered happy path, budget cap, malformed arguments, and missing tool calls. **Superseded 2026-07-09:** §8's runaway-loop guardrail was changed from a silent hard cap to a **pause-and-prompt (continue/terminate) checkpoint** *after* this task shipped — the current hard-stop is now a known deviation from §8. Do not re-tick; the checkpoint behavior is tracked as task **1.9** below.
- [x] **1.9 Budget checkpoint (continue/terminate)** (§8) — revise the shipped
  1.5 hard cap into a pausing checkpoint. When the per-turn tool-call budget is
  reached, suspend the loop with `messages` + fired-tools state intact and
  prompt the user via the compute-heavy confirmation-dialog surface
  (cross-cutting item below): **continue** refills the budget and resumes the
  *same* loop (no re-planning, no lost tool results); **terminate** stops
  cleanly, keeps overlays drawn so far, and returns to the chat with no
  dangling `role:"tool"` message. Surface *why* it paused (calls used, next
  intended action if known). *Done when:* a query that exceeds the initial
  budget pauses, offers continue/terminate, and on continue resumes without
  re-planning; on terminate leaves a clean chat state and intact overlays.
  **Shipped 2026-07-09:** `DEFAULT_TOOL_BUDGET` raised 12→20; `harness.run`
  now calls an `onCheckpoint({usedCalls, budget, pending})` callback at the
  budget boundary — `continue` bumps `budgetLimit` by another 20 and resumes
  the same loop; `terminate` pushes a `no_data` tool result for *every* pending
  `tool_call` id (fixing a latent dangling-tool_calls bug in the old hard-stop)
  and returns `status:"stopped"`. No `onCheckpoint` handler defaults to
  terminate so headless/test callers stay bounded. `chat-panel.js` renders a
  `#agent-checkpoint` continue/terminate prompt (naming the pending tools),
  and `_cancel`/`finally` resolve any pending checkpoint as terminate so an
  in-flight cancel unblocks the awaiting loop. Verified in-browser: first
  checkpoint at exactly 20 calls, continue → second at 40, terminate → clean
  stop with zero dangling tool_calls; UI prompt show/hide + Continue/Terminate/
  Cancel resolution all confirmed against the running app.
- [x] **1.6 Chat panel UI** (`chat-panel.js`, §3). Clone the `#wiki-panel` /
  `#wp-toggle` collapse pattern at [index.html:376](index.html:376) into a new
  `#agent-panel` / `#agent-toggle` pair. Include: provider selector,
  per-provider key field (hidden for Ollama), model dropdown **plus free-text
  override** (§3), streamed response, a visible log of which tools fired, and
  raw input/output token counts per turn (§8). Add the Ollama `OLLAMA_ORIGINS`
  setup hint shown only when Ollama is selected (§3). For Ollama, populate the
  model dropdown from `GET /api/tags` (§3). *Done when:* the panel collapses
  like the Wikipedia panel and drives a real end-to-end query. **Shipped 2026-07-09:** panel has provider/key/base URL/model controls, free-text model override, status/response/usage surfaces, visible tool log, cancel/run state, Ollama-only `OLLAMA_ORIGINS` hint, and Ollama `/api/tags` model loading via `availableModels`. Verified with a fake-DOM panel smoke test plus HTTP checks against the running static server; a real provider-key query is still pending manual credentials.
- [x] **1.7 Groundedness contract** (§9) — foundational, not polish. Write the
  system prompt's hard "only state what a tool returned; refuse if no tool
  covers it" rule. Define the tool-result "no data" signal shape (distinct from
  empty-but-valid) that every tool will use. Add the `NO DATA` badge state to
  the chat UI. *Done when:* an out-of-coverage query (e.g. the Qin-dynasty
  border example) yields an explicit refusal, not a fabricated answer. **Shipped 2026-07-09:** strengthened the harness system prompt, centralized the `no_data` result shape and `NO_DATA_STATUS`, propagated no-data status through final turn metadata for the UI badge, and smoke-tested an out-of-coverage historical boundary refusal.
- [x] **1.8 Single-target map tools** (`tools.js`, §5.1). Wrap `add_pin`
  (via `_placePin`), `highlight_country` (via `_highlightCountry`), `draw_route`
  (via `_buildRoute`), and implement `clear_agent_overlays`. Every
  agent-adding tool tags its entities with the `agent-session` marker (§7) so
  the clear sweeps only agent-owned entities. *Done when:* the LLM can pin,
  highlight, route, and clear via natural language. **Shipped 2026-07-09:** `AgentToolRegistry` exposes `add_pin`, `highlight_country`, `draw_route`, and `clear_agent_overlays`, tags every created entity with the `agent-session` marker plus agent metadata, validates out-of-range inputs as `no_data`, and clears only tracked agent entities. Verified with a mocked Cesium/country-geo smoke test covering pin, invalid pin, highlight, route, and clear.

### Phase 2 — Knowledge tools (§10.2)

- [x] **2.1 `wiki_search` / `wiki_extract`** (§5.3) wrapping the
  `en.wikipedia.org/w/api.php` + REST summary calls already in
  `js/wiki-panel.js`. Return the `NO DATA` signal on no relevant hit. **Shipped 2026-07-09:** `AgentToolRegistry` now exposes `wiki_search(query, limit?)` via the English Wikipedia search API and `wiki_extract(title)` via REST summaries, returning structured titles/snippets/extracts/URLs/coordinates and explicit `no_data` for empty search, missing summary, empty extract, or disambiguation pages. Verified with mocked fetch smoke tests.
- [x] **2.2 Generalize `wikidata_sparql`** (§4, §5.3). Extend the
  `query.wikidata.org/sparql` usage in `js/bodies.js` beyond body/globe QIDs to
  arbitrary property queries (e.g. `P474` calling codes, `P2046` area). Return
  `NO DATA` on zero rows. Encode the §5.3 tool-selection preference (prefer
  this over `wiki_search` whenever the fact is a scalar per-entity property at
  scale) in this tool's own JSON-schema `description` field, not just as prose
  in this doc — the model only sees what's in the schema at call time. **Shipped 2026-07-09:** `AgentToolRegistry` now exposes a read-only `wikidata_sparql(query, limit?)` SELECT wrapper using `query.wikidata.org/sparql`, reuses the shared network queue, appends a bounded LIMIT when absent, normalizes SPARQL JSON bindings into structured row values, returns `no_data` for zero rows/non-SELECT/HTTP failures, and includes the Wikidata-over-Wikipedia scalar-property preference in the tool schema. Verified with mocked SPARQL smoke tests.
- [x] **2.3 `geocode(placeName)`** (§5.3) — forward Nominatim `/search`, the
  sibling of the `/reverse` call already in `js/wiki-panel.js`. Route through
  the throttle/batch layer (§8) — Nominatim caps at ~1 req/sec and needs a real
  User-Agent. *Unlocks the "newly industrialized countries" query class (§6).* **Shipped 2026-07-09:** `AgentToolRegistry` now exposes `geocode(placeName, limit?)` via Nominatim `/search`, routes requests through the shared throttle queue, caps results at five, returns normalized coordinates/address/bounding-box metadata, and reports `no_data` for empty, invalid, or failed lookups. Browser fetch cannot set the forbidden `User-Agent` header manually, so this relies on the browser UA/Referer plus throttled one-at-a-time requests. Verified with mocked Nominatim smoke tests.

### Phase 3 — Bulk primitives (§10.3)

- [x] **3.1 `label_countries({iso3: text})`** (§5.2) — the genuine rendering
  gap. Needs (a) per-country centroid from existing bbox data in
  `js/country-geo.js`, and (b) label-density/zoom-level culling so ~195 labels
  don't collide at low zoom. Tag as `agent-session`. **Shipped 2026-07-09:** `AgentToolRegistry` now exposes `label_countries({labels:{iso3:text}, color?})`, resolves ISO3 codes against `loadCountryGeo`, places labels at bbox-center country points, tags every label entity with `agent-session`, reports missing ISO3 codes, and uses Cesium distance display/scale/translucency settings so dense label sets thin out by zoom. Verified with mocked country/Cesium smoke tests covering placement, missing codes, culling properties, and clearing.
- [x] **3.2 `color_countries({iso3: number}, stops?)`** (§5.2) — a generic
  value-map choropleth entry point that feeds `fillFeature`/`colorFor` in
  `js/layers/heatmap.js` directly, decoupled from its fixed named-indicator mode
  switch. *Unlocks calling-codes and high-income-proximity queries (§6).* **Shipped 2026-07-09:** `AgentToolRegistry` now exposes `color_countries({values:{iso3:number}, stops?})`, reuses exported `fillFeature`/`colorFor` heatmap helpers through a transparent single-tile canvas overlay, auto-generates blue/yellow/red stops when omitted, tracks agent imagery layers for `clear_agent_overlays`, and reports missing ISO3 codes. Verified with mocked country/Cesium/canvas smoke tests covering painting, custom/default stops, invalid inputs, and layer clearing.

### Phase 4 — Geometry tool (§10.4)

- [x] **4.1 `country_area(iso3)`** (§5.3) — expose `countryAreaKm2` from
  `js/country-geo.js` as a callable tool (no network). *Unlocks area-ratio
  questions like "how many Ukraines fit into China" (§6).* **Shipped 2026-07-09:** `AgentToolRegistry` now exposes `country_area(iso3)`, resolves present-day ISO3 features from `loadCountryGeo`, computes `countryAreaKm2` locally with no network call, returns numeric and formatted area plus source metadata, and reports `no_data` for malformed or unknown ISO3 codes. Verified with mocked country-geo smoke tests.

### Phase 5 — Stretch (§10.5, gated)

- [ ] **5.1 `tile_shape_into_country(shapeIso3, targetIso3)`** (§5.2) —
  sphere polygon packing extending `js/layers/truesize.js`'s single rigid
  overlay. Must route through the compute-heavy confirmation dialog (§8), not
  fire automatically. Real computational-geometry work — treat as optional.
- [ ] **5.2 `eclipse_path(date?)`** (§5.4) — reconstruct the next global solar
  eclipse's central line from `astronomy-engine` (already loaded, no key, no
  network) by sampling the Sun–Moon shadow axis over the eclipse window;
  render via `draw_route` (§5.1), tag as `agent-session` (§7). Route through
  the compute-heavy confirmation dialog (§8) and return the §9 `NO DATA`
  signal when no eclipse is in range. Independent of 5.1 — can ship without
  the tiling tool. *Note:* `SearchGlobalSolarEclipse` gives only peak +
  greatest-eclipse point, so the full track is your own geometry — verify a
  sampled point against a published path (e.g. a known past eclipse) before
  trusting it, per the CLAUDE.md orientation-verification discipline.

### Cross-cutting, do throughout

- [ ] **Throttle/batch executor** (§8) shared by all network tools — do not
  trust the model to self-limit Nominatim/SPARQL bursts. Land the skeleton in
  Phase 1's `tools.js` and route every network tool through it as it's added.
- [ ] **Confirmation-dialog surface** (§8) — general reusable pause/approve
  modal, not a one-off warning. Two consumers: (a) the **budget checkpoint**
  (task 1.9, continue/terminate on tool-call budget) — the earliest consumer,
  in Phase 1; and (b) the **compute-heavy gate** (first heavy tool is 5.1
  `tile_shape_into_country`, also 5.2 `eclipse_path`). Same surface, two
  callers — build it once with a generic "here's what's about to happen /
  proceed / stop" shape rather than a tiling-specific warning. **Partial
  2026-07-09:** task 1.9 shipped an inline `#agent-checkpoint` continue/
  terminate prompt in `chat-panel.js` (its own two-button block, not a shared
  modal). When the compute-heavy gate is built, factor these two into one
  reusable surface rather than adding a second bespoke prompt — the 1.9 block
  is the de-facto template.
- [ ] **Adversarial groundedness test set** (§9, §11) — a fixed list of
  obscure/ancient/contested/nonexistent-entity prompts that must reliably
  produce a refusal, re-run per provider and per model (local Ollama models are
  the weakest link). Keep it in this repo so the next picker-upper can re-run
  it.

### Attribution & docs (before merge)

- [ ] Any new imagery/texture needs a sidebar `.attrib` line + README entry
  (CLAUDE.md principle #4) — likely N/A for this feature, confirm.
- [ ] Document the Ollama `OLLAMA_ORIGINS` one-time setup in the README, not
  only the in-app hint (§3).
- [ ] Update CLAUDE.md's Architecture section to describe `js/agent/` once
  Phase 1 lands, so the module map stays current.
