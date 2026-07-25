/** @type {import('next').NextConfig} */

// wiki-globe fork: the simulator ships as a statically exported sub-app served
// from https://wikiglo.be/blackhole/ by GitHub Pages, not as a Vercel server
// build. Two consequences drive the config below:
//
//   1. `output: "export"` — no server, so `headers()` stops applying at
//      runtime. COOP/COEP (and therefore SharedArrayBuffer) come from
//      `public/coi-serviceworker.js` instead; see FORK.md.
//      The header block is kept for `bun run dev`, where it still works and
//      gives the SAB path a header-based origin to develop against.
//   2. `basePath` — every Next-managed URL (_next assets, the worker chunk,
//      next/image, metadata routes) gains the /blackhole prefix. Plain string
//      literals do NOT get rewritten, so any new `/foo.png` in app code must
//      be written with the prefix explicitly.
const isDev = process.env.NODE_ENV === "development";

const nextConfig = {
  // Static export for GitHub Pages. Dev keeps the normal server so header
  // config and fast refresh behave as upstream expects.
  ...(isDev ? {} : { output: "export" }),

  basePath: "/blackhole",
  // Emit `<route>/index.html` so Pages resolves directory URLs without a
  // rewrite rule. Do not also set assetPrefix: basePath already prefixes
  // _next assets, and setting both double-prefixes them.
  trailingSlash: true,

  // Performance: Enable Gzip compression
  compress: true,
  // Security: Hide Next.js header
  poweredByHeader: false,
  // Strict Mode for better development practices
  reactStrictMode: true,
  // Compiler: Use SWC for minification
  swcMinify: true,

  // Production Optimizations
  compiler: {
    // Remove console.log in production for cleaner performance
    removeConsole: process.env.NODE_ENV === "production",
  },

  // The Next image optimizer is a server feature; static export requires the
  // raw files to be served as-is.
  images: {
    unoptimized: true,
  },

  // Asset Optimization
  experimental: {
    // Tree shake heavy libraries
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "framer-motion",
      "@radix-ui/react-slider",
    ],
  },

  webpack: (config, { isServer }) => {
    // Enable WebAssembly
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Fix for WASM in Next.js
    if (!isServer) {
      config.output.webassemblyModuleFilename = "static/wasm/[modulehash].wasm";
    }

    return config;
  },

  // Dev-only: the exported build has no server to apply these, and Next warns
  // ("Specified headers will not be applied") if they are declared alongside
  // output: "export", so they are gated rather than left unconditional.
  ...(isDev
    ? {
        async headers() {
          return [
            {
              source: "/(.*)",
              headers: [
                {
                  key: "Cross-Origin-Opener-Policy",
                  value: "same-origin",
                },
                {
                  key: "Cross-Origin-Embedder-Policy",
                  value: "require-corp",
                },
                // COEP=require-corp rejects same-origin sub-resources that don't
                // declare an embedding policy. Static assets in /public (logo,
                // favicon, the static-fallback render) and Next.js's optimized
                // image responses both go through this header rule, so a single
                // CORP=same-origin declaration unblocks every same-origin embed.
                {
                  key: "Cross-Origin-Resource-Policy",
                  value: "same-origin",
                },
              ],
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
