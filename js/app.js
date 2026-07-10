// Wiki Globe — entry point.
// Night-texture globe with three movement layers (satellites / flights /
// shipping), an OSM detail crossfade on zoom, and a click-to-Wikipedia panel.

import { SatelliteLayer } from "./layers/satellites.js";
import { FlightLayer } from "./layers/flights.js";
import { ShippingLayer } from "./layers/shipping.js";
import { EarthquakesLayer } from "./layers/earthquakes.js";
import { EventsLayer } from "./layers/events.js";
import { LaunchesLayer, formatCountdown } from "./layers/launches.js";
import { CablesLayer } from "./layers/cables.js";
import { PowerPlantsLayer } from "./layers/power-plants.js";
import { TimeZonesLayer } from "./layers/timezones.js";
import { HeatmapLayer, METRICS, heatStressLabel, RES_STEPS, loadHeatmapMetrics } from "./layers/heatmap.js";
import { TrueSizeLayer } from "./layers/truesize.js";
import { BODY_CHOICE_GROUPS } from "./bodies.js";
import { MoonLayer } from "./layers/moon.js";
import { MarsLayer } from "./layers/mars.js";
import { SunLayer } from "./layers/sun.js";
import { PlanetLayer, PLANET_BODY_KEYS } from "./layers/planets.js";
import { ChildMoonLayer, CHILD_MOON_BODY_KEYS } from "./layers/moons.js";
import { CountrySearch } from "./search.js";
import { WikiPanel } from "./wiki-panel.js";
import { AgentChatPanel } from "./agent/chat-panel.js";
import { getAisKey, setAisKey } from "./ais.js";

// OSM tiles fade in below FADE_START camera height and are fully opaque by FADE_END.
const FADE_START = 2.6e6;
const FADE_END = 5.5e5;
const AUTOROTATE_RATE = 0.006;        // rad/s
const AUTOROTATE_IDLE_MS = 8000;
const AUTOROTATE_MIN_HEIGHT = 1.2e6;  // stop spinning once zoomed into the map
const EARTH_DEPART_DURATION = 1.2;      // seconds; camera pull-back before an Earth-origin proxy transition
const EARTH_DEPART_HEIGHT_FACTOR = 1.5; // multiple of the target's proxyDistance to clear it before the proxy appears
const COMPACT_SIDE_MENU_QUERY = "(max-width: 1199px)";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "wikiglobe.agent.panelWidth";
const RIGHT_PANEL_DEFAULT_WIDTH = 392;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 760;
const RIGHT_PANEL_VIEWPORT_MARGIN = 46;
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
  scene.camera.frustum.far = 1e13;
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
  const quakes = new EarthquakesLayer(viewer);
  const events = new EventsLayer(viewer);
  const launches = new LaunchesLayer(viewer);
  const cables = new CablesLayer(viewer);
  const plants = new PowerPlantsLayer(viewer);
  const timezones = new TimeZonesLayer(viewer);
  const heat = new HeatmapLayer(viewer); // lazy: fetches when a mode is selected
  const truesize = new TrueSizeLayer(viewer);
  const sun = new SunLayer(viewer);
  const moon = new MoonLayer(viewer);
  const mars = new MarsLayer(viewer);
  const planets = Object.fromEntries(
    PLANET_BODY_KEYS.map((key) => [key, new PlanetLayer(viewer, key)])
  );
  const childMoons = Object.fromEntries(
    CHILD_MOON_BODY_KEYS.map((key) => [key, new ChildMoonLayer(viewer, key)])
  );
  const wiki = new WikiPanel(viewer);
  setupResponsiveSideMenus();

  const layerToggles = {
    sats: document.getElementById("chk-sats"),
    flights: document.getElementById("chk-flights"),
    ships: document.getElementById("chk-ships"),
    quakes: document.getElementById("chk-quakes"),
    events: document.getElementById("chk-events"),
    launches: document.getElementById("chk-launches"),
    cables: document.getElementById("chk-cables"),
    plants: document.getElementById("chk-plants"),
    timezones: document.getElementById("chk-timezones"),
  };
  sats.setVisible(layerToggles.sats.checked);
  flights.setVisible(layerToggles.flights.checked);
  ships.setVisible(layerToggles.ships.checked);
  quakes.setVisible(layerToggles.quakes.checked);
  events.setVisible(layerToggles.events.checked);
  launches.setVisible(layerToggles.launches.checked);
  cables.setVisible(layerToggles.cables.checked);
  plants.setVisible(layerToggles.plants.checked);
  timezones.setVisible(layerToggles.timezones.checked);

  ships.init();
  sats.init();
  flights.init();
  quakes.init();
  events.init();
  launches.init();
  cables.init();
  plants.init();
  timezones.init();
  sun.init();
  moon.init();
  mars.init();
  for (const layer of Object.values(planets)) layer.init();
  for (const layer of Object.values(childMoons)) layer.init();

  // "Back to Earth" appears while the camera is parked off Earth.
  const moonBack = document.getElementById("moon-back");
  moonBack.textContent = "< Back to Earth";

  const bodyLayers = { sun, ...planets, ...childMoons, moon, mars };
  const planetUi = {
    name: document.getElementById("name-planet"),
    dot: document.getElementById("dot-planet"),
    wiki: document.getElementById("chk-planet-wiki"),
    wikiRow: document.getElementById("chk-planet-wiki").closest("label"),
    categoryRow: document.querySelector("label[for='sel-planet-category']"),
    category: document.getElementById("sel-planet-category"),
    badge: document.getElementById("badge-planet"),
    count: document.getElementById("count-planet"),
  };
  let focusedBody = "earth";
  let pendingFocusBody = null;
  let departingTarget = null;

  function currentBodyLayer() {
    return bodyLayers[focusedBody] ?? null;
  }

  function syncPlanetControls(body) {
    const layer = bodyLayers[body];
    if (!layer) return;
    planetUi.name.textContent = layer.name;
    const color = layer.config.skyDot?.color ?? layer.config.markerColor;
    planetUi.dot.style.background = color;
    planetUi.dot.style.boxShadow = `0 0 6px ${color}`;
    const hasWiki = layer.config.wikiEnabled !== false;
    planetUi.wikiRow.hidden = !hasWiki;
    planetUi.categoryRow.hidden = !hasWiki;
    planetUi.category.hidden = !hasWiki;
    planetUi.badge.hidden = !hasWiki;
    planetUi.count.hidden = !hasWiki;
    if (!hasWiki) return;
    planetUi.wiki.checked = layer.wikiEnabled;
    planetUi.category.value = layer.category;
    const counts = layer.counts();
    setBadge(planetUi.badge, counts.source);
    planetUi.count.textContent = counts.count;
  }

  function syncScopedUi(body) {
    document.body.dataset.focus = body;
    for (const el of document.querySelectorAll("[data-scope]")) {
      const scopes = el.dataset.scope.split(/\s+/).filter(Boolean);
      el.hidden = !scopes.includes(body);
    }
  }

  function syncChildSky(body) {
    const focusedLayer = bodyLayers[body];
    for (const layer of Object.values(bodyLayers)) {
      const isParentOfFocused = focusedLayer?.config.parentBody === layer.key;
      const isChildOfFocused = layer.config.parentBody === body;
      const isSiblingOfFocused =
        focusedLayer?.config.parentBody &&
        layer.config.parentBody === focusedLayer.config.parentBody &&
        layer.key !== body;
      const isContextBody = isParentOfFocused || isChildOfFocused || isSiblingOfFocused;
      layer.setContextVisible?.(isContextBody);
      if (!layer.config.parentBody) {
        layer.setSkyVisible?.(!isContextBody);
        continue;
      }
      const sameSystem =
        body === layer.config.parentBody ||
        body === layer.key ||
        focusedLayer?.config.parentBody === layer.config.parentBody;
      layer.setSkyVisible(sameSystem && !isContextBody);
    }
  }

  function syncBodyControls(body) {
    moonBack.hidden = body === "earth";
    selBody.value = body;
    syncScopedUi(body);
    syncChildSky(body);
    syncPlanetControls(body);
    wiki.close();
    for (const [key, layer] of Object.entries(bodyLayers)) {
      layer.setArticlesVisible(key === body);
    }
  }

  function focusBody(body) {
    if (body === focusedBody && !departingTarget) return;
    if (body !== "earth" && !bodyLayers[body]) {
      selBody.value = focusedBody;
      return;
    }
    const current = currentBodyLayer();
    if (body === "earth") {
      pendingFocusBody = "earth";
      if (departingTarget) {
        departingTarget = null;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(10, 22, 2.3e7),
          duration: 1.5,
        });
      }
      current?.blur();
      if (!current) {
        focusedBody = "earth";
        syncBodyControls("earth");
      }
      pendingFocusBody = null;
      return;
    }
    const target = bodyLayers[body];
    const directLocalHop = isLocalBodyHop(focusedBody, body);
    pendingFocusBody = body;
    if (current) {
      current.blur({ flyHome: false });
      target.focus({ direct: directLocalHop });
    } else {
      departEarth(target);
    }
    pendingFocusBody = null;
  }

  function isLocalBodyHop(fromBody, toBody) {
    const from = bodyLayers[fromBody];
    const to = bodyLayers[toBody];
    if (!from || !to) return false;
    // Bodies that need a proxy transition are themselves at true
    // interplanetary distance from Earth (e.g. Jupiter and its moons), so a
    // parent/sibling hop between them is not actually "local" — a real
    // camera flyTo across that absolute distance breaks Cesium's flight-arc
    // math even though the hop distance itself is small. Route those through
    // the normal proxy transition instead of a direct flight.
    if (from.config.transition?.proxy || to.config.transition?.proxy) return false;
    return (
      to.config.parentBody === fromBody ||
      from.config.parentBody === toBody ||
      (to.config.parentBody && to.config.parentBody === from.config.parentBody)
    );
  }

  // Leaving Earth for a proxy-based transition: pull the camera back from the
  // globe first so the incoming body's proxy (anchored near Earth's center)
  // spawns well clear of the camera, instead of popping in right next to it —
  // matching what already happens naturally when switching between two
  // off-Earth bodies (the camera is already far from Earth in that case).
  function departEarth(target) {
    departingTarget = target;
    const departHeight =
      (target.config.transition?.proxyDistance ?? 4.5e7) * EARTH_DEPART_HEIGHT_FACTOR;
    const carto = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, departHeight),
      duration: EARTH_DEPART_DURATION,
      complete: () => {
        if (departingTarget !== target) return;
        departingTarget = null;
        target.focus();
      },
    });
  }

  function returnEarth() {
    focusBody("earth");
  }

  moonBack.addEventListener("click", returnEarth);

  // body switcher next to the search bar; stays in sync with click-driven
  // focus changes so it always names the world under the camera
  const selBody = document.getElementById("sel-body");
  selBody.replaceChildren(...BODY_CHOICE_GROUPS.map(({ label, choices }) => {
    const group = document.createElement("optgroup");
    group.label = label;
    group.append(...choices.map(({ key, label: choiceLabel }) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = choiceLabel;
      option.selected = key === "earth";
      return option;
    }));
    return group;
  }));
  selBody.addEventListener("change", () => focusBody(selBody.value));
  syncScopedUi("earth");
  syncChildSky("earth");

  // Focus scoping: only the body under the camera keeps its overlays. Earth
  // layers are parked (checkboxes untouched) while another body has focus, and
  // body article markers exist only in their own focus context.
  // References layer toggles declared later in boot; runs only on user input.
  let heatModeSuspended = null;
  function onBodyFocusChanged(body, focused) {
    if (focused) {
      const wasEarth = focusedBody === "earth";
      focusedBody = body;
      syncBodyControls(body);
      if (wasEarth) {
        sats.setVisible(false);
        flights.setVisible(false);
        ships.setVisible(false);
        quakes.setVisible(false);
        events.setVisible(false);
        launches.setVisible(false);
        cables.setVisible(false);
        plants.setVisible(false);
        timezones.setVisible(false);
        if (heatModeSuspended == null) heatModeSuspended = heat.mode;
        if (heatModeSuspended) heat.setMode(null);
      }
      return;
    }

    if (pendingFocusBody && pendingFocusBody !== "earth") return;
    if (focusedBody === body) focusedBody = "earth";
    const active = currentBodyLayer();
    if (active) return;

    syncBodyControls("earth");
    sats.setVisible(layerToggles.sats.checked);
    flights.setVisible(layerToggles.flights.checked);
    ships.setVisible(layerToggles.ships.checked);
    quakes.setVisible(layerToggles.quakes.checked);
    events.setVisible(layerToggles.events.checked);
    launches.setVisible(layerToggles.launches.checked);
    cables.setVisible(layerToggles.cables.checked);
    plants.setVisible(layerToggles.plants.checked);
    timezones.setVisible(layerToggles.timezones.checked);
    if (heatModeSuspended) heat.setMode(heatModeSuspended);
    heatModeSuspended = null;
  }
  for (const [key, layer] of Object.entries(bodyLayers)) {
    layer.onFocusChanged = (focused) => onBodyFocusChanged(key, focused);
  }
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
  const agent = new AgentChatPanel(viewer);

  scene.preUpdate.addEventListener(() => {
    const now = Date.now();
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.25) : 0;
    lastFrame = now;

    sats.tick(now);
    flights.tick(now);
    ships.tick(now);
    quakes.tick(now);
    events.tick(now);
    launches.tick(now);
    for (const layer of Object.values(bodyLayers)) layer.tick();

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
      const activeBody = currentBodyLayer();
      if (activeBody?.tracking) {
        // orbit the focused body inside its look-at frame
        viewer.camera.rotateLeft(-AUTOROTATE_RATE * dt);
      } else if (!activeBody && height > AUTOROTATE_MIN_HEIGHT) {
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
    } else if (focusedBody !== "earth") {
      // from another body, the Earth in the sky is the way home
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
    if (id?.kind === "quake") {
      const q = id.quake;
      wiki.open(q.lat, q.lon);
      return;
    }
    if (id?.kind === "event") {
      const e = id.event;
      wiki.open(e.lat, e.lon);
      return;
    }
    if (id?.kind === "launch") {
      const l = id.launch;
      wiki.open(l.lat, l.lon);
      return;
    }
    if (id?.kind === "wiki") {
      wiki.focusArticle(id.article, { openPopup: true }); // highlight row + open article
      return;
    }
    if (id?.kind === "moonwiki") {
      // an article dot on the moon: fly there (if not already) and open it
      focusBody("moon");
      moon.openArticle(id.article, wiki, { openPopup: true });
      return;
    }
    if (id?.kind === "marswiki") {
      focusBody("mars");
      mars.openArticle(id.article, wiki, { openPopup: true });
      return;
    }
    if (id?.kind === "bodywiki") {
      const layer = id.layer ?? bodyLayers[id.body];
      if (!layer) return;
      focusBody(id.body);
      layer.openArticle(id.article, wiki, { openPopup: true });
      return;
    }
    if (id?.kind === "moon") {
      if (!moon.focused) {
        focusBody("moon");
      } else if (moon.wikiEnabled) {
        const c = moon.pickMoon(click.position);
        if (c) moon.openArticlesAt(c.lat, c.lon, wiki);
      }
      return;
    }
    if (id?.kind === "body") {
      const layer = bodyLayers[id.body];
      if (!layer) return;
      if (!layer.focused) {
        focusBody(id.body);
      } else if (layer.wikiEnabled) {
        const c = layer.pickSurface(click.position);
        if (c) layer.openArticlesAt(c.lat, c.lon, wiki);
      }
      return;
    }
    // from another body, clicking Earth flies home; anything else in that sky is a no-op
    if (focusedBody !== "earth") {
      const cart = viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
      if (cart) returnEarth();
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
  bind("chk-quakes", (v) => quakes.setVisible(v));
  bind("chk-events", (v) => events.setVisible(v));
  bind("chk-launches", (v) => launches.setVisible(v));
  bind("chk-cables", (v) => cables.setVisible(v));
  bind("chk-plants", (v) => plants.setVisible(v));
  bind("chk-timezones", (v) => timezones.setVisible(v));
  document.getElementById("sel-quake-feed").addEventListener("change", (e) => quakes.setFeed(e.target.value));
  document.querySelectorAll(".chk-event-cat").forEach((cb) => {
    cb.addEventListener("change", () => events.setCategory(cb.dataset.cat, cb.checked));
  });
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
  bind("chk-mars", (v) => mars.setVisible(v));
  bind("chk-mars-wiki", (v) => {
    mars.setWikiEnabled(v);
    if (!v && wiki.moonMode) wiki.close();
  });
  document.getElementById("sel-mars-category").addEventListener("change", (e) => {
    mars.setCategory(e.target.value);
    if (wiki.moonMode) wiki.close();
  });
  bind("chk-moon-wiki", (v) => {
    moon.setWikiEnabled(v);
    if (!v && wiki.moonMode) wiki.close();
  });
  document.getElementById("sel-moon-category").addEventListener("change", (e) => {
    moon.setCategory(e.target.value);
    if (wiki.moonMode) wiki.close();
  });
  bind("chk-planet-wiki", (v) => {
    const layer = bodyLayers[focusedBody];
    if (!layer) return;
    layer.setWikiEnabled(v);
    if (!v && wiki.moonMode) wiki.close();
  });
  document.getElementById("sel-planet-category").addEventListener("change", (e) => {
    const layer = bodyLayers[focusedBody];
    if (!layer) return;
    layer.setCategory(e.target.value);
    if (wiki.moonMode) wiki.close();
  });

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
    quakes: document.getElementById("badge-quakes"),
    events: document.getElementById("badge-events"),
    launches: document.getElementById("badge-launches"),
    cables: document.getElementById("badge-cables"),
    plants: document.getElementById("badge-plants"),
    timezones: document.getElementById("badge-timezones"),
    heat: document.getElementById("badge-heat"),
    moon: document.getElementById("badge-moon"),
    mars: document.getElementById("badge-mars"),
    planet: document.getElementById("badge-planet"),
  };
  const countEls = {
    sats: document.getElementById("count-sats"),
    flights: document.getElementById("count-flights"),
    ships: document.getElementById("count-ships"),
    quakes: document.getElementById("count-quakes"),
    events: document.getElementById("count-events"),
    launches: document.getElementById("count-launches"),
    cables: document.getElementById("count-cables"),
    plants: document.getElementById("count-plants"),
    timezones: document.getElementById("count-timezones"),
    heat: document.getElementById("count-heat"),
    moon: document.getElementById("count-moon"),
    mars: document.getElementById("count-mars"),
    planet: document.getElementById("count-planet"),
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

    const qc = quakes.counts();
    setBadge(badgeEls.quakes, qc.source);
    badgeEls.quakes.title = qc.detail ?? "";
    countEls.quakes.textContent = qc.count;

    const hc = heat.counts();
    setBadge(badgeEls.heat, hc.source);
    countEls.heat.textContent = hc.count;
    countEls.heat.title = hc.detail;

    const mc = moon.counts();
    setBadge(badgeEls.moon, mc.source);
    countEls.moon.textContent = mc.count;

    const mac = mars.counts();
    setBadge(badgeEls.mars, mac.source);
    countEls.mars.textContent = mac.count;

    const pc = bodyLayers[focusedBody]?.counts() ?? { source: "idle", count: 0 };
    setBadge(badgeEls.planet, pc.source);
    countEls.planet.textContent = pc.count;
  }, 1000);

  // fade the onboarding hint after a while
  setTimeout(() => document.getElementById("hint").classList.add("faded"), 15000);

  // handy for debugging from the console
  window.__globe = { viewer, sats, flights, ships, quakes, events, launches, cables, plants, timezones, heat, wiki, truesize, search, agent, sun, moon, mars, planets, childMoons, bodyLayers };
}

function setupResponsiveSideMenus() {
  const compact = window.matchMedia(COMPACT_SIDE_MENU_QUERY);
  const controls = new Map();
  let activeRightPanel = null;
  let rightPanelCollapsed = true;
  let rightPanelUserChanged = false;
  const panels = [
    {
      id: "controls",
      el: document.getElementById("panel"),
      toggle: document.getElementById("panel-toggle"),
      menuPane: document.getElementById("panel-menu"),
      aboutToggle: document.getElementById("about-toggle"),
      aboutPane: document.getElementById("panel-about"),
      collapseLabel: "Collapse controls panel",
      expandLabel: "Expand controls panel",
    },
    {
      id: "wiki",
      el: document.getElementById("wiki-panel"),
      toggle: document.getElementById("wp-toggle"),
      collapseLabel: "Collapse Wikipedia panel",
      expandLabel: "Expand Wikipedia panel",
      rightPanel: true,
    },
    {
      id: "agent",
      el: document.getElementById("agent-panel"),
      toggle: document.getElementById("agent-toggle"),
      collapseLabel: "Collapse agent panel",
      expandLabel: "Expand agent panel",
      defaultCollapsed: true,
      rightPanel: true,
    },
  ];
  const rightPanels = panels.filter((panel) => panel.rightPanel);

  function syncRightPanels() {
    for (const panel of rightPanels) {
      const active = !rightPanelCollapsed && panel.id === activeRightPanel;
      panel.el.classList.toggle("collapsed", rightPanelCollapsed);
      panel.el.classList.toggle("right-panel-pane-active", active);
      panel.el.classList.toggle("right-panel-pane-inactive", !active);
      panel.toggle.setAttribute("aria-expanded", String(active));
      if (rightPanelCollapsed) {
        panel.toggle.setAttribute("aria-label", panel.expandLabel);
        panel.toggle.title = panel.expandLabel;
      } else if (active) {
        panel.toggle.setAttribute("aria-label", panel.collapseLabel);
        panel.toggle.title = panel.collapseLabel;
      } else {
        const label = panel.id === "wiki" ? "Switch to Wikipedia panel" : "Switch to agent panel";
        panel.toggle.setAttribute("aria-label", label);
        panel.toggle.title = label;
      }
    }
  }

  function setRightPanelActive(panelId, opts = {}) {
    const control = controls.get(panelId);
    if (!control?.panel.rightPanel) return;
    activeRightPanel = panelId;
    rightPanelCollapsed = false;
    if (panelId === "wiki" && opts.forceOpen) control.panel.el.classList.add("open");
    syncRightPanels();
  }

  function setRightPanelCollapsed(collapsed) {
    rightPanelCollapsed = collapsed;
    if (collapsed) activeRightPanel = null;
    syncRightPanels();
  }

  for (const panel of panels) {
    if (!panel.el || !panel.toggle) continue;
    let userChanged = false;
    let activeLeftPane = "menu";
    const leftTabs = !panel.rightPanel && panel.aboutToggle && panel.menuPane && panel.aboutPane
      ? [
          {
            id: "menu",
            toggle: panel.toggle,
            pane: panel.menuPane,
            collapseLabel: panel.collapseLabel,
            expandLabel: panel.expandLabel,
            switchLabel: "Switch to controls panel",
          },
          {
            id: "about",
            toggle: panel.aboutToggle,
            pane: panel.aboutPane,
            collapseLabel: "Collapse about panel",
            expandLabel: "Expand about panel",
            switchLabel: "Switch to about panel",
          },
        ]
      : null;

    function setCollapsed(collapsed, opts = {}) {
      panel.el.classList.toggle("collapsed", collapsed);
      if (leftTabs) {
        syncLeftTabs(collapsed);
        return;
      }
      panel.toggle.setAttribute("aria-expanded", String(!collapsed));
      panel.toggle.setAttribute("aria-label", collapsed ? panel.expandLabel : panel.collapseLabel);
      panel.toggle.title = collapsed ? panel.expandLabel : panel.collapseLabel;
    }

    function setLeftPane(paneId) {
      if (!leftTabs) return;
      activeLeftPane = paneId;
      for (const tab of leftTabs) {
        const active = tab.id === activeLeftPane;
        tab.pane.hidden = !active;
        tab.pane.classList.toggle("panel-pane-active", active);
      }
      syncLeftTabs(panel.el.classList.contains("collapsed"));
    }

    function syncLeftTabs(collapsed) {
      if (!leftTabs) return;
      for (const tab of leftTabs) {
        const active = tab.id === activeLeftPane;
        tab.toggle.setAttribute("aria-expanded", String(active && !collapsed));
        tab.toggle.setAttribute(
          "aria-label",
          active
            ? (collapsed ? tab.expandLabel : tab.collapseLabel)
            : (collapsed ? tab.expandLabel : tab.switchLabel)
        );
        tab.toggle.title = tab.toggle.getAttribute("aria-label");
      }
    }

    controls.set(panel.id, { panel, setCollapsed });
    if (panel.rightPanel) {
      panel.el.classList.add("collapsed", "right-panel-pane-inactive");
      panel.toggle.setAttribute("aria-expanded", "false");
      panel.toggle.setAttribute("aria-label", panel.expandLabel);
      panel.toggle.title = panel.expandLabel;
    } else {
      if (leftTabs) setLeftPane(activeLeftPane);
      setCollapsed(panel.defaultCollapsed || compact.matches);
    }
    const bindPanelToggle = (toggle, paneId = null) => toggle.addEventListener("click", () => {
      if (panel.rightPanel) {
        rightPanelUserChanged = true;
        const active = !rightPanelCollapsed && activeRightPanel === panel.id;
        if (active) setRightPanelCollapsed(true);
        else setRightPanelActive(panel.id, { forceOpen: panel.id === "wiki" });
        return;
      }
      userChanged = true;
      if (leftTabs && paneId) {
        const collapsed = panel.el.classList.contains("collapsed");
        if (activeLeftPane === paneId && !collapsed) {
          setCollapsed(true);
        } else {
          setLeftPane(paneId);
          setCollapsed(false);
        }
        return;
      }
      setCollapsed(!panel.el.classList.contains("collapsed"));
    });
    bindPanelToggle(panel.toggle, leftTabs ? "menu" : null);
    if (leftTabs) bindPanelToggle(panel.aboutToggle, "about");

    const onCompactChanged = (event) => {
      if (panel.rightPanel) {
        if (!rightPanelUserChanged && event.matches) setRightPanelCollapsed(true);
      } else if (!userChanged) {
        setCollapsed(panel.defaultCollapsed || event.matches);
      }
    };
    if (compact.addEventListener) {
      compact.addEventListener("change", onCompactChanged);
    } else {
      compact.addListener(onCompactChanged);
    }
  }

  function activateRightPanel(panelId) {
    setRightPanelActive(panelId, { forceOpen: panelId === "wiki" });
  }

  document.addEventListener("right-panel:activate", (event) => {
    activateRightPanel(event.detail?.panel);
  });
  document.addEventListener("right-panel:closed", (event) => {
    if (activeRightPanel === event.detail?.panel) {
      setRightPanelCollapsed(true);
    }
  });
  syncRightPanels();
  setupRightPanelResize();
}

function setupRightPanelResize() {
  const handles = Array.from(document.querySelectorAll(".right-panel-resize-handle"));
  if (handles.length === 0) return;

  let preferredWidth = restoreRightPanelWidth();
  let panelWidth = RIGHT_PANEL_DEFAULT_WIDTH;
  let resizePointerId = null;
  let activeHandle = null;

  function maxPanelWidth() {
    return Math.max(260, Math.min(RIGHT_PANEL_MAX_WIDTH, window.innerWidth - RIGHT_PANEL_VIEWPORT_MARGIN));
  }

  function clampPanelWidth(width) {
    const max = maxPanelWidth();
    const min = Math.min(RIGHT_PANEL_MIN_WIDTH, max);
    const n = Number(width);
    const fallback = Math.min(RIGHT_PANEL_DEFAULT_WIDTH, max);
    return Math.round(Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback)));
  }

  function setPanelWidth(width, opts = {}) {
    const n = Number(width);
    if (!opts.keepPreferred && Number.isFinite(n)) {
      preferredWidth = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, n));
    }
    panelWidth = clampPanelWidth(Number.isFinite(n) ? n : preferredWidth);
    document.documentElement.style.setProperty("--right-panel-width", `${panelWidth}px`);
    for (const handle of handles) {
      handle.setAttribute("aria-valuenow", String(panelWidth));
      handle.setAttribute("aria-valuemin", String(Math.min(RIGHT_PANEL_MIN_WIDTH, maxPanelWidth())));
      handle.setAttribute("aria-valuemax", String(maxPanelWidth()));
    }
    if (opts.save) saveRightPanelWidth(preferredWidth);
  }

  function startResize(event) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    resizePointerId = event.pointerId;
    activeHandle = event.currentTarget;
    activeHandle?.setPointerCapture?.(event.pointerId);
    document.body.classList.add("right-panel-resizing");
    window.addEventListener("pointermove", resizeFromPointer);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
    resizeFromPointer(event);
  }

  function resizeFromPointer(event) {
    if (resizePointerId != null && event.pointerId !== resizePointerId) return;
    setPanelWidth(window.innerWidth - event.clientX);
  }

  function endResize(event) {
    if (resizePointerId != null && event.pointerId !== resizePointerId) return;
    try {
      activeHandle?.releasePointerCapture?.(resizePointerId);
    } catch {
      // The pointer may already be released after a browser-level cancel.
    }
    resizePointerId = null;
    activeHandle = null;
    document.body.classList.remove("right-panel-resizing");
    window.removeEventListener("pointermove", resizeFromPointer);
    window.removeEventListener("pointerup", endResize);
    window.removeEventListener("pointercancel", endResize);
    saveRightPanelWidth(preferredWidth);
  }

  function handleKey(event) {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPanelWidth(panelWidth + step, { save: true });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPanelWidth(panelWidth - step, { save: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      setPanelWidth(RIGHT_PANEL_MIN_WIDTH, { save: true });
    } else if (event.key === "End") {
      event.preventDefault();
      setPanelWidth(RIGHT_PANEL_MAX_WIDTH, { save: true });
    }
  }

  for (const handle of handles) {
    handle.addEventListener("pointerdown", startResize);
    handle.addEventListener("keydown", handleKey);
  }
  window.addEventListener("resize", () => setPanelWidth(preferredWidth, { keepPreferred: true }));
  setPanelWidth(preferredWidth);
}

function restoreRightPanelWidth() {
  try {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(saved) ? saved : RIGHT_PANEL_DEFAULT_WIDTH;
  } catch {
    return RIGHT_PANEL_DEFAULT_WIDTH;
  }
}

function saveRightPanelWidth(width) {
  try {
    localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // private mode
  }
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
      pm25: s.aqi != null ? `US AQI ${Math.round(s.aqi)}` : null,
      aqi: s.pm25 != null ? `PM2.5 ${s.pm25.toFixed(s.pm25 >= 10 ? 0 : 1)} µg/m³` : null,
      riverDischarge: null,
      temp2050: `CMIP6 projection (MRI-AGCM3-2-S) · daily max`,
      aurora: `NOAA SWPC ovation forecast`,
    }[s.metric] ?? "";
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
  if (id.kind === "quake") {
    const q = id.quake;
    const ago = timeAgo(q.time);
    const tsunami = q.tsunami ? " · tsunami flag" : "";
    return `<div class="tt-title">M${q.mag.toFixed(1)} · ${q.depth.toFixed(0)} km deep</div>
      <div class="tt-line">${esc(q.place || "—")}</div>
      <div class="tt-note">${ago}${tsunami} · USGS · click for nearby articles</div>`;
  }
  if (id.kind === "event") {
    const e = id.event;
    const date = e.date ? new Date(e.date).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `<div class="tt-title">${esc(e.title)}</div>
      <div class="tt-line">${esc(e.catLabel)}${date ? ` · ${date}` : ""}</div>
      <div class="tt-note">NASA EONET · click for nearby articles</div>`;
  }
  if (id.kind === "launch") {
    const l = id.launch;
    const lines = l.launches.slice(0, 3).map((lz) => {
      const cd = formatCountdown(lz.net);
      const name = esc(lz.rocket || lz.name);
      const mission = lz.mission ? ` · ${esc(lz.mission)}` : "";
      return `<div class="tt-line">${name}${mission} · ${cd}</div>`;
    });
    const extra = l.launches.length > 3 ? `<div class="tt-line">+${l.launches.length - 3} more</div>` : "";
    return `<div class="tt-title">${esc(l.padName || l.location)}</div>
      ${lines.join("")}${extra}
      <div class="tt-note">The Space Devs LL2 · click for nearby articles</div>`;
  }
  if (id.kind === "cable") {
    const c = id.cable;
    return `<div class="tt-title">${esc(c.name || "Submarine cable")}</div>
      <div class="tt-note">TeleGeography Submarine Cable Map</div>`;
  }
  if (id.kind === "plant") {
    const p = id.plant;
    return `<div class="tt-title">${esc(p.name || "Power plant")}</div>
      <div class="tt-line">${esc(p.fuel)} · ${p.mw} MW</div>
      <div class="tt-note">${esc(p.country)} · WRI GPPD</div>`;
  }
  if (id.kind === "timezone") {
    const utc = id.utcFormat || `UTC${id.zone >= 0 ? "+" : ""}${id.zone}`;
    const now = new Date();
    const localMs = now.getTime() + id.zone * 3600000;
    const localTime = new Date(localMs).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return `<div class="tt-title">${esc(utc)}</div>
      <div class="tt-line">${localTime} local time</div>
      <div class="tt-note">Natural Earth time zones</div>`;
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
  if (id.kind === "body") {
    const distKm = id.layer.distanceKm();
    const note = id.layer.config.parentBody
      ? "parent-relative moon ephemeris - spacecraft imagery - click to visit"
      : id.layer.key === "sun"
        ? "astronomy-engine solar ephemeris - Solar System Scope imagery - click to visit"
        : "astronomy-engine ephemeris - Solar System Scope imagery - click to visit";
    return `<div class="tt-title">${esc(id.layer.name)}</div>
      <div class="tt-line">${Math.round(distKm).toLocaleString()} km from Earth right now</div>
      <div class="tt-note">${note}</div>`;
  }
  if (id.kind === "moonwiki") {
    const a = id.article;
    const lat = `${Math.abs(a.lat).toFixed(1)}° ${a.lat >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(a.lon).toFixed(1)}° ${a.lon >= 0 ? "E" : "W"}`;
    const origin = a.country ? ` · mission of ${esc(a.country)}` : "";
    const category = a.categoryLabel ? ` · ${esc(a.categoryLabel)}` : "";
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${lat}, ${lon} · the Moon${origin}</div>
      <div class="tt-note">Wikipedia${category} · click to open article</div>`;
  }
  if (id.kind === "marswiki") {
    const a = id.article;
    const lat = `${Math.abs(a.lat).toFixed(1)}� ${a.lat >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(a.lon).toFixed(1)}� ${a.lon >= 0 ? "E" : "W"}`;
    const origin = a.country ? ` � mission of ${esc(a.country)}` : "";
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${lat}, ${lon} � Mars${origin}</div>
      <div class="tt-note">Wikipedia · click to open article</div>`;
  }
  if (id.kind === "bodywiki") {
    const a = id.article;
    const bodyName = id.layer?.name ?? a.bodyName ?? "this body";
    const lat = `${Math.abs(a.lat).toFixed(1)} deg ${a.lat >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(a.lon).toFixed(1)} deg ${a.lon >= 0 ? "E" : "W"}`;
    const origin = a.country ? ` - mission of ${esc(a.country)}` : "";
    const category = a.categoryLabel ? ` - ${esc(a.categoryLabel)}` : "";
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${lat}, ${lon} - ${esc(bodyName)}${origin}</div>
      <div class="tt-note">Wikipedia${category} - click to open article</div>`;
  }
  if (id.kind === "wiki") {
    const a = id.article;
    const dist = a.distKm != null
      ? (a.distKm < 1 ? `${Math.round(a.distKm * 1000)} m` : `${a.distKm.toFixed(a.distKm < 20 ? 1 : 0)} km`) + " away"
      : (a.badge ?? "Wikipedia");
    return `<div class="tt-title">${esc(a.title)}</div>
      <div class="tt-line">${esc(dist)}</div>
      <div class="tt-note">Wikipedia · click to open article</div>`;
  }
  return "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function timeAgo(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  return `${days} d ago`;
}

boot().catch((e) => {
  const el = document.getElementById("error");
  el.hidden = false;
  el.textContent = `Could not start the globe (${e.message}). WebGL is required.`;
  console.error(e);
});
