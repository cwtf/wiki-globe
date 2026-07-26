"use client";

import { useEffect, useState } from "react";

import { projectToScreen, type CameraState } from "@/physics/camera-projection";
import type { UseTestObject } from "@/hooks/useTestObject";

/**
 * The dropped object's marker and trail, drawn as an SVG overlay (spec §1.6).
 *
 * v1 per the spec: "draws the object marker + trail at its true coordinates
 * (trail = polyline in the shader pass or a 2D overlay projection)". The
 * overlay route is taken so the ray-marching shader is untouched; the stretch
 * goal of rendering the object's own lensed primary/secondary images by
 * solving the point-source lens equation is NOT done, so the marker does not
 * bend around the hole.
 *
 * The marker is dimmed and reddened by the emitted → observed shift factor,
 * and because the position is looked up by the distant observer's clock it
 * asymptotically freezes at the horizon and fades to black — it is never seen
 * to cross. None of that is special-cased here; it falls out of sampling
 * `t_far` on a worldline whose `t_far` diverges.
 */
export function TestObjectOverlay({
  object,
  mouse,
  zoom,
  mass,
}: {
  object: UseTestObject;
  mouse: { x: number; y: number };
  zoom: number;
  mass: number;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const measure = () => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const { worldline, farTime } = object;
  if (!worldline || worldline.count === 0 || size.width === 0) return null;
  // In 1st person the camera *is* the object, so drawing its marker and trail
  // would be drawing the inside of the viewer's own head.
  if (object.view === "first") return null;

  const cam: CameraState = { mouseX: mouse.x, mouseY: mouse.y, zoom };
  const point = worldline.sampleByFarTime(farTime);
  const marker = projectToScreen(
    worldline.toCartesian(point),
    cam,
    size.width,
    size.height,
  );

  const rs = 2 * mass;
  const shift = worldline.redshiftFactor(point.r, rs);

  // Trail: every sample the distant observer could have seen so far.
  let trailIndex = 0;
  for (let i = 0; i < worldline.count; i++) {
    const s = worldline.at(i);
    if (!Number.isFinite(s.tFar) || s.tFar > farTime) break;
    trailIndex = i;
  }
  const trailPoints = worldline
    .trail(trailIndex, 192)
    .map((p) => projectToScreen(p, cam, size.width, size.height))
    .filter((p) => p.visible)
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  // Redshift fade: the image reddens and dims toward black at the horizon.
  const red = 255;
  const green = Math.round(90 + 150 * shift);
  const blue = Math.round(40 + 190 * shift);
  const opacity = Math.max(0.05, shift);

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20"
      width={size.width}
      height={size.height}
      aria-hidden="true"
    >
      {trailPoints && (
        <polyline
          points={trailPoints}
          fill="none"
          stroke={`rgba(${red}, ${green}, ${blue}, 0.35)`}
          strokeWidth={1}
        />
      )}
      {marker.visible && (
        <>
          <circle
            cx={marker.x}
            cy={marker.y}
            r={4}
            fill={`rgba(${red}, ${green}, ${blue}, ${opacity})`}
          />
          <circle
            cx={marker.x}
            cy={marker.y}
            r={8}
            fill="none"
            stroke={`rgba(${red}, ${green}, ${blue}, ${opacity * 0.4})`}
            strokeWidth={1}
          />
        </>
      )}
    </svg>
  );
}
