import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * wiki-globe fork: guard the one failure mode that keeps recurring.
 *
 * The shader chunks are JS template literals. A backtick inside a GLSL comment
 * silently ends the string. If the comment contains an *odd* number of
 * backticks `tsc` reports a syntax error, but an even number — the natural way
 * anyone writes `identifier` in prose — closes and reopens the template, which
 * can still parse while producing garbage GLSL. That variant reached a running
 * dev server once and was only caught when the page failed to mount.
 *
 * Every chunk file must therefore contain exactly the two backticks that
 * delimit its own template literal.
 */

const SHADER_DIR = path.resolve(process.cwd(), "src/shaders/blackhole");

function shaderFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return shaderFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("shader chunk integrity", () => {
  const files = shaderFiles(SHADER_DIR);

  it("finds the shader sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(process.cwd(), f), f]))(
    "%s contains only its delimiting backticks",
    (rel, full) => {
      const src = fs.readFileSync(full as string, "utf8");
      const backticks = (src.match(/`/g) ?? []).length;
      expect(
        backticks,
        `${rel} has ${backticks} backticks; a backtick inside the GLSL ` +
          `template literal ends the shader string. Use plain prose in ` +
          `shader comments, never \`identifier\` quoting.`,
      ).toBe(2);
    },
  );

  it("assembles a fragment shader that still looks like GLSL", async () => {
    // A broken template can yield a string that compiles as TS but is not a
    // shader any more; check the landmarks survive.
    const { fragmentShaderSource } = await import(
      "@/shaders/blackhole/fragment.glsl"
    );
    expect(fragmentShaderSource.startsWith("#version 300 es")).toBe(true);
    expect(fragmentShaderSource).toContain("void main()");
    expect(fragmentShaderSource).toContain("sample_accretion_disk");
    expect(fragmentShaderSource).toContain("sample_relativistic_jets");
    expect(fragmentShaderSource).toContain("kerr_geodesic_accel");
    // No unresolved template interpolation left in the emitted source.
    expect(fragmentShaderSource).not.toContain("${");
  });

  it("keeps the painted photon-ring glow out of the shader", async () => {
    // Spec §1.2: the photon ring must emerge from the integration. The
    // additive glow was removed after the goldens showed it vanishing at high
    // spin; this stops it being reintroduced.
    const { fragmentShaderSource } = await import(
      "@/shaders/blackhole/fragment.glsl"
    );
    expect(fragmentShaderSource).not.toContain("directRing");
    expect(fragmentShaderSource).not.toContain("higherOrderRing");
  });
});
