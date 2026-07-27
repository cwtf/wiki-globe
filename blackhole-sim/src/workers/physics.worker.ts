/**
 * Black Hole Physics Worker
 * Decoupled Physics Heartbeat (120Hz)
 */

interface WorkerInitialData {
  sab: SharedArrayBuffer;
  mass: number;
  spin: number;
}

// State
let engine: import("blackhole-physics").PhysicsEngine | null = null;
let sab: SharedArrayBuffer | null = null;
let lastTickTime = 0;

import { OFFSETS } from "@/engine/sab-schema";

// Subarray views for the SharedArrayBuffer
let sabControlView: Float32Array;
let sabCameraView: Float32Array;
let sabPhysicsView: Float32Array;
let sabSequenceView: Int32Array; // Used for Atomic synchronization

const IDLE_THRESHOLD_MS = 3000;
let isIdle = false;
let idleStartTime = 0;
let tabHidden = false; // set by VISIBILITY messages from the main thread

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === "VISIBILITY") {
    tabHidden = !!(data as { hidden: boolean }).hidden;
    return;
  }

  if (type === "INIT") {
    const { sab: sharedBuffer, mass, spin } = data as WorkerInitialData;
    sab = sharedBuffer;

    sabControlView = new Float32Array(
      sab,
      OFFSETS.CONTROL * 4,
      OFFSETS.CAMERA - OFFSETS.CONTROL,
    );
    sabCameraView = new Float32Array(
      sab,
      OFFSETS.CAMERA * 4,
      OFFSETS.PHYSICS - OFFSETS.CAMERA,
    );
    sabPhysicsView = new Float32Array(
      sab,
      OFFSETS.PHYSICS * 4,
      OFFSETS.TELEMETRY - OFFSETS.PHYSICS,
    );
    sabSequenceView = new Int32Array(sab);

    try {
      const wasmModuleWrap = await import("blackhole-physics");
      const wasmModule = await wasmModuleWrap.default();
      const { PhysicsEngine, init_hooks } = wasmModuleWrap;

      // Wire the Rust panic hook so panics surface as stack traces in
      // the JS console instead of silent worker termination.
      init_hooks();

      engine = new PhysicsEngine(mass, spin);

      // Store reference to memory for calculation copies
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).wasmMemory = wasmModule.memory;

      lastTickTime = performance.now();
      calculate();

      self.postMessage({ type: "READY" });
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error("Physics Worker Initialization Failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      self.postMessage({
        type: "ERROR",
        error: message,
      });
    }
  }

  if (type === "UPDATE_PARAMS" && engine) {
    engine.update_params(data.mass, data.spin);
  }

  if (type === "SET_CAMERA_STATE" && engine) {
    const { pos, lookAt } = data;
    engine.set_camera_state(pos.x, pos.y, pos.z, lookAt.x, lookAt.y, lookAt.z);
  }

  if (type === "SET_AUTO_SPIN" && engine) {
    engine.set_auto_spin(data);
  }

  // wiki-globe fork (spec §1.5): integrate a dropped test object.
  //
  // Deliberately NOT routed through the SharedArrayBuffer ring. That buffer is
  // a fixed-layout, per-frame telemetry channel; a worldline is computed once
  // per drop and is variable-length (up to ~20k samples). It is transferred
  // instead, so the copy is zero-cost and the ring layout stays untouched.
  if (type === "DROP_OBJECT" && engine) {
    const {
      id,
      preset,
      r0,
      tangentialFraction,
      radialVelocity,
      innerRadius,
      maxSteps,
      maxSamples,
      rPeri,
    } = data;
    try {
      const samples = engine.integrate_test_object(
        preset,
        r0,
        tangentialFraction,
        radialVelocity,
        innerRadius,
        maxSteps,
        maxSamples,
        rPeri ?? 0,
      );
      // Copy out of WASM memory: the returned view aliases the heap, which
      // moves when WASM grows, and it cannot be transferred while it does.
      const owned = new Float32Array(samples);
      // TS resolves `self` to Window here, whose postMessage overloads do not
      // accept a transfer list; in a worker this is DedicatedWorkerGlobalScope.
      const post = self.postMessage.bind(self) as (
        message: unknown,
        transfer: Transferable[],
      ) => void;
      post(
        {
          type: "WORLDLINE",
          id,
          samples: owned,
          audit: {
            energy: engine.worldline_energy(),
            angularMomentum: engine.worldline_angular_momentum(),
            energyDrift: engine.worldline_energy_drift(),
            angularMomentumDrift: engine.worldline_angular_momentum_drift(),
            properTime: engine.worldline_proper_time(),
            coordinateTime: engine.worldline_coordinate_time(),
            endReason: engine.worldline_end_reason(),
            sampleCount: engine.worldline_sample_count(),
          },
        },
        [owned.buffer],
      );
    } catch (err: unknown) {
      self.postMessage({
        type: "WORLDLINE_ERROR",
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // wiki-globe fork (spec §6.3): classify a pair of apsides without
  // integrating. Cheap enough to answer while a handle is being dragged, which
  // is the point — the alternative was a TypeScript copy of the solver, and a
  // second implementation of the same physics is how the two drift apart.
  if (type === "SOLVE_APSIDES" && engine) {
    const { id, rPeri, rApo } = data;
    try {
      self.postMessage({
        type: "APSIDES",
        id,
        values: Array.from(engine.solve_apsides(rPeri, rApo) as Float64Array),
      });
    } catch (err: unknown) {
      self.postMessage({
        type: "APSIDES_ERROR",
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (type === "UPDATE_INPUTS" && sabControlView) {
    // Write directly to shared memory
    sabControlView[1] = data.orbitX;
    sabControlView[2] = data.orbitY;
    sabControlView[3] = data.zoom;
    sabControlView[4] = data.dt;
  }
};

// Persistent views to avoid GC pressure
let wasmF32: Float32Array | null = null;
let lastBufferLength = 0;

function calculate() {
  if (!engine || !sab) return;

  const currentTime = performance.now();
  const dt = (currentTime - lastTickTime) / 1000;
  lastTickTime = currentTime;

  // 1. REBIND PERSISTENT VIEWS (Phase 2.1: Memory Guard)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memory = (self as any).wasmMemory as WebAssembly.Memory;
  const currentBuffer = memory.buffer;
  if (!wasmF32 || currentBuffer.byteLength !== lastBufferLength) {
    wasmF32 = new Float32Array(currentBuffer);
    lastBufferLength = currentBuffer.byteLength;
  }

  // 2. READ INPUTS FROM SHARED BUFFER
  const mouse_dx = sabControlView[1] ?? 0;
  const mouse_dy = sabControlView[2] ?? 0;
  const zoom_delta = sabControlView[3] ?? 0;

  // 3. IDLE DETECTION
  const hasInput =
    Math.abs(mouse_dx) > 0.0001 ||
    Math.abs(mouse_dy) > 0.0001 ||
    Math.abs(zoom_delta) > 0.0001;
  if (hasInput) {
    isIdle = false;
    idleStartTime = currentTime;
  } else if (!isIdle && currentTime - idleStartTime > IDLE_THRESHOLD_MS) {
    isIdle = true;
  }

  // 4. RUN PHYSICS
  // The "Anti-Spiral" logic: Clamp DT to prevent integration explosions
  const clampedDt = Math.min(dt, 0.033);
  engine.tick_sab(clampedDt);

  // 5. SYNC TO SHARED BUFFER (Anti-Tearing)
  // Primary Sequence increment (Signals "Write Started")
  Atomics.add(sabSequenceView, OFFSETS.TELEMETRY, 1);

  const wasmSABPtr = engine.get_sab_ptr();
  const startIdx = wasmSABPtr / 4;

  // Zero-Copy Bulk Transfer
  sabCameraView.set(
    wasmF32.subarray(startIdx + OFFSETS.CAMERA, startIdx + OFFSETS.PHYSICS),
  );
  sabPhysicsView.set(
    wasmF32.subarray(startIdx + OFFSETS.PHYSICS, startIdx + OFFSETS.TELEMETRY),
  );

  // Secondary Sequence increment (Signals "Write Complete")
  Atomics.add(sabSequenceView, OFFSETS.TELEMETRY, 1);

  // High-Precision Loop Control
  // Active: 75 Hz (adequate for 60 FPS rendering with margin, ~37% less CPU than 120 Hz)
  // Idle: 1 Hz when input is quiet for IDLE_THRESHOLD_MS or when the tab
  //       is hidden (Page Visibility API signal from main thread).
  const targetHz = isIdle || tabHidden ? 1 : 75;
  const targetDelay = 1000 / targetHz;
  const processingTime = performance.now() - currentTime;
  const finalDelay = Math.max(0, targetDelay - processingTime);

  setTimeout(calculate, finalDelay);
}
