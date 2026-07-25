import { describe, it, expect } from "vitest";

import {
  JET_CONFIG,
  JET_SHADER_CONSTANTS,
  apparentKnotSpeed,
  beamingExponent,
  betaFromLorentz,
  dopplerFactor,
  jetCounterJetRatio,
  maxApparentSpeedAngle,
} from "@/configs/jet.config";

/**
 * wiki-globe fork: the §4 jet verification targets, as unit tests.
 *
 * The shader consumes JET_SHADER_CONSTANTS, so asserting on the same module
 * keeps the rendered physics and these expectations from drifting. What cannot
 * be checked here is that the GLSL applies them correctly — that is the
 * rendered check (bright side must flip across the equatorial plane).
 */
describe("jet kinematics", () => {
  const beta = betaFromLorentz(JET_CONFIG.lorentzFactor);

  it("derives beta from the configured Lorentz factor", () => {
    // Gamma = 5 -> beta = sqrt(1 - 1/25) = sqrt(24)/5
    expect(beta).toBeCloseTo(Math.sqrt(24) / 5, 12);
    expect(beta).toBeGreaterThan(0.97);
    expect(JET_SHADER_CONSTANTS.beta).toBe(beta);
  });

  it("keeps the Lorentz factor in the range the spec asks for", () => {
    expect(JET_CONFIG.lorentzFactor).toBeGreaterThanOrEqual(5);
    expect(JET_CONFIG.lorentzFactor).toBeLessThanOrEqual(10);
  });

  it("keeps the half-opening angle in the range the spec asks for", () => {
    expect(JET_CONFIG.openingAngleDeg).toBeGreaterThanOrEqual(5);
    expect(JET_CONFIG.openingAngleDeg).toBeLessThanOrEqual(10);
  });

  it("uses the bolometric g^4 exponent, consistent with the disk", () => {
    // Spec §1.3 makes g^4 non-negotiable for the disk; §1.4 says the jet uses
    // the same law. 3 - alpha = 4 requires alpha = -1.
    expect(beamingExponent(JET_CONFIG.spectralIndex)).toBe(4);
    expect(JET_SHADER_CONSTANTS.beamExponent).toBe(4);
  });

  it("Doppler factor exceeds 1 head-on and collapses tail-on", () => {
    const head = dopplerFactor(beta, 1);
    const tail = dopplerFactor(beta, -1);
    // Head-on delta -> Gamma(1+beta) ~ 2*Gamma for large Gamma
    expect(head).toBeCloseTo(1 / (JET_CONFIG.lorentzFactor * (1 - beta)), 8);
    expect(head).toBeGreaterThan(9);
    expect(tail).toBeLessThan(0.11);
  });

  it("suppresses the counter-jet by the analytic ratio near the axis", () => {
    // §4: counter-jet/jet luminance ratio must match
    // [(1 - beta cos)/(1 + beta cos)]^(3-alpha).
    const cosTheta = Math.cos((10 * Math.PI) / 180);
    const n = beamingExponent(JET_CONFIG.spectralIndex);

    const ratio = jetCounterJetRatio(beta, cosTheta, JET_CONFIG.spectralIndex);
    const fromDoppler =
      Math.pow(dopplerFactor(beta, cosTheta), n) /
      Math.pow(dopplerFactor(beta, -cosTheta), n);

    // The two formulations must agree: Gamma cancels out of the ratio.
    expect(ratio).toBeCloseTo(fromDoppler, 6);

    // At Gamma = 5 viewed 10 deg off-axis the counter-jet is effectively gone.
    expect(ratio).toBeGreaterThan(1e4);
  });

  it("makes the ratio symmetric across the equatorial plane", () => {
    // The bright side must swap, not merely dim: this is the rendered check's
    // analytic counterpart.
    const cosTheta = 0.8;
    const above = jetCounterJetRatio(beta, cosTheta, JET_CONFIG.spectralIndex);
    const below = jetCounterJetRatio(beta, -cosTheta, JET_CONFIG.spectralIndex);
    expect(above * below).toBeCloseTo(1, 6);
    expect(above).toBeGreaterThan(1);
    expect(below).toBeLessThan(1);
  });

  it("produces no beaming asymmetry edge-on", () => {
    // Exactly in the equatorial plane both cones are equally foreshortened.
    expect(jetCounterJetRatio(beta, 0, JET_CONFIG.spectralIndex)).toBeCloseTo(
      1,
      12,
    );
  });

  it("shows superluminal apparent knot motion at small viewing angles", () => {
    // beta_app = beta sin(theta) / (1 - beta cos(theta))
    const theta = (10 * Math.PI) / 180;
    const betaApp = apparentKnotSpeed(beta, theta);
    expect(betaApp).toBeGreaterThan(1);

    // Peak apparent speed is gamma*beta at cos(theta) = beta.
    const peak = apparentKnotSpeed(beta, maxApparentSpeedAngle(beta));
    expect(peak).toBeCloseTo(JET_CONFIG.lorentzFactor * beta, 6);
    expect(peak).toBeGreaterThanOrEqual(betaApp);
  });

  it("stays subluminal in apparent motion when viewed side-on", () => {
    const betaApp = apparentKnotSpeed(beta, Math.PI / 2);
    expect(betaApp).toBeCloseTo(beta, 12);
    expect(betaApp).toBeLessThan(1);
  });
});
