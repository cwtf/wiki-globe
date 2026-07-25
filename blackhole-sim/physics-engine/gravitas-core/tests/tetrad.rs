//! Spec §1.6 / §5: the 1st-person observer's local frame.
//!
//! wiki-globe fork. §5 says the 1st-person view "lives or dies on the tetrad",
//! so these tests check the property everything else depends on — that the
//! frame really is orthonormal, `g(e_a, e_b) = eta_ab` — at every radius the
//! rider passes through, **including inside the horizon**.

use gravitas::metric::{Kerr, Metric, Orbit};
use gravitas::physics::tetrad::{
    aberrate, build_tetrad, dot, four_velocity, tetrad_from_velocity, ETA,
};
use gravitas::physics::worldline::{
    initial_state, integrate_worldline, DropSpec, WorldlineOptions,
};

const M: f64 = 1.0;
const TOL: f64 = 1e-9;

fn schwarzschild() -> Kerr {
    Kerr::kerr_schild(M, 0.0)
}

#[test]
fn frame_is_orthonormal_on_a_circular_orbit() {
    let bh = schwarzschild();
    let state = initial_state(&bh, DropSpec::Circular { r: 10.0 * M });
    let t = build_tetrad(&state, &bh);

    let err = t.orthonormality_error(&bh, state.x[1], state.x[2]);
    assert!(err < TOL, "orthonormality error {err:.3e}");
}

#[test]
fn frame_is_orthonormal_at_every_radius_including_inside_the_horizon() {
    // The payoff case. A frame built by boosting a *static* observer would
    // have no definition at all inside r_h, where no static observer exists;
    // this one has to stay orthonormal all the way down.
    let bh = schwarzschild();
    let w = integrate_worldline(
        &bh,
        DropSpec::RadialFall { r: 20.0 * M },
        &WorldlineOptions {
            inner_radius: 0.05 * M,
            max_steps: 400_000,
            max_samples: 400,
            ..Default::default()
        },
    );

    let r_h = bh.event_horizon();
    let mut checked_inside = 0;

    for sample in &w.samples {
        // Use the 4-velocity the integrator actually carried to this point.
        // Constructing a fresh "dropped from rest at r" state instead would be
        // meaningless inside the horizon, where nothing can be at rest.
        let t = tetrad_from_velocity(&bh, sample.r, sample.theta, &sample.u);
        let err = t.orthonormality_error(&bh, sample.r, sample.theta);
        assert!(
            err < 1e-8,
            "orthonormality error {err:.3e} at r = {:.4} (r_h = {r_h:.3})",
            sample.r
        );
        if sample.r < r_h {
            checked_inside += 1;
        }
    }

    assert!(
        checked_inside > 0,
        "expected to check at least one radius inside the horizon"
    );
}

#[test]
fn time_leg_is_the_observers_four_velocity() {
    // e_0 must BE the object's 4-velocity, normalised. If it drifted from it,
    // the 1st-person view would be riding something other than the object.
    let bh = schwarzschild();
    let state = initial_state(&bh, DropSpec::Circular { r: 12.0 * M });
    let t = build_tetrad(&state, &bh);
    let u = four_velocity(&state, &bh);

    let norm = (-dot(&bh, state.x[1], state.x[2], &u, &u)).sqrt();
    for mu in 0..4 {
        assert!(
            (t.e[0][mu] - u[mu] / norm).abs() < 1e-10,
            "e_0 component {mu} disagrees with u: {} vs {}",
            t.e[0][mu],
            u[mu] / norm
        );
    }
}

#[test]
fn time_leg_is_timelike_and_spatial_legs_are_spacelike() {
    let bh = Kerr::kerr_schild(M, 0.7);
    let state = initial_state(&bh, DropSpec::Circular { r: 9.0 * M });
    let t = build_tetrad(&state, &bh);
    let (r, th) = (state.x[1], state.x[2]);

    assert!(dot(&bh, r, th, &t.e[0], &t.e[0]) < 0.0, "e_0 must be timelike");
    for a in 1..4 {
        assert!(
            dot(&bh, r, th, &t.e[a], &t.e[a]) > 0.0,
            "e_{a} must be spacelike"
        );
    }
}

#[test]
fn projecting_then_lifting_round_trips() {
    // project() and lift() must be inverses, or rays generated in the frame
    // would not come back as the coordinate directions they represent.
    let bh = Kerr::kerr_schild(M, 0.5);
    let state = initial_state(&bh, DropSpec::Circular { r: 15.0 * M });
    let t = build_tetrad(&state, &bh);
    let (r, th) = (state.x[1], state.x[2]);

    let v = [0.3, -1.2, 0.05, 0.7];
    let local = t.project(&bh, r, th, &v);
    let back = t.lift(&local);
    for mu in 0..4 {
        assert!(
            (back[mu] - v[mu]).abs() < 1e-9,
            "component {mu}: {} vs {}",
            back[mu],
            v[mu]
        );
    }
}

#[test]
fn the_observer_measures_its_own_velocity_as_purely_temporal() {
    // In its own frame the object is at rest: u has components (1,0,0,0).
    // This is the definition of a comoving frame, and it is what makes
    // aberration come out right without any explicit aberration code.
    let bh = schwarzschild();
    let state = initial_state(&bh, DropSpec::Circular { r: 8.0 * M });
    let t = build_tetrad(&state, &bh);
    let u = four_velocity(&state, &bh);

    let local = t.project(&bh, state.x[1], state.x[2], &u);
    assert!((local[0] - 1.0).abs() < 1e-9, "u^(0) should be 1, got {}", local[0]);
    for a in 1..4 {
        assert!(
            local[a].abs() < 1e-9,
            "u^({a}) should vanish in the comoving frame, got {}",
            local[a]
        );
    }
}

#[test]
fn a_null_ray_stays_null_in_the_frame() {
    // A photon must have |spatial| = |temporal| in ANY orthonormal frame.
    // If this failed, per-ray colour shifts computed from the frame would be
    // meaningless.
    let bh = schwarzschild();
    let state = initial_state(&bh, DropSpec::Circular { r: 10.0 * M });
    let t = build_tetrad(&state, &bh);
    let (r, th) = (state.x[1], state.x[2]);

    // Build a null vector by lifting a null direction out of the frame.
    for dir in &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.6, 0.8, 0.0]] {
        let local = [1.0, dir[0], dir[1], dir[2]];
        let p = t.lift(&local);
        let norm = dot(&bh, r, th, &p, &p);
        assert!(
            norm.abs() < 1e-9,
            "lifted null ray should have zero norm, got {norm:.3e}"
        );
    }
}

#[test]
fn orbital_motion_blueshifts_light_from_ahead() {
    // The observed frequency must depend on where the light comes from
    // relative to the motion -- that asymmetry IS the Doppler shift, and it
    // has to emerge from the frame rather than from an explicit formula.
    let bh = schwarzschild();
    let state = initial_state(&bh, DropSpec::Circular { r: 8.0 * M });
    let t = build_tetrad(&state, &bh);
    let (r, th) = (state.x[1], state.x[2]);

    // The photons must be defined by something OTHER than the orbiting frame,
    // or the comparison is circular: any photon lifted out of that frame with
    // unit time component is by definition seen at unit frequency.
    //
    // So emit them from a STATIC observer at the same radius -- the starfield
    // is at rest -- with equal frequency for that observer, then ask what the
    // orbiting observer measures.
    let static_state = initial_state(
        &bh,
        DropSpec::Custom {
            r: 8.0 * M,
            tangential_fraction: 0.0,
            radial_velocity: 0.0,
        },
    );
    let s = build_tetrad(&static_state, &bh);

    // Which spatial leg is "the direction of travel" depends on the order
    // Gram-Schmidt happened to fill the frame in, so derive it instead of
    // assuming: project the orbiting observer's 4-velocity into the static
    // frame and read off its spatial part.
    let u_orbit = four_velocity(&state, &bh);
    let in_static = s.project(&bh, r, th, &u_orbit);
    let speed = (in_static[1] * in_static[1]
        + in_static[2] * in_static[2]
        + in_static[3] * in_static[3])
        .sqrt();
    assert!(speed > 1e-6, "the orbiting observer must be moving in the static frame");
    let d = [
        in_static[1] / speed,
        in_static[2] / speed,
        in_static[3] / speed,
    ];

    // A photon met head-on propagates opposite to the observer's motion; one
    // overtaking from behind propagates with it.
    let ahead = s.lift(&[1.0, -d[0], -d[1], -d[2]]);
    let behind = s.lift(&[1.0, d[0], d[1], d[2]]);

    // Equal frequency in the emitters' own frame, by construction.
    let f_static_ahead = s.observed_frequency(&bh, r, th, &ahead);
    let f_static_behind = s.observed_frequency(&bh, r, th, &behind);
    assert!((f_static_ahead - f_static_behind).abs() < 1e-12);

    let f_ahead = t.observed_frequency(&bh, r, th, &ahead);
    let f_behind = t.observed_frequency(&bh, r, th, &behind);

    assert!(f_ahead > 0.0 && f_behind > 0.0);
    assert!(
        f_ahead > f_static_ahead,
        "light met head-on must be blueshifted: {f_ahead} vs {f_static_ahead}"
    );
    assert!(
        f_behind < f_static_behind,
        "light overtaking from behind must be redshifted: {f_behind} vs {f_static_behind}"
    );
    assert!(
        f_ahead > f_behind,
        "the asymmetry is the Doppler shift and must not vanish"
    );
}

#[test]
fn aberration_formula_matches_the_relativistic_result() {
    // The closed form used for verification, not in the render path.
    assert!((aberrate(1.0, 0.5) - 1.0).abs() < 1e-12, "forward stays forward");
    assert!((aberrate(-1.0, 0.5) + 1.0).abs() < 1e-12, "backward stays backward");

    // Light arriving from the side is swung forward by the motion: this is
    // why the sky compresses ahead of you at high speed.
    let beta = 0.8;
    let side = aberrate(0.0, beta);
    assert!((side - beta).abs() < 1e-12, "cos 90deg aberrates to beta");
    assert!(side > 0.0, "the sky must compress toward the direction of travel");
}

#[test]
fn frame_survives_a_near_extremal_spinning_hole() {
    // Frame dragging is strongest here, and g_{t phi} is large; the
    // Gram-Schmidt must still produce an orthonormal basis.
    let bh = Kerr::kerr_schild(M, 0.999);
    let isco = bh.isco(Orbit::Prograde);
    let state = initial_state(&bh, DropSpec::Circular { r: isco * 1.2 });
    let t = build_tetrad(&state, &bh);

    let err = t.orthonormality_error(&bh, state.x[1], state.x[2]);
    assert!(err < 1e-8, "near-extremal orthonormality error {err:.3e}");
}

#[test]
fn eta_signature_is_the_one_the_projection_assumes() {
    // Guards the sign convention that project() depends on.
    assert_eq!(ETA, [-1.0, 1.0, 1.0, 1.0]);
}
