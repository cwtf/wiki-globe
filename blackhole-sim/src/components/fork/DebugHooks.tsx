"use client";

import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { physicsBridge } from "@/engine/physics-bridge";
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
  setFeatures: (patch: Partial<FeatureToggles>) => void;
  /** Capture the next rendered frame from the default framebuffer. */
  captureFrame: () => Promise<FrameCapture>;
  /**
   * Camera geometry the fragment shader actually uses, so screen-space
   * measurements can be converted to impact parameter b. See `cameraModel`
   * below for why these two numbers are read off the shader rather than
   * assumed.
   */
  camera: () => { distance: number; focalLength: number; mass: number; spin: number };
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
}: {
  params: SimulationParams;
  setParams: Dispatch<SetStateAction<SimulationParams>>;
}) {
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

    window.__bh = {
      isolated: () => window.crossOriginIsolated,
      transport: () => physicsBridge.getTransport(),
      bridge: physicsBridge,
      params: () => params,
      setParams: (patch) => setParams((prev) => ({ ...prev, ...patch })),
      setFeatures: (patch) =>
        setParams((prev) => ({
          ...prev,
          features: { ...(prev.features as FeatureToggles), ...patch },
        })),
      captureFrame,
      camera: () => ({
        distance: params.zoom * ZOOM_TO_DISTANCE,
        focalLength: SHADER_FOCAL_LENGTH,
        mass: params.mass,
        spin: params.spin,
      }),
    };
  }, [params, setParams]);

  return null;
}
