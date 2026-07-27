//! Spec §6.3 (milestone 9): orbits named by their two turning points.
//!
//! wiki-globe fork. The claim being tested is the one the UI makes: drag the
//! handles to r_peri and r_apo, and the object actually turns around there.
//! So most of these integrate the geodesic and measure, rather than checking
//! the solver against itself.

use gravitas::metric::{Kerr, Metric, Orbit};
use gravitas::physics::apsides::{
    constants_from_turning_points, inner_turning_point, radial_cubic,
    schwarzschild_separatrix_periapsis, separatrix_periapsis, solve_apsides, ApsidesKind,
};
use gravitas::physics::worldline::{
    integrate_worldline, DropSpec, Worldline, WorldlineOptions,
};

const M: f64 = 1.0;

fn schwarzschild() -> Kerr {
    Kerr::kerr_schild(M, 0.0)
}

fn spinning(a_star: f64) -> Kerr {
    Kerr::kerr_schild(M, a_star)
}

fn run(metric: &Kerr, r_peri: f64, r_apo: f64, max_steps: usize) -> Worldline {
    integrate_worldline(
        metric,
        DropSpec::FromApsides { r_apo, r_peri },
        &WorldlineOptions {
            max_steps,
            ..Default::default()
        },
    )
}

// --- The solver's own algebra -------------------------------------------

#[test]
fn constants_vanish_the_radial_potential_at_both_apsides() {
    // The defining property: R(r) = 0 at each requested turning point. If this
    // fails, everything downstream is describing a different orbit.
    for &(r_peri, r_apo) in &[(8.0, 20.0), (10.0, 10.5), (5.0, 400.0), (20.0, 21.0)] {
        let (energy, l) = constants_from_turning_points(M, 0.0, r_peri, r_apo)
            .unwrap_or_else(|| panic!("no solution for ({r_peri}, {r_apo})"));

        for r in [r_peri, r_apo] {
            let residual = radial_cubic(r, M, 0.0, energy, l).abs();
            assert!(
                residual < 1e-8,
                "R({r}) = {residual:.3e} for apsides ({r_peri}, {r_apo})"
            );
        }
    }
}

#[test]
fn constants_match_the_schwarzschild_closed_form() {
    // Classic (p, e) result: E^2 = (p-2-2e)(p-2+2e) / [p(p-3-e^2)],
    // L^2 = p^2 M^2 / (p - 3 - e^2). Independent of the algebra under test,
    // which is the point.
    for &(p, e) in &[(10.0, 0.3), (20.0, 0.6), (8.0, 0.1), (50.0, 0.9)] {
        let r_peri = p / (1.0 + e);
        let r_apo = p / (1.0 - e);
        let (energy, l) = constants_from_turning_points(M, 0.0, r_peri, r_apo).unwrap();

        let expected_e2 = (p - 2.0 - 2.0 * e) * (p - 2.0 + 2.0 * e) / (p * (p - 3.0 - e * e));
        let expected_l2 = p * p / (p - 3.0 - e * e);

        assert!(
            (energy * energy - expected_e2).abs() < 1e-10,
            "E^2 {} vs {expected_e2} at (p={p}, e={e})",
            energy * energy
        );
        assert!(
            (l * l - expected_l2).abs() < 1e-9,
            "L^2 {} vs {expected_l2} at (p={p}, e={e})",
            l * l
        );
    }
}

#[test]
fn constants_vanish_the_potential_for_a_spinning_hole() {
    // The Kerr branch is where squaring away the 2aEx term could pick the
    // retrograde root; the residual check inside the solver is what stops it,
    // so exercise it across spins including the near-extremal end.
    for &a_star in &[0.3, 0.6, 0.9, 0.998, -0.5] {
        let metric = spinning(a_star);
        let a = metric.a();
        for &(r_peri, r_apo) in &[(9.0, 25.0), (12.0, 13.0), (7.0, 100.0)] {
            let (energy, l) = constants_from_turning_points(M, a, r_peri, r_apo)
                .unwrap_or_else(|| panic!("no solution at a*={a_star} for ({r_peri}, {r_apo})"));
            for r in [r_peri, r_apo] {
                let residual = radial_cubic(r, M, a, energy, l).abs();
                assert!(
                    residual < 1e-7,
                    "a*={a_star}: R({r}) = {residual:.3e} for ({r_peri}, {r_apo})"
                );
            }
            // Prograde: co-rotating angular momentum.
            assert!(l > 0.0, "a*={a_star}: retrograde branch selected (L = {l})");
        }
    }
}

#[test]
fn swapping_the_apsides_is_the_same_request() {
    // §6.3: "r_peri > r_apo swaps them" — dragging the inner handle past the
    // outer one must not create a dead zone.
    let metric = schwarzschild();
    let forward = solve_apsides(&metric, 8.0, 30.0);
    let reversed = solve_apsides(&metric, 30.0, 8.0);
    assert!((forward.energy - reversed.energy).abs() < 1e-12);
    assert!((forward.angular_momentum - reversed.angular_momentum).abs() < 1e-12);
    assert!((forward.apoapsis - reversed.apoapsis).abs() < 1e-12);
}

// --- The separatrix ------------------------------------------------------

#[test]
fn bisected_separatrix_matches_the_schwarzschild_closed_form() {
    // r_p = 4 M r_a / (r_a - 2M). The production path is the bisection, so
    // this is the check that it lands where theory says.
    for &r_apo in &[7.0, 10.0, 20.0, 100.0, 1000.0] {
        let (measured, _) = separatrix_periapsis(M, 0.0, r_apo);
        let expected = schwarzschild_separatrix_periapsis(M, r_apo);
        assert!(
            (measured - expected).abs() < 1e-6,
            "separatrix at r_apo={r_apo}: {measured} vs {expected}"
        );
    }
}

#[test]
fn separatrix_tends_to_the_marginally_bound_orbit() {
    // r_a -> infinity gives 4M: the marginally bound orbit, the smallest
    // periapsis anything falling from rest at infinity can turn around at.
    let (r_peri, _) = separatrix_periapsis(M, 0.0, 1.0e6);
    assert!(
        (r_peri - 4.0 * M).abs() < 1e-3,
        "expected 4M for a distant apoapsis, got {r_peri}"
    );
}

#[test]
fn separatrix_meets_the_isco_where_the_apsides_merge() {
    // At r_apo = 6M the two turning points coincide: the ISCO is where the
    // separatrix touches the circular-orbit family.
    let (r_peri, _) = separatrix_periapsis(M, 0.0, 6.0 * M);
    assert!(
        (r_peri - 6.0 * M).abs() < 1e-6,
        "expected the ISCO at 6M, got {r_peri}"
    );
}

#[test]
fn a_periapsis_inside_the_isco_is_still_a_stable_orbit() {
    // **Correction to the spec.** §6.3 says "r_peri inside the ISCO must
    // plunge". That is not right: an eccentric orbit's periapsis can sit well
    // inside the ISCO and remain perfectly bound. The real limit is the
    // separatrix, which for Schwarzschild reaches down to 4M.
    let metric = schwarzschild();
    let solution = solve_apsides(&metric, 5.0, 20.0);
    assert!(5.0 < metric.isco(Orbit::Prograde), "test premise");
    assert_eq!(
        solution.kind,
        ApsidesKind::BoundOrbit,
        "a periapsis of 5M from an apoapsis of 20M is above the separatrix at \
         {:.4}M and must stay bound",
        solution.separatrix_periapsis
    );
}

// --- Integrated behaviour: the claim the UI makes ------------------------

#[test]
fn the_integrated_orbit_turns_where_it_was_asked_to() {
    // §6.3's test: "the integrated orbit's measured turning points must come
    // back within tolerance of the requested r_apo/r_peri".
    let metric = schwarzschild();
    for &(r_peri, r_apo) in &[(8.0, 20.0), (10.0, 12.0), (6.0, 60.0), (30.0, 200.0)] {
        let w = run(&metric, r_peri, r_apo, 400_000);
        let measured_peri = w.min_radius();
        let measured_apo = w.max_radius();

        assert!(
            (measured_peri - r_peri).abs() / r_peri < 1e-3,
            "requested periapsis {r_peri}, measured {measured_peri}"
        );
        assert!(
            (measured_apo - r_apo).abs() / r_apo < 1e-3,
            "requested apoapsis {r_apo}, measured {measured_apo}"
        );
        assert!(
            w.conserved_within(1e-6),
            "E/L drift {:.2e} / {:.2e} for ({r_peri}, {r_apo})",
            w.max_energy_drift,
            w.max_angular_momentum_drift
        );
    }
}

#[test]
fn the_integrated_kerr_orbit_turns_where_it_was_asked_to() {
    for &a_star in &[0.5, 0.9] {
        let metric = spinning(a_star);
        for &(r_peri, r_apo) in &[(9.0, 25.0), (12.0, 14.0)] {
            let w = run(&metric, r_peri, r_apo, 400_000);
            assert!(
                (w.min_radius() - r_peri).abs() / r_peri < 2e-3,
                "a*={a_star}: requested periapsis {r_peri}, measured {}",
                w.min_radius()
            );
            assert!(
                (w.max_radius() - r_apo).abs() / r_apo < 2e-3,
                "a*={a_star}: requested apoapsis {r_apo}, measured {}",
                w.max_radius()
            );
        }
    }
}

#[test]
fn a_periapsis_inside_the_separatrix_plunges_instead_of_clamping() {
    // §6.3: "r_peri inside the [separatrix] must plunge rather than silently
    // clamp — that is real physics and the UI should show it, not prevent it."
    let metric = schwarzschild();
    let r_apo = 20.0;
    let (separatrix, _) = separatrix_periapsis(M, 0.0, r_apo);
    let r_peri = separatrix * 0.5;

    let solution = solve_apsides(&metric, r_peri, r_apo);
    assert_eq!(solution.kind, ApsidesKind::Plunge);
    assert!(solution.periapsis.is_none());

    let w = run(&metric, r_peri, r_apo, 400_000);
    // Actually crossed the horizon rather than turning around above it.
    assert!(
        w.min_radius() < metric.event_horizon() * 1.01,
        "expected a plunge, but the object turned at {}",
        w.min_radius()
    );
    // And it is not a clamp: the object never turned around at the separatrix.
    assert!(
        w.min_radius() < separatrix,
        "clamped to the separatrix at {separatrix} instead of plunging"
    );
}

#[test]
fn dragging_the_periapsis_to_the_centre_becomes_a_radial_fall() {
    // The plunge branch scales L by r_peri / r_separatrix, so the limit as the
    // inner handle reaches the middle is zero angular momentum. That
    // continuity is what makes the drag feel like one control rather than two
    // regimes bolted together.
    let metric = schwarzschild();
    let solution = solve_apsides(&metric, 1e-6, 30.0);
    assert_eq!(solution.kind, ApsidesKind::Plunge);
    assert!(
        solution.angular_momentum.abs() < 1e-5,
        "expected near-zero L for a centre-bound drag, got {}",
        solution.angular_momentum
    );

    // And its proper time to the horizon should match free fall from rest.
    let w = run(&metric, 1e-6, 30.0, 400_000);
    let expected =
        gravitas::physics::worldline::radial_fall_proper_time(30.0, 2.0 * M, M);
    let actual = w.proper_time;
    assert!(
        (actual - expected).abs() / expected < 5e-3,
        "radial-fall proper time {actual} vs closed form {expected}"
    );
}

#[test]
fn the_plunge_is_continuous_across_the_separatrix() {
    // Just above the separatrix the orbit is bound with a periapsis right at
    // it; just below, the angular momentum is barely smaller. A jump here
    // would make the drag handle feel like it snapped.
    let metric = schwarzschild();
    let r_apo = 40.0;
    let (separatrix, l_sep) = separatrix_periapsis(M, 0.0, r_apo);

    let just_above = solve_apsides(&metric, separatrix * (1.0 + 1e-6), r_apo);
    let just_below = solve_apsides(&metric, separatrix * (1.0 - 1e-6), r_apo);

    assert_eq!(just_above.kind, ApsidesKind::BoundOrbit);
    assert_eq!(just_below.kind, ApsidesKind::Plunge);
    assert!(
        (just_above.angular_momentum - just_below.angular_momentum).abs() / l_sep < 1e-3,
        "L jumped from {} to {} across the separatrix",
        just_above.angular_momentum,
        just_below.angular_momentum
    );
}

#[test]
fn a_periapsis_below_the_horizon_is_a_capture() {
    // §6.3: "r_peri below the horizon is a capture".
    let metric = schwarzschild();
    let solution = solve_apsides(&metric, 0.5 * metric.event_horizon(), 25.0);
    assert_eq!(solution.kind, ApsidesKind::Plunge);

    let w = run(&metric, 0.5 * metric.event_horizon(), 25.0, 400_000);
    assert!(w.min_radius() < metric.event_horizon() * 1.01);
}

#[test]
fn a_near_separatrix_orbit_precesses_violently() {
    // §6.3: "near-ISCO orbits precess violently, which is the interesting case
    // and should be reachable". Zoom-whirl: the periapsis advance per orbit
    // near the separatrix is a large fraction of a full turn, unlike the
    // ~6 pi M / p of the weak field.
    let metric = schwarzschild();
    let r_apo = 20.0;
    let (separatrix, _) = separatrix_periapsis(M, 0.0, r_apo);
    let w = run(&metric, separatrix * 1.02, r_apo, 600_000);

    let precession = w
        .precession_per_orbit()
        .expect("expected at least two periapsis passages");
    assert!(
        precession > 1.0,
        "expected a large periapsis advance near the separatrix, got {precession} rad"
    );
}

/// Complete elliptic integral of the first kind, by the arithmetic-geometric
/// mean. Converges quadratically; 30 iterations is far past f64.
fn elliptic_k(modulus: f64) -> f64 {
    let mut a = 1.0f64;
    let mut b = (1.0 - modulus * modulus).sqrt();
    for _ in 0..30 {
        let next_a = 0.5 * (a + b);
        b = (a * b).sqrt();
        a = next_a;
    }
    std::f64::consts::PI / (2.0 * a)
}

/// Exact Schwarzschild periapsis advance per radial period, in radians.
///
/// With `u = M/r`, the orbit equation `(du/dphi)^2 = 2(u - u1)(u2 - u)(u3 - u)`
/// has its three roots summing to 1/2, so `u3 = 1/2 - u1 - u2` and
///
/// ```text
///   Delta phi = 4 sqrt(p / (p - 6 + 2e)) K(k) - 2 pi,   k^2 = 4e / (p - 6 + 2e)
/// ```
///
/// `p` is the semi-latus rectum in units of M and `e` the eccentricity. Note
/// the **`+ 2e`**: `k -> 1` there reproduces the separatrix `p = 6 + 2e`, which
/// is the check that the sign is the right way round. Getting it wrong gives an
/// expression that still looks plausible and still agrees with the weak field.
fn exact_precession(p: f64, e: f64) -> f64 {
    let denom = p - 6.0 + 2.0 * e;
    let modulus = (4.0 * e / denom).sqrt();
    4.0 * (p / denom).sqrt() * elliptic_k(modulus) - std::f64::consts::TAU
}

#[test]
fn integrated_precession_matches_the_exact_schwarzschild_formula() {
    // §4 already asks for "eccentric-orbit periapsis precession within 1% of
    // the analytic formula". Checked here against the *exact* elliptic result
    // rather than the weak-field 6 pi M / p, because the interesting orbits
    // this milestone unlocks are nowhere near the weak field: at p = 60,
    // e = 0.01 the two differ by 8%, so agreeing with 6 pi M / p to 1% would
    // actually mean the integration was wrong.
    let metric = schwarzschild();
    for &(p, e) in &[(60.0, 0.01), (40.0, 0.2), (20.0, 0.3), (12.0, 0.15)] {
        let r_peri = p / (1.0 + e);
        let r_apo = p / (1.0 - e);
        let w = integrate_worldline(
            &metric,
            DropSpec::FromApsides { r_apo, r_peri },
            &WorldlineOptions {
                max_steps: 800_000,
                max_samples: 200_000,
                ..Default::default()
            },
        );

        let measured = w
            .precession_per_orbit()
            .expect("expected at least two periapsis passages");
        let expected = exact_precession(p, e);
        assert!(
            (measured - expected).abs() / expected < 0.01,
            "p={p}, e={e}: precession {measured} vs exact {expected}"
        );
    }
}

#[test]
fn inner_turning_point_agrees_with_the_requested_periapsis() {
    // The solver's own round trip: constants derived from (r_p, r_a) must give
    // r_p back when the cubic is deflated by r_a.
    for &(r_peri, r_apo) in &[(8.0, 20.0), (5.0, 400.0), (15.0, 15.5)] {
        let (energy, l) = constants_from_turning_points(M, 0.0, r_peri, r_apo).unwrap();
        let recovered = inner_turning_point(M, 0.0, energy, l, r_apo).unwrap();
        assert!(
            (recovered - r_peri).abs() < 1e-9,
            "recovered {recovered} for requested {r_peri}"
        );
    }
}
