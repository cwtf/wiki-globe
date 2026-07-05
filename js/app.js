// Wiki Globe — entry point.
// Night-texture globe with three movement layers (satellites / flights /
// shipping), an OSM detail crossfade on zoom, and a click-to-Wikipedia panel.

import { SatelliteLayer } from "./layers/satellites.js";
import { FlightLayer } from "./layers/flights.js";
import { ShippingLayer } from "./layers/shipping.js";
import { HeatmapLayer, METRICS, heatStressLabel, RES_STEPS, loadHeatmapMetrics } from "./layers/heatmap.js";
import { TrueSizeLayer } from "./layers/truesize.js";
import { MoonLayer } from "./layers/moon.js";
import { CountrySearch } from "./search.js";
import { WikiPanel } from "./wiki-panel.js";
import { getAisKey, setAisKey } from "./ais.js";

// OSM tiles fade in below FADE_START camera height and are fully opaque by FADE_END.
const FADE_START = 2.6e6;
const FADE_END = 5.5e5;
const AUTOROTATE_RATE = 0.006;        // rad/s
const AUTOROTATE_IDLE_MS = 8000;
const AUTOROTATE_MIN_HEIGHT = 1.2e6;  // stop spinning once zoomed into the map

async function boot() {
  await loadHeatmapMetrics();

  const viewer = new Cesium.Viewer("cesiumContainer", {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
      Cesium.SingleTileImageryProvider.fromUrl("assets/earth-night.jpg")
    ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
  });

  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#06090f");
  scene.screenSpaceCameraController.minimumZoomDistance = 120;
  scene.screenSpaceCameraController.maximumZoomDistance = 4.5e7;

  // double-click otherwise zooms to an entity and fights the wiki-click UX
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
  );

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 22, 2.3e7),
  });

  // Real-time solar illumination: the clock runs at 1x so the terminator
  // tracks the actual sun. The day texture sits above the night texture and
  // fades out on the night side (nightAlpha), blending at the terminator.
  viewer.clock.currentTime = Cesium.JulianDate.now();
  viewer.clock.multiplier = 1;
  viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK; // hard real time, no drift
  viewer.clock.shouldAnimate = true;
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;

  const dayLayer = Cesium.ImageryLayer.fromProviderAsync(
    Cesium.SingleTileImageryProvider.fromUrl("assets/earth-day.jpg")
  );
  dayLayer.nightAlpha = 0;
  viewer.imageryLayers.add(dayLayer);

  // OSM detail layer, transparent until the camera comes down
  const osmLayer = viewer.imageryLayers.addImageryProvider(
    new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })
  );
  osmLayer.alpha = 0;

  // --- layers ---------------------------------------------------------------
  const sats = new SatelliteLayer(viewer);
  const flights = new FlightLayer(viewer);
  const ships = new ShippingLayer(viewer);
  const heat = new HeatmapLayer(viewer); // lazy: fetches when a mode is selected
  const truesize = new TrueSizeLayer(viewer);
  const moon = new MoonLayer(viewer);
  const wiki = new WikiPanel(viewer);

  ships.init();
  sats.init();
  flights.init();
  moon.init();

  // "Back to Earth" appears while the camera is parked at the moon
  const moonBack = document.getElementById("moon-back");
  moonBack.addEventListener("click", () => moon.blur());

  // body switcher next to the search bar; stays in sync with click-driven
  // focus changes so it always names the world under the camera
  const selBody = document.getElementById("sel-body");
  selBody.addEventListener("change", () => {
    if (selBody.value === "moon") moon.focus();
    else moon.blur();
  });

  // Focus scoping: only the body under the camera keeps its overlays. Earth
  // layers are parked (checkboxes untouched) while the moon has focus, and
  // lunar article markers exist only there — first visit triggers their load.
  // References layer toggles declared later in boot; runs only on user input.
  let heatModeSuspended = null;
  moon.onFocusChanged = (focused) => {
    moonBack.hidden = !focused;
    selBody.value = focused ? "moon" : "earth";
    document.body.classList.toggle("moon-focus", focused);
    wiki.close();
    moon.setArticlesVisible(focused);
    if (focused) {
      sats.setVisible(false);
      flights.setVisible(false);
      ships.setVisible(false);
      heatModeSuspended = heat.mode;
      if (heatModeSuspended) heat.setMode(null);
    } else {
      sats.setVisible(layerToggles.sats.checked);
      flights.setVisible(layerToggles.flights.checked);
      ships.setVisible(layerToggles.ships.checked);
      if (heatModeSuspended) heat.setMode(heatModeSuspended);
      heatModeSuspended = null;
    }
  };

  // --- per-frame loop ---------------------------------------------------------
  let lastFrame = 0;
  let lastInteraction = Date.now();
  let rotateEnabled = document.getElementById("chk-rotate").checked;
  let dayNightEnabled = document.getElementById("chk-daynight").checked;

  function syncDayNight() {
    dayLayer.nightAlpha = dayNightEnabled ? 0 : 1;
    const wantLighting = dayNightEnabled && osmLayer.alpha < 0.8 && !heat.visible;
    if (scene.globe.enableLighting !== wantLighting) {
      scene.globe.enableLighting = wantLighting;
    }
  }

  for (const evt of ["pointerdown", "wheel", "touchstart"]) {
    viewer.canvas.addEventListener(evt, () => { lastInteraction = Date.now(); }, { passive: true });
  }

  // country search bar: flying to a country counts as interaction so the
  // auto-rotate doesn't immediately swing the camera away again
  const search = new CountrySearch(viewer, truesize, () => { lastInteraction = Date.now(); });

  scene.preUpdate.addEventListener(() => {
    const now = Date.now();
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.25) : 0;
    lastFrame = now;

    sats.tick(now);
    flights.tick(now);
    ships.tick(now);
    moon.tick();

    const height = viewer.camera.positionCartographic.height;
    osmLayer.alpha = Cesium.Math.clamp((FADE_START - height) / (FADE_START - FADE_END), 0, 1);

    // keep the street map readable at night: drop sun lighting once the
    // camera is in map territory (or while a heat-map overlay is shown,
    // so the overlay isn't dimmed on the night side)
    syncDayNight();

    if (
      rotateEnabled && dt > 0 &&
      now - lastInteraction > AUTOROTATE_IDLE_MS &&
      !wiki.isOpen()
    ) {
      if (moon.tracking) {
        // orbit the moon inside its look-at frame
        viewer.camera.rotateLeft(-AUTOROTATE_RATE * dt);
      } else if (!moon.focused && height > AUTOROTATE_MIN_HEIGHT) {
        viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -AUTOROTATE_RATE * dt);
      }
    }
  });

  // --- hover tooltips & route-on-hover ----------------------------------------
  const tooltip = document.getElementById("tooltip");
  let hovered = null;
  let lastMove = 0;

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

  handler.setInputAction((movement) => {
    const now = performance.now();
    if (now - lastMove < 30) return;
    lastMove = now;

    const picked = scene.pick(movement.endPosition);
    const id = picked?.id?.kind ? picked.id : null;

    if (id !== hovered) {
      const prev = hovered;
      hovered = id;
      if (prev?.kind === "flight") flights.clearHoverRoute();
      if (hovered?.kind === "flight") flights.showRouteFor(hovered.flight, false);
    }

    let html = null;
    let earthHover = false;
    if (hovered) {
      html = tooltipHtml(hovered);
    } else if (moon.focused) {
      // from the moon, the Earth in the sky is the way home
      earthHover = !!viewer.camera.pickEllipsoid(movement.endPosition, scene.globe.ellipsoid);
      if (earthHover) {
        html = `<div class="tt-title">Earth</div>
          <div class="tt-note">click to return</div>`;
      }
    } else if (heat.visible) {
      // nothing under the cursor: read the heat-map overlay instead
      const cart = viewer.camera.pickEllipsoid(movement.endPosition, scene.globe.ellipsoid);
      if (cart) {
        const c = Cesium.Cartographic.fromCartesian(cart);
        const v = heat.valueAt(
          Cesium.Math.toDegrees(c.latitude),
          Cesium.Math.toDegrees(c.longitude)
        );
        if (v) html = tooltipHtml({ kind: "heat", sample: v });
      }
    }

    if (html) {
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const x = movement.endPosition.x;
      const y = movement.endPosition.y;
      tooltip.style.left = `${Math.min(x + 16, window.innerWidth - 280)}px`;
      tooltip.style.top = `${Math.min(y + 14, window.innerHeight - 110)}px`;
    } else {
      tooltip.hidden = true;
    }
    viewer.canvas.style.cursor =
      hovered?.kind === "truesize"
        ? (hovered.ts.dragging ? "grabbing" : "grab")
        : hovered || earthHover ? "pointer" : "default";
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((click) => {
    const picked = scene.pick(click.position);
    const id = picked?.id?.kind ? picked.id : null;

    if (id?.kind === "sat") {
      sats.select(id.sat);
      return;
    }
    if (id?.kind === "flight") {
      flights.showRouteFor(id.flight, true);
      return;
    }
    if (id?.kind === "vessel") return; // details are in the hover tooltip
    if (id?.kind === "truesize") return; // drag / right-click handled by the layer
    if (id?.kind === "wiki") {
      wiki.focusArticle(id.article); // highlight the matching result row
      return;
    }
    if (id?.kind === "moonwiki") {
      // an article dot on the moon: fly there (if not already) and open it
      moon.focus();
      moon.openArticle(id.article, wiki);
      return;
    }
    if (id?.kind === "moon") {
      if (!moon.focused) {
        moon.focus();
      } else if (moon.wikiEnabled) {
        const c = moon.pickMoon(click.position);
        if (c) moon.openArticlesAt(c.lat, c.lon, wiki);
      }
      return;
    }
    // from the moon, clicking Earth flies home — the mirror of clicking the
    // moon from Earth; anything else in the lunar sky is a no-op
    if (moon.focused) {
      const cart = viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
      if (cart) moon.blur();
      return;
    }

    // empty globe (or a lane — lanes blanket the oceans): open the wiki panel
    sats.select(null);
    flights.deselect();
    const cart = viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
    if (cart) {
      const c = Cesium.Cartographic.fromCartesian(cart);
      const lat = Cesium.Math.toDegrees(c.latitude);
      const lon = Cesium.Math.toDegrees(c.longitude);
      // size-compare mode: clicking a country copies it instead of opening wiki
      if (truesize.enabled && truesize.tryAdd(lat, lon)) return;
      // conflict heat-map: clicking a zone leads the article list with
      // conflict-related Wikipedia pages for that cell's parties
      const conflictZone =
        heat.visible && METRICS[heat.mode]?.kind === "conflict"
          ? heat.conflictAt(lat, lon)
          : null;
      wiki.open(lat, lon, { conflict: conflictZone });
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // --- control panel wiring -----------------------------------------------------
  const bind = (idStr, fn) => document.getElementById(idStr).addEventListener("change", (e) => fn(e.target.checked));
  const layerToggles = {
    sats: document.getElementById("chk-sats"),
    flights: document.getElementById("chk-flights"),
    ships: document.getElementById("chk-ships"),
  };
  const autoHideSources = new Set(["limited", "blocked"]);
  const liveLimitedAutoHidden = new Set();
  const hideIfLiveLimited = (key, status, setVisible) => {
    if (!autoHideSources.has(status.source)) {
      liveLimitedAutoHidden.delete(key);
      return;
    }
    if (liveLimitedAutoHidden.has(key)) return;
    liveLimitedAutoHidden.add(key);
    if (!layerToggles[key]?.checked) return;
    layerToggles[key].checked = false;
    setVisible(false);
    return true;
  };
  bind("chk-sats", (v) => sats.setVisible(v));
  bind("chk-sat-paths", (v) => sats.setPathsVisible(v));
  bind("chk-flights", (v) => flights.setVisible(v));
  bind("chk-flight-routes", (v) => flights.setRoutesVisible(v));
  bind("chk-ships", (v) => ships.setVisible(v));
  bind("chk-vessel-routes", (v) => ships.setRoutesVisible(v));
  // heat-map mode dropdown: weather modes show the resolution/timeline rows,
  // country modes only the legend
  const selHeat = document.getElementById("sel-heatmap");
  enhanceHeatmapSelect(selHeat);
  const wbControls = document.getElementById("wb-controls");
  const wbWeatherRows = document.getElementById("wb-weather-rows");
  const wbBar = wbControls.querySelector(".wb-bar");
  const wbTicks = wbControls.querySelector(".wb-ticks");
  selHeat.addEventListener("change", () => {
    const mode = selHeat.value || null;
    heat.setMode(mode);
    wbControls.hidden = !mode;
    if (mode) {
      wbWeatherRows.hidden = METRICS[mode].kind !== "weather";
      const legend = METRICS[mode].legend;
      wbBar.style.background = `linear-gradient(to right, ${legend
        .map(([, c], i) => `${c} ${Math.round((i / (legend.length - 1)) * 100)}%`)
        .join(", ")})`;
      wbTicks.innerHTML = legend.map(([l]) => `<span>${esc(l)}</span>`).join("");
    }
  });

  // heat-map resolution slider (weather modes)
  const wbRes = document.getElementById("wb-res");
  const wbResLabel = document.getElementById("wb-res-label");
  wbRes.addEventListener("input", () => {
    const step = RES_STEPS[Number(wbRes.value)];
    wbResLabel.textContent = `${step}°`;
    heat.setResolution(step);
  });

  // Day + hour sliders address heat.times, which is hourly UTC data
  // starting at midnight of the oldest fetched day: index = day * 24 + hour.
  const wbDay = document.getElementById("wb-day");
  const wbHour = document.getElementById("wb-hour");
  const wbDayLabel = document.getElementById("wb-day-label");
  const wbHourLabel = document.getElementById("wb-hour-label");
  const wbWhenVal = document.getElementById("wb-when-val");
  const WB_WHEN_FMT = new Intl.DateTimeFormat("en", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
  const WB_DAY_FMT = new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", timeZone: "UTC",
  });

  function wbSyncTimeUI() {
    const n = heat.times.length;
    if (n === 0) return;
    const idx = heat.timeIdx;
    const lastDay = Math.floor((n - 1) / 24);
    const day = Math.floor(idx / 24);
    wbDay.max = lastDay;
    wbDay.value = day;
    wbHour.max = day === lastDay ? (n - 1) - lastDay * 24 : 23; // today ends at the current hour
    wbHour.value = idx % 24;
    const d = new Date(heat.times[idx]);
    const hh = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
    wbDayLabel.textContent = day === lastDay ? "today" : WB_DAY_FMT.format(d);
    wbHourLabel.textContent = hh;
    wbWhenVal.textContent =
      `${WB_WHEN_FMT.format(d)} · ${hh} UTC${idx === n - 1 ? " (now)" : ""}`;
  }

  function wbApplyTimeUI() {
    const n = heat.times.length;
    if (n === 0) return;
    const idx = Math.min(Number(wbDay.value) * 24 + Number(wbHour.value), n - 1);
    heat.setTimeIndex(idx);
    wbSyncTimeUI();
  }

  wbDay.addEventListener("input", wbApplyTimeUI);
  wbHour.addEventListener("input", wbApplyTimeUI);
  heat.onDataChanged = wbSyncTimeUI;

  // true-size compare: checkbox enables click-to-copy; the help row shows
  // while the mode is on or overlays exist
  bind("chk-truesize", (v) => truesize.setEnabled(v));
  const tsHelp = document.getElementById("ts-help");
  const tsCount = document.getElementById("count-truesize");
  document.getElementById("ts-clear").addEventListener("click", (e) => {
    e.preventDefault();
    truesize.clear();
  });
  truesize.onChanged = () => {
    tsCount.textContent = truesize.items.length;
    tsHelp.hidden = !(truesize.enabled || truesize.items.length > 0);
  };

  bind("chk-moon", (v) => moon.setVisible(v));
  bind("chk-moon-wiki", (v) => {
    moon.setWikiEnabled(v);
    if (!v && wiki.moonMode) wiki.close();
  });
  bind("chk-moon-daynight", (v) => moon.setDayNight(v));

  bind("chk-rotate", (v) => { rotateEnabled = v; });
  bind("chk-daynight", (v) => {
    dayNightEnabled = v;
    syncDayNight();
  });

  // optional aisstream.io key for global live ship coverage
  document.getElementById("ais-key-link").addEventListener("click", (e) => {
    e.preventDefault();
    const key = prompt(
      "aisstream.io API key for global live ship tracking\n" +
      "(free at aisstream.io — leave blank for regional/demo data):",
      getAisKey() ?? ""
    );
    if (key === null) return;
    setAisKey(key.trim());
    location.reload();
  });

  // --- status indicators ----------------------------------------------------------
  const badgeEls = {
    sats: document.getElementById("badge-sats"),
    flights: document.getElementById("badge-flights"),
    ships: document.getElementById("badge-ships"),
    heat: document.getElementById("badge-heat"),
    moon: document.getElementById("badge-moon"),
  };
  const countEls = {
    sats: document.getElementById("count-sats"),
    flights: document.getElementById("count-flights"),
    ships: document.getElementById("count-ships"),
    heat: document.getElementById("count-heat"),
    moon: document.getElementById("count-moon"),
  };

  function setBadge(el, source) {
    const map = {
      live: ["LIVE", "live"],
      demo: ["DEMO", "demo"],
      static: ["ROUTES", "static"],
      loading: ["…", "loading"],
      limited: ["LIMIT", "demo"],   // API quota hit, backing off
      blocked: ["CORS", "demo"],    // browser origin cannot read the feed
      cache: ["CACHED", "static"],  // serving the last good dataset
      data: ["DATA", "static"],     // bundled statistics, not a live feed
      idle: ["—", "static"],        // loads on first visit (moon articles)
    };
    const [label, cls] = map[source] ?? map.loading;
    el.textContent = label;
    el.className = `badge ${cls}`;
  }

  setInterval(() => {
    let sc = sats.counts();
    if (hideIfLiveLimited("sats", sc, (v) => sats.setVisible(v))) sc = sats.counts();
    setBadge(badgeEls.sats, sc.source);
    countEls.sats.textContent = sc.count;

    let fc = flights.counts();
    if (hideIfLiveLimited("flights", fc, (v) => flights.setVisible(v))) fc = flights.counts();
    setBadge(badgeEls.flights, fc.source);
    badgeEls.flights.title = fc.detail ?? "";
    countEls.flights.textContent = fc.count;

    let shc = ships.counts();
    if (hideIfLiveLimited("ships", shc, (v) => ships.setVisible(v))) shc = ships.counts();
    setBadge(badgeEls.ships, shc.source);
    badgeEls.ships.title = shc.detail ?? "";
    countEls.ships.textContent = shc.count;
    countEls.ships.title = shc.detail;

    const hc = heat.counts();
    setBadge(badgeEls.heat, hc.source);
    countEls.heat.textContent = hc.count;
    countEls.heat.title = hc.detail;

    const mc = moon.counts();
    setBadge(badgeEls.moon, mc.source);
    countEls.moon.textContent = mc.count;
  }, 1000);

  // fade the onboarding hint after a while
  setTimeout(() => document.getElementById("hint").classList.add("faded"), 15000);

  // handy for debugging from the console
  window.__globe = { viewer, sats, flights, ships, heat, wiki, truesize, search, moon };
}

function enhanceHeatmapSelect(select) {
  if (!select || select.dataset.enhanced === "true") return;
  select.dataset.enhanced = "true";
  select.classList.add("is-enhanced");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const entries = [];
  for (const child of select.children) {
    if (child.tagName === "OPTION") {
      entries.push({
        value: child.value,
        label: child.textContent,
        group: "",
        keywords: `${child.textContent} ${child.value}`.toLowerCase(),
      });
    } else if (child.tagName === "OPTGROUP") {
      for (const option of child.children) {
        entries.push({
          value: option.value,
          label: option.textContent,
          group: child.label,
          keywords: `${option.textContent} ${option.value} ${child.label}`.toLowerCase(),
        });
      }
    }
  }

  const combo = document.createElement("div");
  combo.className = "heat-combo";

  const button = document.createElement("button");
  button.className = "heat-combo-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const valueText = document.createElement("span");
  valueText.className = "heat-combo-value";
  const chevron = document.createElement("span");
  chevron.className = "heat-combo-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";
  button.append(valueText, chevron);

  const menu = document.createElement("div");
  menu.className = "heat-combo-menu";
  menu.hidden = true;

  const search = document.createElement("input");
  search.className = "heat-combo-search";
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = "Search overlays...";
  search.setAttribute("aria-label", "Search data overlays");

  const list = document.createElement("div");
  list.className = "heat-combo-list";
  list.setAttribute("role", "listbox");
  menu.append(search, list);
  combo.append(button, menu);
  select.after(combo);

  let optionButtons = [];
  let active = -1;

  function syncLabel() {
    valueText.textContent =
      select.selectedOptions[0]?.textContent ??
      entries.find((entry) => entry.value === select.value)?.label ??
      "None";
  }

  function setActive(idx) {
    if (optionButtons.length === 0) {
      active = -1;
      return;
    }
    active = (idx + optionButtons.length) % optionButtons.length;
    optionButtons.forEach((el, i) => {
      const isActive = i === active;
      el.classList.toggle("active", isActive);
      el.tabIndex = isActive ? 0 : -1;
      if (isActive) el.scrollIntoView({ block: "nearest" });
    });
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const grouped = new Map();
    for (const entry of entries) {
      if (q && !entry.keywords.includes(q)) continue;
      if (!grouped.has(entry.group)) grouped.set(entry.group, []);
      grouped.get(entry.group).push(entry);
    }

    list.textContent = "";
    optionButtons = [];
    for (const [group, matches] of grouped) {
      if (group) {
        const header = document.createElement("div");
        header.className = "heat-combo-group";
        header.textContent = group;
        list.appendChild(header);
      }
      for (const entry of matches) {
        const option = document.createElement("button");
        option.className = "heat-combo-option";
        option.type = "button";
        option.setAttribute("role", "option");
        option.dataset.value = entry.value;
        option.setAttribute("aria-selected", String(entry.value === select.value));
        option.textContent = entry.label;
        option.addEventListener("pointerdown", (e) => e.preventDefault());
        option.addEventListener("click", () => choose(entry.value));
        list.appendChild(option);
        optionButtons.push(option);
      }
    }

    if (optionButtons.length === 0) {
      const empty = document.createElement("div");
      empty.className = "heat-combo-empty";
      empty.textContent = "No matching overlay";
      list.appendChild(empty);
      active = -1;
      return;
    }

    const selectedIdx = optionButtons.findIndex((el) => el.dataset.value === select.value);
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
  }

  function openMenu() {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    search.value = "";
    render();
    requestAnimationFrame(() => search.focus());
  }

  function closeMenu(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
  }

  function choose(value) {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncLabel();
    closeMenu(true);
  }

  button.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  button.addEventListener("keydown", (e) => {
    if (["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openMenu();
    }
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(optionButtons.length - 1);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      optionButtons[active].click();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!combo.contains(e.target)) closeMenu();
  });
  for (const label of select.labels ?? []) {
    label.addEventListener("click", (e) => {
      e.preventDefault();
      openMenu();
    });
  }
  select.addEventListener("change", syncLabel);
  syncLabel();
}

function tooltipHtml(id) {
  if (id.kind === "sat") {
    const s = id.sat;
    return `<div class="tt-title">${esc(s.name)}</div>
      <div class="tt-line">Altitude ${s.altKm != null ? Math.round(s.altKm).toLocaleString() : "—"} km</div>
      <div class="tt-note">${s.demo ? "Demo orbit" : "Live TLE · SGP4 propagation"} · click for orbit path</div>`;
  }
  if (id.kind === "flight") {
    const f = id.flight;
    const speed = f.live ? Math.round(f.velMs * 3.6) : f.speedKmh;
    const route = f.live
      ? (f.routeLabel ? esc(f.routeLabel) : esc(f.country ?? ""))
      : `${esc(f.from.c)} ${esc(f.from.name)} → ${esc(f.to.c)} ${esc(f.to.name)}`;
    return `<div class="tt-title">${esc(f.callsign)}</div>
      <div class="tt-line">Alt ${(Math.max(f.altM, 0) / 1000).toFixed(1)} km · ${speed} km/h</div>
      <div class="tt-note">${route}${f.live ? "" : " · demo flight"}</div>`;
  }
  if (id.kind === "vessel") {
    const v = id.vessel;
    const name = v.name || `MMSI ${v.mmsi}`;
    const speed = v.sogKn != null ? `${v.sogKn.toFixed(1)} kn` : "— kn";
    const hdg = v.headingDeg != null ? `${Math.round(v.headingDeg)}°` : "—";
    return `<div class="tt-title">${esc(name)}</div>
      <div class="tt-line">${esc(v.typeName || "Vessel")}${v.flag ? " · " + esc(v.flag) : ""}</div>
      <div class="tt-line">${speed} · heading ${hdg}${v.destination ? " · → " + esc(v.destination) : ""}</div>
      <div class="tt-note">${v.live ? "live AIS" : "simulated vessel"}</div>`;
  }
  if (id.kind === "heat") {
    const s = id.sample;
    const m = METRICS[s.metric];
    if (s.kind === "region") {
      const popYr = s.popYear && s.popYear !== s.year ? ` (${s.popYear})` : "";
      const pop = s.population != null
        ? `${s.population.toLocaleString("en-US")} people${popYr}`
        : null;
      const area = s.areaKm2 != null ? `${Math.round(s.areaKm2).toLocaleString("en-US")} km²` : null;
      return `<div class="tt-title">${esc(s.name)}${s.country ? ` · ${esc(s.country)}` : ""}</div>
        <div class="tt-line">${esc(m.label)}: ${esc(m.fmt(s.value))}${s.year ? ` (${s.year})` : ""}</div>
        <div class="tt-note">${esc([pop, area, s.source].filter(Boolean).join(" · "))}</div>`;
    }
    if (s.kind === "conflict") {
      const period = s.period ? `${s.period.start} → ${s.period.end}` : "trailing 12 months";
      return `<div class="tt-title">${esc(s.country ?? "Conflict zone")}</div>
        <div class="tt-line">${esc(m.fmt(s.value))} deaths · ${s.events} event${s.events === 1 ? "" : "s"} in this area</div>
        <div class="tt-note">${esc(s.dyad ?? "")} · ${esc(period)} · ${esc(s.source)} · click for related articles</div>`;
    }
    if (s.kind === "skyscraper") {
      const place = [s.city, s.country].filter(Boolean).join(" - ") || "Skyscraper city cell";
      const rank = s.rank
        ? `Top city rank: #${s.rank}`
        : "Supplemental Wikidata Q11303 city minimum";
      return `<div class="tt-title">${esc(place)}</div>
        <div class="tt-line">${s.count.toLocaleString("en-US")} skyscraper${s.count === 1 ? "" : "s"} - ${esc(m.fmt(s.value))}</div>
        <div class="tt-note">${esc(rank)} - >=${s.minHeightM} m - ${esc(s.source)}</div>`;
    }
    if (s.kind === "country") {
      const source = [s.stat?.source, s.stat?.year].filter(Boolean).join(" ");
      return `<div class="tt-title">${esc(s.name)}</div>
        <div class="tt-line">${esc(m.label)}: ${s.value != null ? esc(m.fmt(s.value)) : "no data"}</div>
        <div class="tt-note">${esc(source || "Country statistics")}</div>`;
    }
    const others = {
      wetbulb: `Air ${s.t.toFixed(1)} °C · humidity ${Math.round(s.rh)}%`,
      temp: `Wet-bulb ${s.tw.toFixed(1)} °C · humidity ${Math.round(s.rh)}%`,
      humidity: `Air ${s.t.toFixed(1)} °C · wet-bulb ${s.tw.toFixed(1)} °C`,
    }[s.metric];
    const stress = s.metric === "wetbulb" ? `${esc(heatStressLabel(s.tw))} · ` : "";
    return `<div class="tt-title">${esc(m.label)} ${esc(m.fmt(m.value(s)))}</div>
      <div class="tt-line">${others}</div>
      <div class="tt-note">${stress}${esc(s.when ?? "now")} · Open-Meteo</div>`;
  }
  if (id.kind === "truesize") {
    const c = id.ts;
    const guide = c.dragging
      ? `<span class="tt-key">scroll</span> rotate &nbsp;·&nbsp; release to drop`
      : `<span class="tt-key">drag</span> move &nbsp;
         <span class="tt-key">⇧ shift</span><span class="tt-plus">+</span><span class="tt-key">scroll</span> rotate &nbsp;
         <span class="tt-key">right-click</span> remove`;
    return `<div class="tt-title">${esc(c.name)}</div>
      <div class="tt-line">${esc(c.areaLabel)} · true-size outline</div>
      <div class="tt-guide">${guide}</div>`;
  }
  if (id.kind === "lane") {
    const tier = id.lane.type === "middle" ? "Secondary" : "Major";
    return `<div class="tt-title">${esc(id.lane.name)}</div>
      <div class="tt-note">${tier} shipping corridor · ${Math.round(id.lane.lengthKm).toLocaleString()} km</div>`;
  }
  if (id.kind === "moon") {
    const distKm = id.moon.distanceKm();
    return `<div class="tt-title">The Moon</div>
      <div class="tt-line">${Math.round(distKm).toLocaleString()} km from Earth right now</div>
      <div class="tt-note">Simon 1994 ephemeris · NASA LRO imagery · click to visit</div>`;
  }
  if (id.kind === "moonwiki") {
    const a = id.article;
    const lat = `${Math.abs(a.lat).toFixed(1)}° ${a.lat >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(a.lon).toFixed(1)}° ${a.lon >= 0 ? "E" : "W"}`;
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${lat}, ${lon} · the Moon</div>
      <div class="tt-note">Wikipedia · click to open in the panel</div>`;
  }
  if (id.kind === "wiki") {
    const a = id.article;
    const dist = a.distKm != null
      ? (a.distKm < 1 ? `${Math.round(a.distKm * 1000)} m` : `${a.distKm.toFixed(a.distKm < 20 ? 1 : 0)} km`) + " away"
      : (a.badge ?? "Wikipedia");
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${esc(dist)}</div>
      <div class="tt-note">Wikipedia · click to open in the panel</div>`;
  }
  return "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot().catch((e) => {
  const el = document.getElementById("error");
  el.hidden = false;
  el.textContent = `Could not start the globe (${e.message}). WebGL is required.`;
  console.error(e);
});
