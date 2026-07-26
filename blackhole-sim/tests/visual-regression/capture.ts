import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

export interface FrameConfig {
  mass: number;
  spin: number;
  zoom: number;
  diskTemp?: number;
  diskDensity?: number;
  diskSize?: number;
  lensing?: number;
  autoSpin?: number;
}

export interface CaptureOptions {
  config: FrameConfig;
  viewport: { width: number; height: number };
  outPath: string;
  baseUrl: string;
  stabilizationFrames: number;
}

function encodeHash(config: FrameConfig): string {
  const parts = Object.entries(config).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `#${parts.join("&")}` : "";
}

/**
 * ANGLE backend for the headless capture.
 *
 * wiki-globe fork: upstream pinned `vulkan`, which hangs at launch on hosts
 * without a usable Vulkan ICD (Chromium starts, then never completes the
 * handshake — a 180 s timeout with no error).
 *
 * `swiftshader` is the default here for a second and better reason: it is a
 * software rasteriser, so the same scene produces the same pixels on any
 * machine. Goldens captured against a host GPU would encode that GPU's driver
 * and could never match a GitHub Actions runner, which has no GPU at all —
 * the regression suite would fail everywhere except the machine that recorded
 * it. Override with SHADER_CHECK_ANGLE if you specifically want host-GPU
 * behaviour.
 */
const ANGLE_BACKEND = process.env.SHADER_CHECK_ANGLE ?? "swiftshader";

/**
 * Attach to an already-running browser over CDP instead of launching one.
 *
 * wiki-globe fork. Playwright launches Chromium with `--remote-debugging-pipe`,
 * which passes the CDP channel over inherited handles. Some sandboxed and
 * containerised environments block that: the browser process starts fine (it
 * answers `--version`) but the handshake never completes and the launch dies
 * on a timeout with no diagnostic. Pointing `SHADER_CHECK_CDP_URL` at a
 * browser started with `--remote-debugging-port` sidesteps the pipe entirely.
 *
 * Start one with:
 *   chrome-headless-shell --headless --no-sandbox --remote-debugging-port=9223 \
 *     --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
 */
const CDP_URL = process.env.SHADER_CHECK_CDP_URL;

export async function captureFrame(opts: CaptureOptions): Promise<void> {
  const launched = CDP_URL
    ? null
    : await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--use-gl=angle",
          `--use-angle=${ANGLE_BACKEND}`,
          "--enable-unsafe-swiftshader",
          "--ignore-gpu-blocklist",
        ],
      });
  const browser = launched ?? (await chromium.connectOverCDP(CDP_URL as string));

  try {
    // A CDP-attached Chromium may refuse a fresh context; fall back to the
    // default one and size the page directly.
    let ctx;
    try {
      ctx = await browser.newContext({
        viewport: opts.viewport,
        deviceScaleFactor: 1,
      });
    } catch {
      ctx = browser.contexts()[0];
      if (!ctx) throw new Error("no browser context available over CDP");
    }
    const page = await ctx.newPage();
    await page.setViewportSize(opts.viewport);

    const targetUrl = `${opts.baseUrl}/${encodeHash(opts.config)}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    // Wait for the canvas to mount and the renderer to start producing frames.
    await page.waitForSelector("canvas", {
      state: "attached",
      timeout: 30_000,
    });

    // The renderer is asynchronous (WASM load + WebGL init). Wait for the
    // canvas to have a non-zero device-pixel size, which indicates init
    // completed at least one frame.
    await page.waitForFunction(
      () => {
        const c = document.querySelector("canvas") as HTMLCanvasElement | null;
        return !!c && c.width > 0 && c.height > 0;
      },
      { timeout: 30_000 },
    );

    // TAA accumulates over a handful of frames; let it settle before capture.
    await page.evaluate(async (n: number) => {
      for (let i = 0; i < n; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    }, opts.stabilizationFrames);

    await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
    const buf = await page.screenshot({
      type: "png",
      omitBackground: false,
      clip: { x: 0, y: 0, ...opts.viewport },
    });
    await fs.writeFile(opts.outPath, buf);
    await page.close();
  } finally {
    // Only close a browser this function started. A CDP-attached one belongs
    // to whoever launched it and is reused across every frame in the run —
    // closing it here would kill the browser before the second capture.
    if (launched) await launched.close();
  }
}
