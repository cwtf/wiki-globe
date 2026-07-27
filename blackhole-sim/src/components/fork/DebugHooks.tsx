"use client";

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { PerformanceMetrics } from "@/performance/monitor";

import { physicsBridge } from "@/engine/physics-bridge";
import { getSkyboxStatus, type SkyboxStatus } from "@/rendering/skybox";
import { fragmentShaderSource } from "@/shaders/blackhole/fragment.glsl";
import type { SimulationParams } from "@/types/simulation";
import type { FeatureToggles } from "@/types/features";

export interface FrameCapture {
  width: number;
  height: number;
  /** RGBA bytes, bottom-up as returned by gl.readPixels. */
  data: Uint8Array;
}

export interface BlackHoleDebugApi {
  isolated: () => boolean;
  transport: () => string;
  bridge: typeof physicsBridge;
  params: () => SimulationParams;
  setParams: (patch: Partial<SimulationParams>) => void;
  /**
   * Renderer performance as the app itself measures it (spec §6.1 "measure
   * first"). Counting draw calls from outside is unreliable — the renderer
   * owns its context and its own loop — so this surfaces the numbers the
   * PerformanceMonitor already computes.
   */
  metrics: () => PerformanceMetrics | undefined;
  setFeatures: (patch: Partial<FeatureToggles>) => void;
  /** Capture the next rendered frame from the default framebuffer. */
  captureFrame: () => Promise<FrameCapture>;
  /**
   * Compile the production fragment shader with every feature define enabled,
   * in a throwaway context. Returns the driver's info log on failure.
   *
   * The shader chunks are JS template literals, so a stray backtick or a
   * broken interpolation is a *runtime* fault that `tsc` and `next build` both
   * wave through — and in a throttled tab nothing draws, so a broken shader
   * looks identical to a paused one. This makes the distinction checkable.
   */
  compileShader: () => { ok: boolean; log: string };
  /**
   * Camera geometry the fragment shader actually uses, so screen-space
   * measurements can be converted to impact parameter b. See `cameraModel`
   * below for why these two numbers are read off the shader rather than
   * assumed.
   */
  camera: () => { distance: number; focalLength: number; mass: number; spin: number };
  /**
   * Load state of the Milky Way panorama (spec §6.2).
   *
   * A capture taken before the JPEG has been decoded silently records the
   * procedural fallback instead of the real sky — the same frame-count
   * dependence `?deterministic=1` exists to eliminate, arriving by yet another
   * route. Golden captures must wait for `"ready"`.
   */
  skybox: () => SkyboxStatus;
}

declare global {
  interface Window {
    __bh?: BlackHoleDebugApi;
  }
}

// The fallback camera branch in fragment.glsl.ts builds rays as
//   ro = (0, 0, -u_zoom),  rd = normalize(vec3(uv, 1.5))
// with uv = (gl_FragCoord.xy - 0.5 * resolution) / min(resolution.x, resolution.y),
// and renderer.ts sets u_zoom = params.zoom * 2.0. A point at screen radius
// |uv| therefore leaves the camera at angle atan(|uv| / 1.5) from the optical
// axis, giving impact parameter b = distance * sin(that angle).
//
// Hard-coding either number here would silently decouple the verification from
// the shader, so both are named constants mirrored from the shader source and
// asserted by the §4 shadow check rather than trusted.
const SHADER_FOCAL_LENGTH = 1.5;
const ZOOM_TO_DISTANCE = 2.0;

/**
 * wiki-globe fork only. Console handle for the verification workflow, mirroring
 * the globe's own `window.__globe`.
 *
 * `captureFrame` exists because the renderer creates its WebGL2 context with
 * `preserveDrawingBuffer: false`, so reading the canvas after a frame has been
 * composited returns cleared pixels. Instead it temporarily wraps
 * `gl.drawArrays` and reads back immediately after the last draw that targeted
 * the default framebuffer — no source change to the renderer, and the wrapper
 * is removed as soon as the frame is captured.
 */
export function DebugHooks({
  params,
  setParams,
  metrics,
}: {
  params: SimulationParams;
  setParams: Dispatch<SetStateAction<SimulationParams>>;
  metrics?: PerformanceMetrics;
}) {
  // Metrics update every frame; holding them in a ref keeps the debug handle
  // current without re-running the effect (and re-wrapping the API) 60 times
  // a second.
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useEffect(() => {
    const captureFrame = (): Promise<FrameCapture> =>
      new Promise((resolve, reject) => {
        const canvas = document.querySelector("canvas");
        if (!canvas) return reject(new Error("no canvas"));

        // Returns the context that already exists on the canvas.
        const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
        if (!gl) return reject(new Error("no webgl2 context"));

        const original = gl.drawArrays.bind(gl);
        let settled = false;

        const restore = () => {
          gl.drawArrays = original;
        };

        gl.drawArrays = (...args: Parameters<typeof original>) => {
          original(...args);
          if (settled) return;
          // Only the default framebuffer holds the composited image; the
          // bloom/TAA passes render into their own targets first.
          if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) return;

          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const data = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
          settled = true;
          restore();
          resolve({ width, height, data });
        };

        setTimeout(() => {
          if (settled) return;
          settled = true;
          restore();
          reject(new Error("no default-framebuffer draw within 2s"));
        }, 2000);
      });

    const compileShader = (): { ok: boolean; log: string } => {
      const gl = document
        .createElement("canvas")
        .getContext("webgl2") as WebGL2RenderingContext | null;
      if (!gl) return { ok: false, log: "no webgl2 context" };

      // Mirror how ShaderManager assembles a variant: the #version directive
      // must stay on the first line, so defines are spliced in after it.
      const defines = [
        "ENABLE_LENSING",
        "ENABLE_DISK",
        "ENABLE_DOPPLER",
        "ENABLE_STARS",
        "ENABLE_PHOTON_GLOW",
        "ENABLE_JETS",
        "ENABLE_REDSHIFT",
        "RAY_QUALITY_ULTRA",
      ]
        .map((d) => `#define ${d} 1`)
        .join("\n");

      const lines = fragmentShaderSource.split("\n");
      const versionIndex = lines.findIndex((l) => l.startsWith("#version"));
      const source =
        versionIndex >= 0
          ? [
              lines[versionIndex],
              defines,
              ...lines.slice(0, versionIndex),
              ...lines.slice(versionIndex + 1),
            ].join("\n")
          : `${defines}\n${fragmentShaderSource}`;

      const shader = gl.createShader(gl.FRAGMENT_SHADER);
      if (!shader) return { ok: false, log: "createShader failed" };
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      const ok = !!gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      const log = gl.getShaderInfoLog(shader) ?? "";
      gl.deleteShader(shader);
      return { ok, log };
    };

    window.__bh = {
      isolated: () => window.crossOriginIsolated,
      transport: () => physicsBridge.getTransport(),
      bridge: physicsBridge,
      params: () => params,
      setParams: (patch) => setParams((prev) => ({ ...prev, ...patch })),
      metrics: () => metricsRef.current,
      setFeatures: (patch) =>
        setParams((prev) => ({
          ...prev,
          features: { ...(prev.features as FeatureToggles), ...patch },
        })),
      captureFrame,
      compileShader,
      camera: () => ({
        distance: params.zoom * ZOOM_TO_DISTANCE,
        focalLength: SHADER_FOCAL_LENGTH,
        mass: params.mass,
        spin: params.spin,
      }),
      skybox: getSkyboxStatus,
    };
  }, [params, setParams]);

  return null;
}
