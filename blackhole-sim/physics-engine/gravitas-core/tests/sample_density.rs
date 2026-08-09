//! Spec §6.3 / §1.6: the stored worldline has to be dense enough to *draw*.
//!
//! wiki-globe fork. Integration accuracy and output resolution are different
//! things, and this suite exists because the fork had the first without the
//! second. The conserved quantities were clean to 1e-10 while consecutive
//! stored samples sat 46 degrees of orbital phase apart, because a bound orbit
//! neither escapes nor falls in and so ran until `max_steps` was exhausted —
//! 1162 revolutions for the drop below — with `max_samples` then thinned
//! across all of them.
//!
//! Nothing in the physics notices. Everything that reads the samples back
//! does: the trail polyline chords between them and renders as an octagon,
//! and the 1st-person view takes its frame from the *nearest* sample, so the
//! rider's orientation snapped by tens of degrees at a time.

use gravitas::metric::Kerr;
use gravitas::physics::worldline::{
    integrate_worldline, DropSpec, Worldline, WorldlineEnd, WorldlineOptions,
};

const M: f64 = 1.0;

fn run(drop: DropSpec, opts: WorldlineOptions) -> Worldline {
    integrate_worldline(&Kerr::kerr_schild(M, 0.0), drop, &opts)
}

/// Largest and median jump in azimuth between consecutive stored samples,
/// in degrees — the chord the renderer has to bridge.
fn sample_gaps_deg(w: &Worldline) -> (f64, f64) {
    let mut gaps: Vec<f64> = w
        .samples
        .windows(2)
        .map(|p| {
            let mut d = p[1].phi - p[0].phi;
            while d > std::f64::consts::PI {
                d -= std::f64::consts::TAU;
            }
            while d < -std::f64::consts::PI {
                d += std::f64::consts::TAU;
            }
            d.abs().to_degrees()
        })
        .collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = gaps.len();
    assert!(n > 0, "worldline has no gaps to measure");
    (gaps[n / 2], gaps[n - 1])
}

#[test]
fn a_bound_orbit_stops_after_max_orbits_instead_of_burning_the_step_budget() {
    let w = run(
        DropSpec::FromApsides {
            r_apo: 20.0 * M,
            r_peri: 5.5 * M,
        },
        WorldlineOptions {
            max_samples: 8_000,
            ..Default::default()
        },
    );

    assert_eq!(
        w.end,
        WorldlineEnd::CompletedOrbits,
        "expected the orbit cap to end the run, got {:?}",
        w.end
    );

    let orbits = w.total_azimuth().abs() / std::f64::consts::TAU;
    assert!(
        (30.0..=34.0).contains(&orbits),
        "expected ~32 revolutions, swept {orbits:.1}"
    );
}

#[test]
fn stored_samples_are_dense_enough_to_render_as_a_curve() {
    // The screenshot that started this: apo 20 M, peri 5.5 M, drawn as an
    // octagon. At 46 degrees per sample a polyline cannot be anything else.
    let w = run(
        DropSpec::FromApsides {
            r_apo: 20.0 * M,
            r_peri: 5.5 * M,
        },
        WorldlineOptions {
            max_samples: 8_000,
            ..Default::default()
        },
    );

    let (median, worst) = sample_gaps_deg(&w);
    assert!(
        median < 3.0,
        "median gap between samples {median:.2} deg — the trail will look polygonal"
    );
    // Periapsis is both the fastest-sweeping part of the orbit and the part
    // with the interesting curvature, so the worst gap lands there.
    assert!(
        worst < 10.0,
        "worst gap between samples {worst:.2} deg (near periapsis)"
    );
}

#[test]
fn density_holds_for_a_near_circular_orbit_too() {
    let w = run(
        DropSpec::Circular { r: 8.0 * M },
        WorldlineOptions {
            max_samples: 8_000,
            ..Default::default()
        },
    );
    let (median, worst) = sample_gaps_deg(&w);
    assert!(median < 3.0, "median gap {median:.2} deg");
    assert!(worst < 10.0, "worst gap {worst:.2} deg");
}

#[test]
fn the_cap_does_not_truncate_a_plunge() {
    // A radial fall sweeps no azimuth at all, so the orbit cap must never be
    // what ends it — it has to reach the inner radius.
    let w = run(
        DropSpec::RadialFall { r: 20.0 * M },
        WorldlineOptions {
            inner_radius: 0.04 * M,
            max_steps: 800_000,
            ..Default::default()
        },
    );
    assert_eq!(w.end, WorldlineEnd::ReachedInnerRadius);
}

#[test]
fn the_cap_can_be_lifted_for_physics_that_needs_a_long_run() {
    // Precession measurements and the §4 conservation checks integrate for
    // their own reasons; the default is a rendering choice, not a physical
    // limit, and must stay overridable.
    let w = run(
        DropSpec::Circular { r: 8.0 * M },
        WorldlineOptions {
            max_orbits: 200.0,
            max_steps: 2_000_000,
            ..Default::default()
        },
    );
    let orbits = w.total_azimuth().abs() / std::f64::consts::TAU;
    assert!(orbits > 100.0, "only swept {orbits:.1} revolutions");
}
