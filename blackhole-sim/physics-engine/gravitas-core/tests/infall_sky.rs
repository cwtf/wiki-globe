//! Spec §1.6: what the sky actually looks like from the rider's frame.
//!
//! wiki-globe fork. `tetrad.rs` already checks the frame is orthonormal and
//! that its time leg is the object's 4-velocity — but a frame boosted by the
//! *wrong amount* would pass both. What it would get wrong is the only thing
//! the 1st-person view exists to show: how much of the sky the black hole
//! occupies at the moment of crossing.
//!
//! The physics being pinned:
//!
//! - A static observer at r sees the shadow with half-angle psi_s given by
//!   `sin psi_s = (3 sqrt3 M / r) sqrt(1 - 2M/r)`, taking the obtuse branch
//!   inside the photon sphere. As r -> r_h this tends to 180 degrees: the hole
//!   swallows the whole sky and only a pinprick of universe remains overhead.
//! - The rider is moving inward at speed beta relative to that static
//!   observer, so relativistic aberration sweeps the sky forward and the
//!   shadow *contracts*. Every infaller reaches beta -> 1 at the horizon
//!   (no static observers exist there), but the limit of the aberrated angle
//!   is finite and depends on where the fall started.
//! - Falling from rest at infinity the shadow lands at 42.1 degrees, so about
//!   87% of the sky is still stars at the crossing. Released from rest just
//!   outside the horizon it is 140 degrees instead — nearly the static view,
//!   because there was no room to pick up speed.
//!
//! A frame that forgot the boost entirely would report 180 degrees here.

use gravitas::metric::{Kerr, Metric};
use gravitas::physics::tetrad::{aberrate, dot};
use gravitas::physics::worldline::{
    integrate_worldline, DropSpec, WorldlineEnd, WorldlineOptions,
};

const M: f64 = 1.0;

fn schwarzschild() -> Kerr {
    Kerr::kerr_schild(M, 0.0)
}

/// Shadow half-angle for a *static* observer at r, measured from the inward
/// radial direction. Obtuse inside the photon sphere.
fn static_shadow_angle(r: f64) -> f64 {
    let s = (3.0 * 3.0_f64.sqrt() * M / r) * (1.0 - 2.0 * M / r).max(0.0).sqrt();
    let a = s.min(1.0).asin();
    if r >= 3.0 * M {
        a
    } else {
        std::f64::consts::PI - a
    }
}

/// Stand-in for "released from rest at infinity". The integrator's outer
/// boundary is 1e4 M, so a literal infinity is not available; at 1000 M the
/// crossing angle already agrees with the infinite-fall limit to 0.1 degrees.
const FAR: f64 = 1000.0 * M;

/// Speed of a faller released from rest at `r0`, relative to a local static
/// observer at `r`. Closed form, for checking the tetrad against.
fn analytic_beta(r: f64, r0: f64) -> f64 {
    let k = 2.0 * M / r0;
    (((2.0 * M / r - k) / (1.0 - k)).max(0.0)).sqrt()
}

/// The rider's speed relative to the local static observer, read out of the
/// worldline's own 4-velocity: gamma = -g(u, n) with n the unit static
/// observer, then beta from gamma.
fn measured_beta(bh: &Kerr, r: f64, theta: f64, u: &[f64; 4]) -> f64 {
    // Only meaningful outside the horizon: there is no static observer to be
    // moving relative to inside it. Assert rather than returning a quiet
    // zero — `(-g_tt).sqrt()` goes NaN in there, and `NaN.max(0.0)` is 0.0 in
    // Rust, which would silently read as "not moving" and make an unboosted
    // frame look correct.
    assert!(
        r > 2.0 * M,
        "measured_beta called inside the horizon (r = {r:.4})"
    );
    let g = bh.covariant(r, theta);
    let g_tt = g.as_array()[0];
    // n^mu = (1/sqrt(-g_tt), 0, 0, 0): at rest in these coordinates.
    let n = [1.0 / (-g_tt).sqrt(), 0.0, 0.0, 0.0];

    // Normalise u before contracting; the integrator does not guarantee it.
    let norm = (-dot(bh, r, theta, u, u)).sqrt();
    let un = [u[0] / norm, u[1] / norm, u[2] / norm, u[3] / norm];

    let gamma = -dot(bh, r, theta, &un, &n);
    (1.0 - 1.0 / (gamma * gamma)).max(0.0).sqrt()
}

/// Integrate a drop and return the recorded sample closest to `target_r`
/// **from outside**.
///
/// Not `samples.last()`: the integrator overshoots `inner_radius` by up to a
/// step, so the final sample can sit inside the horizon even when the run was
/// asked to stop just outside it. Everything here is a statement about a
/// static observer, which only exists outside.
fn fall_to(r0: f64, target_r: f64) -> (f64, f64, [f64; 4]) {
    let w = integrate_worldline(
        &schwarzschild(),
        DropSpec::RadialFall { r: r0 },
        &WorldlineOptions {
            // Ask for a little deeper than the target so the sampling
            // brackets it rather than stopping short.
            inner_radius: (target_r * 0.98).max(0.04 * M),
            max_steps: 4_000_000,
            ..Default::default()
        },
    );
    assert!(
        matches!(
            w.end,
            WorldlineEnd::ReachedInnerRadius | WorldlineEnd::StepBudget
        ),
        "drop from {r0} ended {:?}",
        w.end
    );
    let s = w
        .samples
        .iter()
        .filter(|s| s.r >= target_r)
        .min_by(|a, b| a.r.partial_cmp(&b.r).unwrap())
        .unwrap_or_else(|| panic!("no sample outside {target_r} in drop from {r0}"));
    (s.r, s.theta, s.u)
}

#[test]
fn tetrad_boost_matches_the_closed_form_all_the_way_down() {
    // The load-bearing check. If beta is wrong the aberration is wrong and the
    // whole 1st-person sky is wrong, however orthonormal the frame is.
    let bh = schwarzschild();
    for &stop in &[10.0 * M, 4.0 * M, 2.5 * M, 2.05 * M, 2.001 * M] {
        let (r, theta, u) = fall_to(FAR, stop);
        let measured = measured_beta(&bh, r, theta, &u);
        let analytic = analytic_beta(r, FAR);
        let err = (measured - analytic).abs();
        assert!(
            err < 2e-3,
            "at r={r:.4}: tetrad beta {measured:.6} vs closed form {analytic:.6} (err {err:.2e})"
        );
    }
}

/// Closed-form shadow half-angle in the rider's frame at radius `r`, for a
/// fall released from rest at `r0`. Pure analysis — no integrator.
fn analytic_shadow_angle(r: f64, r0: f64) -> f64 {
    aberrate(static_shadow_angle(r).cos(), analytic_beta(r, r0)).acos()
}

#[test]
fn the_shadow_shrinks_instead_of_swallowing_the_sky() {
    // The headline, and the thing a missing boost would destroy.
    //
    // The 42.1 degree figure is a *limit* as r -> r_h. The integrator cannot
    // sit exactly on the horizon and its samples thin out near it, so this
    // checks two separable things: that the rider's own frame reproduces the
    // closed form at whatever radius the sampling reaches, and that the closed
    // form's limit is the 42 degrees claimed.
    let bh = schwarzschild();
    let (r, theta, u) = fall_to(FAR, 2.0 * M + 1e-6);

    let beta = measured_beta(&bh, r, theta, &u);
    let measured = aberrate(static_shadow_angle(r).cos(), beta).acos().to_degrees();
    let analytic = analytic_shadow_angle(r, FAR).to_degrees();

    assert!(
        (measured - analytic).abs() < 0.5,
        "at r={r:.4}: rider's frame gives {measured:.2} deg, closed form {analytic:.2} deg"
    );

    // The static observer at the same place is already most of the way to a
    // black sky; the rider is nowhere near it. That gap is the whole effect.
    let static_deg = static_shadow_angle(r).to_degrees();
    assert!(
        static_deg > 150.0,
        "sanity: static observer at r={r:.4} should see a mostly black sky, got {static_deg:.1}"
    );
    assert!(
        measured < 60.0,
        "rider at r={r:.4} should see a modest disc, not {measured:.1} deg          (static observer sees {static_deg:.1})"
    );

    // And the limit itself, which is what gets quoted.
    let limit = analytic_shadow_angle(2.0 * M + 1e-12, FAR).to_degrees();
    assert!(
        (limit - 42.1).abs() < 0.5,
        "closed-form limit at the horizon is {limit:.2} deg, expected ~42.1"
    );
    let sky_black = (1.0 - limit.to_radians().cos()) / 2.0;
    assert!(
        sky_black < 0.15,
        "only ~13% of the sky should be black at crossing, got {:.1}%",
        100.0 * sky_black
    );
}

#[test]
fn shadow_at_crossing_depends_on_where_the_fall_started() {
    // Released from rest just outside the horizon there is no room to pick up
    // speed, so aberration barely helps and the hole nearly fills the sky.
    // This is the case the camera handover produces, and it should look
    // nothing like the textbook illustration.
    let bh = schwarzschild();
    let stop = 2.0 * M + 1e-6;

    let angle_from = |r0: f64| -> f64 {
        let (r, theta, u) = fall_to(r0, stop);
        let beta = measured_beta(&bh, r, theta, &u);
        aberrate(static_shadow_angle(r).cos(), beta).acos().to_degrees()
    };

    let far = angle_from(FAR);
    let mid = angle_from(6.0 * M);
    let near = angle_from(2.04 * M);

    assert!(
        far < mid && mid < near,
        "shadow should grow as the drop starts closer: {far:.1} / {mid:.1} / {near:.1}"
    );
    assert!(
        (mid - 50.5).abs() < 2.0,
        "drop from 6M: {mid:.2} deg, expected ~50.5"
    );
    assert!(
        (near - 140.0).abs() < 4.0,
        "handover drop from 2.04M: {near:.2} deg, expected ~140"
    );
}

#[test]
fn a_frame_that_forgot_the_boost_would_be_caught() {
    // Guard on the guard: with beta = 0 the aberration is the identity and the
    // shadow is the static 180 degrees. If a refactor ever drops the boost,
    // the tests above must not be able to pass by accident.
    let r = 2.0 * M + 1e-6;
    let unboosted = aberrate(static_shadow_angle(r).cos(), 0.0).acos().to_degrees();
    assert!(
        unboosted > 179.0,
        "sanity: unboosted frame should see ~180 deg, got {unboosted:.2}"
    );
}
