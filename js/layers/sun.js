// Sun layer config: live astronomy-engine solar ephemeris, IAU rotation,
// and Solar System Scope imagery. The Sun has no surface Wikipedia marker
// layer in this app, so it focuses as a textured body only.

import { BODIES } from "../bodies.js";
import { BodyLayer } from "./body.js";

const SUN_BODY = BODIES.sun;
const SUN_RADIUS = SUN_BODY.radius;

const SUN_CONFIG = {
  key: SUN_BODY.key,
  name: SUN_BODY.name,
  textureUrl: SUN_BODY.textureUrl,
  radius: SUN_RADIUS,
  markerColor: SUN_BODY.dotColor,
  wikiEnabled: false,
  fallbackSites: [],
  articleKind: "bodywiki",
  articleProps: { bodyName: "Sun" },
  bodyPickId: (layer) => ({ kind: "body", body: "sun", layer }),
  ephemeris: SUN_BODY.ephemeris,
  orientation: SUN_BODY.orientation,
  skyDot: { color: SUN_BODY.dotColor, pixelSize: 8 },
  transition: {
    proxy: true,
    proxyDistance: SUN_RADIUS * 8,
    proxyRadius: SUN_RADIUS,
    duration: 2.4,
  },
  showBodyWhenUnfocused: false,
  blurDuration: 2.4,
  minZoomMargin: SUN_RADIUS * 0.02,
  focusOffset: (radius) => new Cesium.Cartesian3(0, -radius * 4.2, radius * 0.55),
  flat: true,
};

export class SunLayer extends BodyLayer {
  constructor(viewer) {
    super(viewer, SUN_CONFIG);
  }
}
