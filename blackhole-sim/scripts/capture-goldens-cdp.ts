#!/usr/bin/env bun
/**
 * Golden capture that talks to Chromium directly over CDP.
 *
 * wiki-globe fork. `scripts/update-goldens.ts` drives Playwright, which cannot
 * launch a browser at all on some Windows hosts: it passes the DevTools
 * channel over inherited handles (`--remote-debugging-pipe`), and when
 * security software blocks that, the browser process starts, answers
 * `--version`, and then the launch dies on a timeout with no diagnostic.
 * `connectOverCDP` fails the same way, because Playwright's transport lives in
 * its own driver process.
 *
 * This script uses no Playwright. It starts Chromium with a TCP debugging
 * port and drives it with Bun's built-in WebSocket, which connects to that
 * same endpoint in milliseconds on the machines where Playwright hangs.
 *
 * Same output as update-goldens: PNGs in tests/golden/ plus captured_at /
 * captured_commit stamps on the manifest. ANGLE is pinned to SwiftShader so
 * the pixels are reproducible on any machine, GPU or not.
 *
 * Usage:
 *   bun scripts/capture-goldens-cdp.ts --confirm
 *   SHADER_CHECK_BASE_URL=http://127.0.0.1:3007/blackhole bun scripts/capture-goldens-cdp.ts --confirm
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  readManifest,
  writeManifest,
  goldenPath,
  type Manifest,
} from "../tests/visual-regression/manifest";
import type { FrameConfig } from "../tests/visual-regression/capture";

const CONFIRM = "--confirm";
const BASE_URL = process.env.SHADER_CHECK_BASE_URL ?? "http://127.0.0.1:3000/blackhole";
const PORT = Number(process.env.SHADER_CHECK_CDP_PORT ?? 9223);
const ANGLE = process.env.SHADER_CHECK_ANGLE ?? "swiftshader";
const CDP_TIMEOUT_MS = Number(process.env.SHADER_CHECK_CDP_TIMEOUT_MS ?? 600_000);

/** Where Playwright keeps its browsers; reused rather than downloading again. */
function findChromium(): string {
  const root = path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? "", ".cache"),
    "ms-playwright",
  );
  const candidates = [
    path.join(root, "chromium_headless_shell-1217", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    path.join(root, "chromium-1217", "chrome-win64", "chrome.exe"),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  const override = process.env.SHADER_CHECK_CHROME;
  if (override) return override;
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").accessSync(c);
      return c;
    } catch {
      // keep looking
    }
  }
  throw new Error(
    "No Chromium found. Set SHADER_CHECK_CHROME to a browser executable.",
  );
}

interface Cdp {
  send: (method: string, params?: unknown, sessionId?: string) => Promise<any>;
  close: () => void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP websocket failed to open"));
    setTimeout(() => reject(new Error("CDP websocket timed out")), 15_000);
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message ?? "CDP error"}`));
      else resolve(msg.result);
    }
  };

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Generous: SwiftShader is a software rasteriser, and this scene is a
        // per-pixel geodesic ray-march. A single 1280x720 frame can take
        // minutes, and Page.captureScreenshot blocks until one is presented.
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
        }, CDP_TIMEOUT_MS);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // already gone
      }
    },
  };
}

function encodeHash(config: FrameConfig): string {
  const parts = Object.entries(config).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `#${parts.join("&")}` : "";
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

async function main(): Promise<void> {
  if (!process.argv.includes(CONFIRM)) {
    process.stderr.write(
      `capture-goldens-cdp: overwrites every PNG in tests/golden/.\n` +
        `Pass ${CONFIRM} to proceed; review the images before committing.\n`,
    );
    process.exit(1);
  }

  const manifest: Manifest = await readManifest();

  // --only=<name>[,<name>] restricts the run to specific frames. A full
  // capture is minutes per frame under SwiftShader, which makes iterating on
  // capture behaviour (determinism especially) painfully slow otherwise.
  //
  // NB: this filters what is *captured*, not the manifest itself. The entries
  // are the same objects, so stamping still works, but `manifest` keeps every
  // frame — filtering it in place would make writeManifest() delete the
  // frames that were not captured.
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  let framesToCapture = manifest.frames;
  if (onlyArg) {
    const wanted = new Set(
      onlyArg.slice("--only=".length).split(",").map((s) => s.trim()),
    );
    framesToCapture = manifest.frames.filter((f) => wanted.has(f.name));
    if (framesToCapture.length === 0) {
      throw new Error(`--only matched no frames in the manifest`);
    }
    process.stdout.write(
      `Restricted to: ${framesToCapture.map((f) => f.name).join(", ")}\n`,
    );
  }

  if (!(await waitFor(BASE_URL, 3000))) {
    throw new Error(
      `No app at ${BASE_URL}. Start it with \`bun run dev\` (set SHADER_CHECK_BASE_URL if not on port 3000).`,
    );
  }
  process.stdout.write(`Using app at ${BASE_URL}\n`);

  const exe = findChromium();
  const profile = path.join(process.env.TEMP ?? "/tmp", `bh-goldens-${Date.now()}`);
  const browser: ChildProcess = spawn(
    exe,
    [
      "--headless",
      "--no-sandbox",
      `--remote-debugging-port=${PORT}`,
      "--use-gl=angle",
      `--use-angle=${ANGLE}`,
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    if (!(await waitFor(`http://127.0.0.1:${PORT}/json/version`, 30_000))) {
      throw new Error(`Chromium did not open a debugging port on ${PORT}`);
    }
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    process.stdout.write(`Browser: ${version.Browser} (ANGLE=${ANGLE})\n`);

    const cdp = await connect(
      String(version.webSocketDebuggerUrl).replace("localhost", "127.0.0.1"),
    );

    const sha = (() => {
      try {
        return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();
    const now = new Date().toISOString();

    for (const entry of framesToCapture) {
      process.stdout.write(`Capturing ${entry.name}... `);
      const frameStart = Date.now();

      const { targetId } = await cdp.send("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });

      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: manifest.viewport.width,
          height: manifest.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );

      // A target that is not fronted gets its requestAnimationFrame throttled
      // to nothing, so the stabilisation loop below would hang forever waiting
      // for frames that never come. Same trap as a hidden browser pane.
      await cdp.send("Page.bringToFront", {}, sessionId);

      // ?deterministic=1 pins the quality tier and render scale and skips
      // startup calibration. Without it the app tunes itself to whatever the
      // machine was doing in its first seconds and no two captures match.
      await cdp.send(
        "Page.navigate",
        { url: `${BASE_URL}/?deterministic=1${encodeHash(entry.config)}` },
        sessionId,
      );

      // Wait for the renderer: canvas attached with a non-zero backing store,
      // then let TAA settle over the manifest's stabilisation frames.
      const wait = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            const wantW = ${manifest.viewport.width};
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            // A frame that never arrives must not hang the capture: every
            // wait below is bounded and falls back to wall-clock time.
            const frame = () => Promise.race([
              new Promise(r => requestAnimationFrame(() => r('raf'))),
              sleep(250).then(() => 'timeout'),
            ]);

            const deadline = Date.now() + 45000;
            let c = null;
            while (Date.now() < deadline) {
              c = document.querySelector('canvas');
              // 300x150 is the default backing store of an unsized canvas:
              // the renderer's resize has not run yet, and screenshotting now
              // would bake in a blank frame.
              if (c && c.width > 300) break;
              window.dispatchEvent(new Event('resize'));
              await sleep(250);
            }
            if (!c) return 'no-canvas';
            if (c.width <= 300) return 'no-canvas:unsized-' + c.width + 'x' + c.height;

            // Spec §6.2: the Milky Way panorama loads asynchronously and the
            // shader draws the procedural starfield until it lands. Capturing
            // in that window records a different sky with nothing in the frame
            // to say so. 'failed' is accepted so a missing asset still yields
            // a comparable frame instead of hanging the run.
            const skyDeadline = Date.now() + 60000;
            while (Date.now() < skyDeadline) {
              const s = window.__bh && window.__bh.skybox && window.__bh.skybox();
              if (s === 'ready' || s === 'failed') break;
              await sleep(250);
            }

            for (let i = 0; i < ${manifest.stabilization_frames}; i++) {
              await frame();
            }
            // Give the ray-marcher a moment beyond TAA settling; SwiftShader
            // is slow enough that a frame can still be mid-flight.
            await sleep(1500);
            return 'ok:' + c.width + 'x' + c.height + ' vw:' + window.innerWidth;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      const status = wait?.result?.value ?? "unknown";
      if (String(status).startsWith("no-canvas")) {
        throw new Error(`${entry.name}: canvas never initialised`);
      }

      // Chromium intermittently answers "Unable to capture screenshot" when
      // the surface is not presentable at the moment of the call. It is
      // transient; retry rather than losing a multi-minute render.
      let shot: { data: string } | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 4 && !shot; attempt++) {
        try {
          shot = await cdp.send(
            "Page.captureScreenshot",
            {
              format: "png",
              clip: {
                x: 0,
                y: 0,
                width: manifest.viewport.width,
                height: manifest.viewport.height,
                scale: 1,
              },
            },
            sessionId,
          );
        } catch (err) {
          lastErr = err;
          process.stdout.write("retry ");
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!shot) {
        throw new Error(
          `${entry.name}: screenshot failed after retries: ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
          }`,
        );
      }

      const out = goldenPath(entry.name);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, Buffer.from(shot.data, "base64"));

      entry.captured_at = now;
      entry.captured_commit = sha;

      await cdp.send("Target.closeTarget", { targetId });
      process.stdout.write(
        `done (${status}) in ${((Date.now() - frameStart) / 1000).toFixed(1)}s\n`,
      );
    }

    await writeManifest(manifest);
    cdp.close();
    process.stdout.write(
      `Goldens written. Review tests/golden/*.png before committing.\n`,
    );
  } finally {
    browser.kill();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `capture-goldens-cdp failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
