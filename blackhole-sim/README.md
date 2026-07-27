# Interactive Black Hole Simulation

A scientifically accurate, real-time relativistic ray-marching engine for visualizing Kerr black holes at near-extremal spin ($a=0.999$). Built with **Next.js 14**, **WebGL 2.0 (High Compatibility)**, **WebGPU (Performance Roadmap)**, and **Rust (Physics Kernel)**.

---

## Technical Specifications

| Domain         | Technology                                    | Implementation          |
| :------------- | :-------------------------------------------- | :---------------------- |
| **Framework**  | Next.js 14 (App Router), React 18             | Orchestration           |
| **Physics**    | Rust (WASM), f64 precision                    | Gravitas-Core Kernel    |
| **Rendering**  | WebGL 2.0 (Primary) / WebGPU (Alpha)          | Geodesic Ray-Marcher    |
| **Integrator** | Adaptive RKF45 (Rust) / Velocity-Verlet (GPU) | 2nd-Order Symplectic    |
| **Memory**     | SharedArrayBuffer (Zero-Copy)                 | Offset-Matched Protocol |
| **Tooling**    | Bun, Rust (uv/cargo), wasm-pack               | High-Performance Stack  |

---

## Core Engineering Features

- **Relativistic Ray-Marching**: Solves curved spacetime geodesics using a numerically regularized **Kerr-Schild Metric** for horizon stability.
- **Hybrid Performance Strategy**: Distributes workload across hardware layers—CPU (Logic), GPU (Pixels), and Rust (Math).
- **Temporal Anti-Aliasing (TAA)**: Custom reprojection pass with **Variance Clipping** in YCoCg color space to eliminate ray-marching noise.
- **Adaptive Quality System**: Detects hardware tiers (e.g., Intel Iris Xe) and dynamically adjust resolution and step counts.
- **True 3D Spacetime Analytics**: Mathematically rigorous 3D volumetric metric grids mapping coordinate-invariant curvature and frame-dragging fields.
- **Spectral Basis Rendering**: Utilizes pre-computed Planckian LUTs to render physically accurate Doppler/Gravitational redshift.

---

## System Architecture

The engine utilizes a **Zero-Copy Reactive Data Pipeline**. High-precision physics and high-throughput rendering communicate over a **SharedArrayBuffer** to eliminate serialization overhead.

```text
.
├── docs/                   # Scientific Specs, Architecture, & Performance Reports
├── physics-engine/         # Rust Physics Kernel (WASM)
│   ├── gravitas-core/      # Core Math Library (Metric Tensors, RKF45)
│   └── gravitas-wasm/      # WASM FFI layer & SAB Protocol
└── src/
    ├── app/                # Next.js 14 Application Entry
    ├── rendering/          # WebGL/WebGPU Pipeline (TAA, Bloom, Adaptive Resolution)
    ├── shaders/            # GPU Geodesic Kernels (Velocity-Verlet)
    ├── workers/            # Multi-threaded Physics Host (75Hz Active / 1Hz Idle)
    └── engine/             # Direct WASM/SAB Bridge
```

> For a complete breakdown of the mathematical framework and performance optimizations, see the [**System Architecture Documentation**](./docs/ARCHITECTURE.md).

---

## Run locally

The simulator needs Bun for the Next.js application and a Rust toolchain to
compile the physics engine to WebAssembly. No API keys or `.env` file are
required.

### 1. Install the prerequisites

- [Git](https://git-scm.com/downloads)
- [Bun](https://bun.sh/docs/installation) **1.2 or newer**
- [Rust](https://www.rust-lang.org/tools/install) (latest stable, installed
  with `rustup`)
- [`wasm-pack`](https://github.com/wasm-bindgen/wasm-pack)
- A current browser with WebGL 2 support (Chrome, Edge, or Firefox recommended)

#### Windows

Run the Bun installer in PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Download and run
[`rustup-init.exe`](https://www.rust-lang.org/tools/install), choosing the
default stable toolchain. The Rust installer may prompt you to install the
Visual Studio C++ Build Tools; accept that prompt if they are not already
installed.

Open a **new** PowerShell window, then install `wasm-pack`:

```powershell
cargo install wasm-pack --locked
```

#### macOS or Linux

```bash
# Install Bun.
curl -fsSL https://bun.com/install | bash

# Install the stable Rust toolchain.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Install the WebAssembly build tool.
cargo install wasm-pack --locked
```

On macOS, install the compiler tools with `xcode-select --install` if prompted.
On Debian/Ubuntu, install a native compiler first with
`sudo apt install build-essential`.

Verify that the tools are available:

```bash
bun --version
rustc --version
cargo --version
wasm-pack --version
```

### 2. Install dependencies and start the app

From the root of the `wiki-globe` repository:

```bash
cd blackhole-sim
bun install
bun run dev
```

`bun run dev` compiles the Rust physics engine to
`public/wasm/` before starting Next.js, so a separate WASM build is not needed.
The first run can take a few minutes while Rust downloads and compiles its
dependencies.

Open [http://localhost:3000/blackhole/](http://localhost:3000/blackhole/) in
your browser. Stop the development server with `Ctrl+C`.

For subsequent frontend-only development, `bun run dev` is sufficient. When
working on the Rust engine, install `cargo-watch` once and use the watch mode to
rebuild the WASM output whenever Rust source files change:

```bash
cargo install cargo-watch --locked
bun run dev:watch
```

### Troubleshooting

- **`bun`, `cargo`, or `wasm-pack` is not recognized:** close and reopen the
  terminal so the installer changes to `PATH` take effect.
- **PowerShell reports that `bun.ps1` is not digitally signed:** remove an old
  npm-installed Bun shim, install Bun with the official command above, and open
  a new terminal. As a temporary workaround, invoke `bun.exe` instead of
  `bun`.
- **Rust reports a linker or MSVC error on Windows:** install Visual Studio
  Build Tools with the **Desktop development with C++** workload, then restart
  the terminal.
- **The WASM build cannot find its target:** run
  `rustup target add wasm32-unknown-unknown`, then retry `bun run dev`.

---

## Documentation Index

1. [**ARCHITECTURE.md**](./docs/ARCHITECTURE.md) - System design, pipeline diagrams, and file structure.
2. [**PHYSICS.md**](./docs/PHYSICS.md) - Mathematical foundations (Kerr Metric, Redshift, Geodesics).
3. [**PERFORMANCE.md**](./docs/PERFORMANCE.md) - Optimization strategies (TAA, Uniform Batching, Adaptive LOD).

---

## License

MIT - Copyright (c) 2026 Mayank / steeltroops-ai.

### Asset credits (wiki-globe fork)

- **Sky**: [Milky Way panorama](https://www.eso.org/public/images/eso0932a/) by
  ESO / S. Brunier, CC BY 4.0. The shipped
  `public/textures/milky-way-eso-4k.jpg` is the 6000×3000 original
  area-averaged in linear light to 4096×2048 by the parent repository's
  `scripts/data/generate-blackhole-skybox.ps1`. It is sampled per escaped ray,
  so the sky is genuinely lensed; the galactic plane's 60° tilt relative to the
  accretion disk is a stated styling choice, not a measurement — the two are
  physically unrelated. See `FORK.md`.
