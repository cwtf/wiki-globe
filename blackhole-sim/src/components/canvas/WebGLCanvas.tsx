"use client";

import { useRef, useEffect, useState } from "react";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { AlertCircle } from "lucide-react";
import type { SimulationParams, MouseState } from "@/types/simulation";
import type { PerformanceMetrics } from "@/performance/monitor";
import type { FirstPersonFrame } from "@/hooks/useTestObject";
import { PERFORMANCE_CONFIG } from "@/configs/performance.config";
import { isDeterministicCapture } from "@/configs/capture-mode";

interface CanvasError {
  type: "context" | "shader" | "program" | "memory";
  message: string;
  details?: string;
}

interface WebGLCanvasProps {
  params: SimulationParams;
  mouse: MouseState;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
  onWheel: (e: React.WheelEvent | WheelEvent) => void;
  onTouchStart: (e: React.TouchEvent | TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent | TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent | TouchEvent) => void;
  onMetricsUpdate?: (metrics: PerformanceMetrics) => void;
  /**
   * wiki-globe fork: the rider's orthonormal frame for the 1st-person view
   * (spec §1.6), or null for 3rd person. Passed through a ref so a new frame
   * every animation tick does not re-render the React tree.
   */
  firstPerson?: FirstPersonFrame | null;
}

export const WebGLCanvas = ({
  params,
  mouse,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onWheel,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onMetricsUpdate,
  firstPerson,
}: WebGLCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const paramsRef = useRef(params);
  const mouseRef = useRef(mouse);
  const firstPersonRef = useRef(firstPerson ?? null);
  const [error, setError] = useState<CanvasError | null>(null);
  const requestRef = useRef<number>(0);

  const startLoop = () => {
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    // wiki-globe fork (spec §6.1). Two cheap wins that change no pixels:
    //
    //  * Frame cap. Every frame is a full per-pixel geodesic march, so running
    //    at a 144 Hz display's refresh rate burns several times the work
    //    needed for a slowly rotating disk.
    //  * Hidden tab. The physics worker already drops to 1 Hz on
    //    visibilitychange; the renderer did not, and kept marching at full
    //    rate behind another window.
    //
    // Both are disabled for a deterministic capture: the capture needs frames
    // on demand and drives a target that may not be considered visible.
    const deterministic = isDeterministicCapture();
    const minFrameMs = deterministic
      ? 0
      : 1000 / PERFORMANCE_CONFIG.scheduler.targetFPS;
    let lastDraw = 0;

    const loop = () => {
      try {
        const now = performance.now();
        const throttled = now - lastDraw < minFrameMs;
        const hidden = !deterministic && document.hidden;

        if (rendererRef.current && !throttled && !hidden) {
          lastDraw = now;
          rendererRef.current.firstPerson = firstPersonRef.current;
          rendererRef.current.render(paramsRef.current, mouseRef.current);
        }
      } catch (e: unknown) {
        // CRITICAL: Without this try/catch, any throw inside render() silently
        // kills the entire rAF loop. The user sees a black screen with no error.
        // eslint-disable-next-line no-console
        console.error("[WebGLCanvas] Render loop crash:", e);
        const err = e as Error;
        setError({
          type: "shader" as const,
          message: `Render loop crashed: ${err.message || String(e)}`,
          details: err.stack || String(e),
        });
        // Stop the loop on crash to prevent infinite error spam
        return;
      }
      requestRef.current = requestAnimationFrame(loop);
    };
    requestRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    mouseRef.current = mouse;
  }, [mouse]);

  useEffect(() => {
    firstPersonRef.current = firstPerson ?? null;
  }, [firstPerson]);

  useEffect(() => {
    if (!canvasRef.current || rendererRef.current) return;

    // Ensure canvas has initial size before renderer init
    const canvas = canvasRef.current;
    canvas.width =
      window.innerWidth * Math.min(window.devicePixelRatio || 1, 2.0);
    canvas.height =
      window.innerHeight * Math.min(window.devicePixelRatio || 1, 2.0);

    const renderer = new WebGLRenderer();
    renderer.onMetricsUpdate = onMetricsUpdate;
    const success = renderer.init(canvas);

    if (success) {
      rendererRef.current = renderer;
      startLoop();
    } else {
      setError(
        renderer.error || { type: "context", message: "WebGL Init Failed" },
      );
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (rendererRef.current) rendererRef.current.cleanup();
      // CRITICAL FIX: Must null the ref so React 18 Strict Mode's
      // second mount can re-initialize. Without this, the guard at
      // the top of this effect (`if (rendererRef.current) return`)
      // skips init on the second mount, leaving a dead renderer.
      rendererRef.current = null;
    };
  }, [onMetricsUpdate]);

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
        const newWidth = window.innerWidth * dpr;
        const newHeight = window.innerHeight * dpr;

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
          canvas.width = newWidth;
          canvas.height = newHeight;
          if (rendererRef.current)
            rendererRef.current.resize(newWidth, newHeight);
        }
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Attach listeners with passive: false to allow preventDefault()
    const options: AddEventListenerOptions = { passive: false };

    const wheelHandler = (e: WheelEvent) => onWheel(e);
    const touchStartHandler = (e: TouchEvent) => onTouchStart(e);
    const touchMoveHandler = (e: TouchEvent) => onTouchMove(e);
    const touchEndHandler = (e: TouchEvent) => onTouchEnd(e);

    canvas.addEventListener("wheel", wheelHandler, options);
    canvas.addEventListener("touchstart", touchStartHandler, options);
    canvas.addEventListener("touchmove", touchMoveHandler, options);
    canvas.addEventListener("touchend", touchEndHandler, options);

    return () => {
      canvas.removeEventListener("wheel", wheelHandler);
      canvas.removeEventListener("touchstart", touchStartHandler);
      canvas.removeEventListener("touchmove", touchMoveHandler);
      canvas.removeEventListener("touchend", touchEndHandler);
    };
  }, [onWheel, onTouchStart, onTouchMove, onTouchEnd]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 w-full h-full z-0 cursor-move"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />

      {error && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm select-text">
          <div className="max-w-2xl mx-4 p-6 bg-red-950/50 border border-red-500/30 rounded-xl shadow-2xl">
            <div className="flex items-start gap-4">
              <AlertCircle className="w-6 h-6 text-red-400 flex-shrink-0 mt-1" />
              <div className="flex-1">
                <div className="flex justify-between items-center mb-2">
                  <h2 className="text-lg font-bold text-red-300">
                    {error.type === "context" && "WebGL Not Available"}
                    {error.type === "shader" && "Shader Error"}
                    {error.type === "program" && "Link Error"}
                    {error.type === "memory" && "GPU Memory Error"}
                  </h2>
                  <button
                    onClick={() => {
                      const text = `${error.message}\n\n${error.details || ""}`;
                      navigator.clipboard.writeText(text);
                    }}
                    className="text-[10px] bg-white/10 hover:bg-white/20 px-2 py-1 rounded border border-white/10 text-white transition-colors"
                  >
                    Copy Full Error
                  </button>
                </div>
                <p className="text-sm text-gray-300 mb-3">{error.message}</p>
                {error.details && (
                  <div className="text-xs text-gray-400 bg-black/30 p-3 rounded border border-white/10 max-h-[400px] overflow-auto">
                    <div className="font-medium text-gray-300 mb-2">
                      Technical Details:
                    </div>
                    <pre className="whitespace-pre-wrap font-mono break-all">
                      {error.details}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
