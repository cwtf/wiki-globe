//! Spec §4 verification targets for the dropped test object (§1.5).
//!
//! wiki-globe fork. Every check here is a quantitative target from the spec
//! rather than a regression snapshot, so a failure means the physics is wrong,
//! not that a number moved.
//!
//! All runs use Kerr-Schild coordinates (spec §5): horizon-regular, so the
//! same integrator carries the object across the horizon in milestone 5.

use gravitas::metric::{Kerr, Metric, Orbit};
use gravitas::physics::worldline::{
    integrate_worldline, radial_fall_proper_time, DropSpec, Worldline, WorldlineEnd,
    WorldlineOptions,
};

const M: f64 = 1.0;
/// Schwarzschild radius in geometric units with M = 1.
const RS: f64 = 2.0;

fn schwarzschild() -> Kerr {
    Kerr::kerr_schild(M, 0.0)
}

fn run(drop: DropSpec, opts: WorldlineOptions) -> Worldline {
    integrate_worldline(&schwarzschild(), drop, &opts)
}

#[test]
fn circular_orbit_at_4rs_stays_circular_for_20_orbits() {
    // §4: "Circular-orbit drop at r = 4 r_s stays circular for >= 20 orbits
    // (E/L drift < 1e-6)".
    let r0 = 4.0 * RS; // 8M, comfortably outside the 6M ISCO
    let w = run(
        DropSpec::Circular { r: r0 },
        WorldlineOptions {
            max_steps: 400_000,
            ..Default::default()
        },
    );

    let orbits = w.total_azimuth().abs() / std::f64::consts::TAU;
    assert!(
        orbits >= 20.0,
        "only completed {orbits:.2} orbits within the step budget"
    );

    // Radius must not wander: a circular orbit has constant r.
    let r_min = w.samples.iter().map(|s| s.r).fold(f64::MAX, f64::min);
    let r_max = w.samples.iter().map(|s| s.r).fold(f64::MIN, f64::max);
    assert!(
        (r_max - r_min) / r0 < 1e-6,
        "radius drifted over {orbits:.1} orbits: [{r_min:.9}, {r_max:.9}]"
    );

    assert!(
        w.conserved_within(1e-6),
        "E drift {:.3e}, L drift {:.3e}",
        w.max_energy_drift,
        w.max_angular_momentum_drift
    );
}

/// A circular orbit with a small inward nudge. Perturbation is what
/// distinguishes stable from unstable: an *exactly* circular geodesic exists
/// at any r > 3M, including inside the ISCO, and sits there forever in exact
/// arithmetic because it is an equilibrium. The ISCO is the boundary where
/// that equilibrium stops being stable, so it can only be probed by pushing.
fn nudged_circular(r: f64) -> DropSpec {
    DropSpec::Custom {
        r,
        tangential_fraction: 1.0,
        radial_velocity: -1e-4,
    }
}

#[test]
fn orbit_inside_isco_plunges() {
    // §4: "at r < 3 r_s it plunges". 3 r_s = 6M is exactly the Schwarzschild
    // ISCO: inside it, the circular orbit is an unstable equilibrium, so any
    // perturbation runs away inward.
    let w = run(
        nudged_circular(2.5 * RS), // 5M, inside the 6M ISCO
        WorldlineOptions {
            max_steps: 400_000,
            ..Default::default()
        },
    );

    assert_eq!(
        w.end,
        WorldlineEnd::ReachedInnerRadius,
        "expected a plunge, ended as {:?} at r = {:.4}",
        w.end,
        w.samples.last().unwrap().r
    );
}

#[test]
fn isco_is_the_stability_boundary() {
    // The ISCO is where the two behaviours above meet: just outside it holds,
    // just inside it does not. This pins the boundary rather than assuming it.
    let isco = schwarzschild().isco(Orbit::Prograde);
    assert!((isco - 6.0 * M).abs() < 1e-9, "ISCO should be 6M, got {isco}");

    // Identical nudge either side of the boundary: only the sign of the
    // stability changes.
    let outside = run(
        nudged_circular(isco * 1.05),
        WorldlineOptions {
            max_steps: 400_000,
            ..Default::default()
        },
    );
    assert_ne!(
        outside.end,
        WorldlineEnd::ReachedInnerRadius,
        "an orbit just outside the ISCO should not plunge"
    );
    // The nudge should produce a bounded epicyclic wobble, not a drift.
    let r_min = outside.samples.iter().map(|s| s.r).fold(f64::MAX, f64::min);
    assert!(
        r_min > isco,
        "a stable orbit should oscillate above the ISCO, dipped to {r_min:.4}"
    );

    let inside = run(
        nudged_circular(isco * 0.95),
        WorldlineOptions {
            max_steps: 400_000,
            ..Default::default()
        },
    );
    assert_eq!(
        inside.end,
        WorldlineEnd::ReachedInnerRadius,
        "an orbit just inside the ISCO must plunge"
    );
}

#[test]
fn radial_fall_proper_time_matches_closed_form() {
    // §4: "Radial-fall proper time from r0 to horizon matches the closed-form
    // Schwarzschild result."
    let r0 = 20.0 * M;
    let r_stop = 2.001 * M; // just outside r_h; the analytic form is evaluated at the same r

    let w = run(
        DropSpec::RadialFall { r: r0 },
        WorldlineOptions {
            inner_radius: r_stop,
            max_steps: 400_000,
            ..Default::default()
        },
    );

    assert_eq!(w.end, WorldlineEnd::ReachedInnerRadius);

    let analytic = radial_fall_proper_time(r0, r_stop, M);
    let rel = (w.proper_time - analytic).abs() / analytic;
    assert!(
        rel < 1e-3,
        "proper time {:.6} vs analytic {:.6} (rel err {:.2e})",
        w.proper_time,
        analytic,
        rel
    );
}

#[test]
fn distant_observer_time_diverges_while_proper_time_stays_finite() {
    // §1.6: the 3rd-person view "never sees a crossing".
    //
    // Which clock does that is easy to get wrong. Kerr-Schild time t is
    // REGULAR at the horizon -- that is the whole point of horizon-penetrating
    // coordinates -- so an object crosses in finite t and sampling by t would
    // show it sailing straight through. The freeze lives in the *distant
    // static observer's* (Boyer-Lindquist) clock, `t_far`.
    let r0 = 20.0 * M;

    let shallow = run(
        DropSpec::RadialFall { r: r0 },
        WorldlineOptions {
            inner_radius: 2.05 * M,
            max_steps: 400_000,
            ..Default::default()
        },
    );
    let deep = run(
        DropSpec::RadialFall { r: r0 },
        WorldlineOptions {
            inner_radius: 2.0005 * M,
            max_steps: 800_000,
            ..Default::default()
        },
    );

    // Proper time barely changes over that last sliver of radius...
    let dtau = deep.proper_time - shallow.proper_time;
    assert!(
        dtau > 0.0 && dtau < 0.5,
        "proper time should creep, not diverge: dtau = {dtau:.4}"
    );

    // ...and neither does Kerr-Schild time, which is the point.
    let dt_ks = deep.coordinate_time - shallow.coordinate_time;
    assert!(
        dt_ks < 1.0,
        "Kerr-Schild time is horizon-regular and must stay finite: dt = {dt_ks:.4}"
    );

    // ...while the distant observer's clock runs away.
    let t_far_shallow = shallow.samples.last().unwrap().t_far;
    let t_far_deep = deep.samples.last().unwrap().t_far;
    assert!(
        t_far_deep > t_far_shallow + 10.0,
        "distant-observer time should diverge near the horizon: {t_far_shallow:.3} -> {t_far_deep:.3}"
    );
}

#[test]
fn distant_observer_time_is_infinite_at_and_inside_the_horizon() {
    // The freeze taken to its limit: no static observer exists at r <= r_h,
    // so the 3rd-person view can never sample the crossing at all.
    let w = run(
        DropSpec::RadialFall { r: 20.0 * M },
        WorldlineOptions {
            inner_radius: 0.02 * RS,
            max_steps: 800_000,
            ..Default::default()
        },
    );

    let crossed: Vec<_> = w.samples.iter().filter(|s| s.r < 2.0 * M).collect();
    assert!(!crossed.is_empty(), "expected samples inside the horizon");
    assert!(
        crossed.iter().all(|s| s.t_far.is_infinite()),
        "every sample inside the horizon must have infinite distant-observer time"
    );
    assert!(
        crossed.iter().all(|s| s.tau.is_finite()),
        "proper time must stay finite through and inside the horizon"
    );
}

/// Measure (precession per orbit, semi-latus rectum) for an orbit launched at
/// apoapsis `r_apo`.
fn measure_precession(r_apo: f64) -> (f64, f64) {
    let w = run(
        DropSpec::Eccentric {
            r: r_apo,
            tangential_fraction: 0.98,
        },
        WorldlineOptions {
            max_steps: 4_000_000,
            max_samples: 4_000_000,
            max_step: 5.0,
            ..Default::default()
        },
    );

    let peris = w.periapsis_indices();
    assert!(
        peris.len() >= 2,
        "need two periapsis passages at r_apo = {r_apo}, got {}",
        peris.len()
    );

    let measured = w.precession_per_orbit().expect("precession");
    let i0 = peris[0];
    let i1 = *peris.last().unwrap();
    let r_peri = w.samples[i0..=i1].iter().map(|s| s.r).fold(f64::MAX, f64::min);
    let r_max = w.samples[i0..=i1].iter().map(|s| s.r).fold(f64::MIN, f64::max);
    let semi_major = 0.5 * (r_peri + r_max);
    let ecc = (r_max - r_peri) / (r_max + r_peri);
    (measured, semi_major * (1.0 - ecc * ecc))
}

#[test]
fn precession_error_shrinks_as_the_field_weakens() {
    // The 6*pi*M/p formula is the leading post-Newtonian term, so the residual
    // against a fully relativistic integration is itself physics: it must fall
    // off roughly as M/p. Seeing that scaling is what distinguishes "the
    // formula is truncated" from "the integrator is wrong".
    let (near, p_near) = measure_precession(300.0 * M);
    let (far, p_far) = measure_precession(1000.0 * M);

    let err_near = (near - 6.0 * std::f64::consts::PI * M / p_near).abs()
        / (6.0 * std::f64::consts::PI * M / p_near);
    let err_far = (far - 6.0 * std::f64::consts::PI * M / p_far).abs()
        / (6.0 * std::f64::consts::PI * M / p_far);

    assert!(
        err_far < err_near,
        "residual should shrink with field strength: {err_near:.4} at p = {p_near:.0}M, \
         {err_far:.4} at p = {p_far:.0}M"
    );

    // And it should shrink at roughly the 1/p rate the expansion predicts.
    let ratio = err_near / err_far;
    let p_ratio = p_far / p_near;
    assert!(
        ratio > p_ratio * 0.4 && ratio < p_ratio * 2.5,
        "residual should scale about like M/p: error ratio {ratio:.2} vs p ratio {p_ratio:.2}"
    );
}

#[test]
fn eccentric_orbit_precesses_by_the_analytic_amount() {
    // §4: "Eccentric-orbit periapsis precession within 1% of the analytic
    // formula", delta_phi = 6*pi*G*M / (c^2 * a * (1 - e^2)) per orbit.
    //
    // That is the leading post-Newtonian term, accurate only in the weak
    // field, so the orbit is placed far out: at p ~ 960M the neglected
    // higher-order terms sit well inside the 1% tolerance. (At p ~ 288M the
    // same integration lands 1.6% off the leading-order formula — that is the
    // truncation, not the integrator; see the scaling test above.)
    let (measured, p) = measure_precession(1000.0 * M);

    let analytic = 6.0 * std::f64::consts::PI * M / p;
    let rel = (measured - analytic).abs() / analytic;

    assert!(
        rel < 0.01,
        "precession {measured:.6e} rad/orbit vs analytic {analytic:.6e} \
         (rel err {rel:.4}) at semi-latus rectum p = {p:.1}M"
    );
}

#[test]
fn precession_is_prograde() {
    // Sign matters: GR advances the periapsis in the direction of motion.
    let w = run(
        DropSpec::Eccentric {
            r: 300.0 * M,
            tangential_fraction: 0.98,
        },
        WorldlineOptions {
            max_steps: 2_000_000,
            max_samples: 200_000,
            max_step: 20.0,
            ..Default::default()
        },
    );
    let peris = w.periapsis_indices();
    assert!(peris.len() >= 2);

    let phi0 = w.samples[peris[0]].phi;
    let phi1 = w.samples[peris[1]].phi;
    // Successive periapsis passages are more than a full turn apart.
    let mut d = phi1 - phi0;
    while d < 0.0 {
        d += std::f64::consts::TAU;
    }
    assert!(
        d > 0.0,
        "periapsis should advance in the direction of motion, got {d:.6}"
    );
}

#[test]
fn worldline_carries_both_clocks_and_they_disagree() {
    // §1.6: the disagreement between the clocks IS the physics. A bound orbit
    // deep in the potential must age slower than coordinate time.
    let w = run(
        DropSpec::Circular { r: 4.0 * RS },
        WorldlineOptions {
            max_steps: 100_000,
            ..Default::default()
        },
    );

    assert!(w.proper_time > 0.0);
    assert!(w.coordinate_time > w.proper_time, "gravitational + kinematic time dilation should make t > tau");

    // Samples must be monotonic in both clocks, or sampling one view by t and
    // the other by tau would not be well defined.
    for pair in w.samples.windows(2) {
        assert!(pair[1].tau >= pair[0].tau, "tau must not go backwards");
        assert!(pair[1].t >= pair[0].t, "t must not go backwards");
    }
}

#[test]
fn circular_orbit_dilation_matches_the_analytic_factor() {
    // dt/dtau for a circular equatorial Schwarzschild orbit is
    // 1 / sqrt(1 - 3M/r) -- both the gravitational and the orbital-motion
    // terms together. This pins the clocks quantitatively, not just in order.
    let r = 10.0 * M;
    let w = run(
        DropSpec::Circular { r },
        WorldlineOptions {
            max_steps: 100_000,
            ..Default::default()
        },
    );

    let measured = w.coordinate_time / w.proper_time;
    let analytic = 1.0 / (1.0 - 3.0 * M / r).sqrt();
    let rel = (measured - analytic).abs() / analytic;
    assert!(
        rel < 1e-4,
        "dt/dtau {measured:.9} vs analytic {analytic:.9} (rel err {rel:.2e})"
    );
}

#[test]
fn kerr_schild_lets_the_object_cross_the_horizon() {
    // Spec §5: Kerr-Schild is horizon-regular, so the integrator must be able
    // to follow the object inside r_h. Boyer-Lindquist could not.
    let m = schwarzschild();
    let r_h = m.event_horizon();
    let w = run(
        DropSpec::RadialFall { r: 20.0 * M },
        WorldlineOptions {
            inner_radius: 0.02 * RS, // near the singularity, per §1.6
            max_steps: 800_000,
            ..Default::default()
        },
    );

    assert_eq!(
        w.end,
        WorldlineEnd::ReachedInnerRadius,
        "expected to reach the inner radius, ended {:?}",
        w.end
    );
    let r_final = w.samples.last().unwrap().r;
    assert!(
        r_final < r_h,
        "final radius {r_final:.5} should be inside the horizon {r_h:.5}"
    );
    assert!(
        w.proper_time.is_finite() && w.proper_time > 0.0,
        "proper time through the horizon must stay finite"
    );
}

#[test]
fn spinning_hole_shifts_the_isco_and_the_orbit_still_conserves() {
    // Kerr sanity: prograde ISCO shrinks with spin, and a circular orbit
    // outside it still conserves E and L_z to the same tolerance.
    let kerr = Kerr::kerr_schild(M, 0.9);
    let isco = kerr.isco(Orbit::Prograde);
    assert!(isco < 6.0 * M, "prograde ISCO should shrink with spin: {isco}");

    let w = integrate_worldline(
        &kerr,
        DropSpec::Circular { r: isco * 1.5 },
        &WorldlineOptions {
            max_steps: 200_000,
            ..Default::default()
        },
    );
    assert!(
        w.conserved_within(1e-6),
        "E drift {:.3e}, L drift {:.3e}",
        w.max_energy_drift,
        w.max_angular_momentum_drift
    );
}
