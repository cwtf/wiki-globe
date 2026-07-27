//! Test-object worldlines: timelike geodesics parameterised by proper time.
//!
//! wiki-globe fork, spec §1.5. `plunge.rs` shipped the ISCO entry state and
//! noted that "the integrated timelike geodesic ... is its own change" — this
//! is that change, generalised from the ISCO plunge to an arbitrary dropped
//! test object.
//!
//! Three things this needs that [`crate::geodesic::integrate`] does not give:
//!
//! 1. **Proper time.** With the timelike normalisation H = −1/2 the affine
//!    parameter *is* proper time τ, but `AdaptiveStepper::step` returns the
//!    *next* recommended step rather than the one it accepted, so τ cannot be
//!    accumulated through it. The loop below drives [`adaptive_rkf45_step`]
//!    directly and therefore knows exactly how far each accepted step moved.
//! 2. **Both clocks per sample.** §1.6 requires the 3rd-person view to sample
//!    the worldline by coordinate time t and the 1st-person view to sample the
//!    *same* stored worldline by proper time τ — integrating twice would let
//!    the two views drift apart. Every sample therefore carries (τ, t).
//! 3. **Crossing the horizon.** `integrate` stops at r < r_h·1.001. In
//!    Kerr-Schild coordinates nothing is singular there, so the termination
//!    radius here is a caller-chosen parameter that can be pushed to
//!    ~0.02 r_s, near the singularity.
//!
//! Everything runs in **Kerr-Schild** coordinates end-to-end (spec §5): pass a
//! metric built with [`Kerr::kerr_schild`]. Boyer-Lindquist would blow up at
//! the horizon and make the crossing unrepresentable.

use crate::geodesic::{adaptive_rkf45_step, GeodesicState};
use crate::invariants::renormalize_timelike;
use crate::metric::{Kerr, Metric, Orbit};
use crate::physics::plunge::circular_angular_velocity;

/// One recorded point on the worldline.
///
/// Both clocks are stored so the two camera views can sample the same
/// trajectory by different parameters (spec §1.6).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct WorldlineSample {
    /// Proper time along the worldline (the object's own clock). Finite
    /// through the horizon; this is what the 1st-person view advances by.
    pub tau: f64,
    /// Kerr-Schild coordinate time. **Regular at the horizon** — an infalling
    /// object crosses in finite `t`, because that is exactly what makes these
    /// coordinates horizon-penetrating.
    pub t: f64,
    /// Schwarzschild / Boyer-Lindquist time: the clock of a static observer
    /// at infinity. **This** is the one that diverges at the horizon, and so
    /// the one the 3rd-person view must sample by if the object is to be seen
    /// freezing and never crossing (spec §1.6). See [`distant_observer_time`].
    pub t_far: f64,
    pub r: f64,
    pub theta: f64,
    pub phi: f64,
    /// Contravariant 4-velocity u^mu at this sample.
    ///
    /// Needed because the 1st-person view builds its orthonormal frame from
    /// the object's own 4-velocity (see `physics::tetrad`), and that frame has
    /// to be reconstructable at any point on the stored worldline — not just
    /// at the end. Positions alone are not enough: re-deriving u from
    /// neighbouring samples would be a finite-difference approximation of a
    /// quantity the integrator already knows exactly.
    pub u: [f64; 4],
}

/// Convert Kerr-Schild time to the distant static observer's (Boyer-Lindquist)
/// time at radius `r`:
///
/// ```text
///   t_BL = t_KS - integral( 2Mr / Delta ) dr,   Delta = r^2 - 2Mr + a^2
/// ```
///
/// Evaluated in closed form by partial fractions over the two horizon roots.
/// The integral diverges logarithmically as r approaches r_+, which is
/// precisely the "frozen at the horizon" effect: infinite distant-observer
/// time for a finite amount of the object's own time.
///
/// Returns `f64::INFINITY` at or inside the horizon, where no static observer
/// exists and the notion of distant-observer time stops being defined.
#[must_use]
pub fn distant_observer_time(t_ks: f64, r: f64, m: f64, a: f64) -> f64 {
    let disc = m * m - a * a;
    if disc <= 0.0 {
        // Extremal: the two roots merge and the integral changes form. Not
        // needed for the spec's a = 0 targets; report the raw KS time rather
        // than a wrong closed form.
        return t_ks;
    }
    let root = disc.sqrt();
    let r_plus = m + root;
    let r_minus = m - root;

    if r <= r_plus {
        return f64::INFINITY;
    }

    // 2Mr/((r - r+)(r - r-)) = A/(r - r+) + B/(r - r-)
    let a_coef = 2.0 * m * r_plus / (r_plus - r_minus);
    let b_coef = -2.0 * m * r_minus / (r_plus - r_minus);

    let integral = a_coef * (r - r_plus).abs().ln()
        + if r_minus.abs() < f64::EPSILON {
            0.0
        } else {
            b_coef * (r - r_minus).abs().ln()
        };

    t_ks - integral
}

/// Why the integration stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorldlineEnd {
    /// Reached the caller's inner termination radius.
    ReachedInnerRadius,
    /// Left the caller's outer radius.
    Escaped,
    /// Ran out of step budget (an orbit that neither escaped nor fell in).
    StepBudget,
    /// The state could not be held on the H = −1/2 shell.
    NormalizationFailure,
}

/// An integrated test-object trajectory plus its conservation audit.
#[derive(Clone, Debug)]
pub struct Worldline {
    pub samples: Vec<WorldlineSample>,
    /// Conserved energy E = −p_t at the drop.
    pub energy: f64,
    /// Conserved axial angular momentum L_z = p_φ at the drop.
    pub angular_momentum: f64,
    /// Largest |E(τ) − E₀| seen. Spec §1.5 wants this below 1e-6.
    pub max_energy_drift: f64,
    /// Largest |L_z(τ) − L_z₀| seen.
    pub max_angular_momentum_drift: f64,
    pub end: WorldlineEnd,
    /// Total proper time elapsed.
    pub proper_time: f64,
    /// Total coordinate time elapsed.
    pub coordinate_time: f64,
}

impl Worldline {
    /// Whether both conserved quantities stayed inside `tol`.
    #[must_use]
    pub fn conserved_within(&self, tol: f64) -> bool {
        self.max_energy_drift < tol && self.max_angular_momentum_drift < tol
    }

    /// Net azimuth swept, unwrapped across the ±π branch cut.
    ///
    /// φ is recorded as the integrator produces it; this folds the samples
    /// into a monotonic total so orbit counts and precession are measurable.
    #[must_use]
    pub fn total_azimuth(&self) -> f64 {
        let mut total = 0.0;
        for w in self.samples.windows(2) {
            let mut d = w[1].phi - w[0].phi;
            while d > std::f64::consts::PI {
                d -= std::f64::consts::TAU;
            }
            while d < -std::f64::consts::PI {
                d += std::f64::consts::TAU;
            }
            total += d;
        }
        total
    }

    /// Radii at which dr/dτ changes sign from inward to outward, i.e. the
    /// periapsis passages. Used to measure orbital precession.
    #[must_use]
    pub fn periapsis_indices(&self) -> Vec<usize> {
        let mut out = Vec::new();
        for i in 1..self.samples.len().saturating_sub(1) {
            let (a, b, c) = (
                self.samples[i - 1].r,
                self.samples[i].r,
                self.samples[i + 1].r,
            );
            if b <= a && b < c {
                out.push(i);
            }
        }
        out
    }

    /// Smallest radius reached. For a bound orbit this is the measured
    /// periapsis — the number spec §6.3's test compares against the requested
    /// one, because agreeing with the *integrated* trajectory is the only
    /// claim worth making about a solver that feeds it.
    #[must_use]
    pub fn min_radius(&self) -> f64 {
        self.samples
            .iter()
            .map(|s| s.r)
            .fold(f64::INFINITY, f64::min)
    }

    /// Largest radius reached, i.e. the measured apoapsis.
    #[must_use]
    pub fn max_radius(&self) -> f64 {
        self.samples
            .iter()
            .map(|s| s.r)
            .fold(f64::NEG_INFINITY, f64::max)
    }

    /// Azimuth, unwrapped to a monotonic total, sample by sample.
    #[must_use]
    pub fn unwrapped_azimuth(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.samples.len());
        let mut acc = 0.0;
        out.push(acc);
        for pair in self.samples.windows(2) {
            let mut d = pair[1].phi - pair[0].phi;
            while d > std::f64::consts::PI {
                d -= std::f64::consts::TAU;
            }
            while d < -std::f64::consts::PI {
                d += std::f64::consts::TAU;
            }
            acc += d;
            out.push(acc);
        }
        out
    }

    /// Mean periapsis advance per orbit, in radians.
    ///
    /// A nearly circular orbit turns the precession into a small difference of
    /// large angles (φ_periapsis spacing ≈ 2π + δ), so taking the periapsis at
    /// the nearest *sample* injects an error far larger than δ itself. Each
    /// passage is therefore refined by fitting a parabola through the three
    /// samples bracketing the minimum of r and evaluating φ at its vertex, and
    /// the result is averaged across every consecutive pair.
    ///
    /// Returns `None` if fewer than two periapsis passages were recorded.
    #[must_use]
    pub fn precession_per_orbit(&self) -> Option<f64> {
        let peris = self.periapsis_indices();
        if peris.len() < 2 {
            return None;
        }
        let phi = self.unwrapped_azimuth();

        let refined: Vec<f64> = peris
            .iter()
            .filter_map(|&i| {
                if i == 0 || i + 1 >= self.samples.len() {
                    return None;
                }
                let (r0, r1, r2) = (
                    self.samples[i - 1].r,
                    self.samples[i].r,
                    self.samples[i + 1].r,
                );
                let (p0, p1, p2) = (phi[i - 1], phi[i], phi[i + 1]);

                // Vertex of the parabola through (p, r), in units of the local
                // spacing; guard the degenerate collinear case.
                let denom = r0 - 2.0 * r1 + r2;
                if denom.abs() < 1e-18 {
                    return Some(p1);
                }
                let offset = 0.5 * (r0 - r2) / denom;
                // offset is in index units; map it onto phi by local spacing.
                let spacing = if offset >= 0.0 { p2 - p1 } else { p1 - p0 };
                Some(p1 + offset.abs() * spacing * offset.signum())
            })
            .collect();

        if refined.len() < 2 {
            return None;
        }

        let mut total = 0.0;
        for pair in refined.windows(2) {
            total += (pair[1] - pair[0]).abs() - std::f64::consts::TAU;
        }
        Some(total / (refined.len() - 1) as f64)
    }
}

/// How the object is launched. All variants are equatorial (θ = π/2).
#[derive(Clone, Copy, Debug)]
pub enum DropSpec {
    /// Stable circular orbit at `r`. Spec §1.5 preset.
    Circular { r: f64 },
    /// The ISCO knife-edge, seeded with a tiny inward nudge so it plunges.
    Isco { inward_seed: f64 },
    /// Released from rest at `r` with no angular momentum: radial free fall.
    RadialFall { r: f64 },
    /// Launched at apoapsis `r` with a fraction of the local circular
    /// angular velocity. `tangential_fraction` < 1 gives a bound eccentric
    /// orbit whose periapsis precesses.
    Eccentric {
        r: f64,
        tangential_fraction: f64,
    },
    /// Fully manual: fraction of the local circular angular velocity plus a
    /// radial velocity dr/dt, both at radius `r`.
    Custom {
        r: f64,
        tangential_fraction: f64,
        radial_velocity: f64,
    },
    /// Named by its two turning points (spec §6.3, milestone 9).
    ///
    /// Released at `r_apo` with dr/dτ = 0 and the angular momentum that puts
    /// the periapsis at `r_peri`. If no bound orbit can reach that periapsis
    /// from that apoapsis — i.e. it is inside the separatrix — the object
    /// plunges rather than being quietly clamped to the nearest orbit that
    /// works; see [`crate::physics::apsides::solve_apsides`].
    FromApsides { r_apo: f64, r_peri: f64 },
}

/// Integration controls for a worldline.
#[derive(Clone, Copy, Debug)]
pub struct WorldlineOptions {
    /// Stop when r falls below this. Defaults to just outside the horizon;
    /// push toward 0.02·r_s to follow the object to the singularity.
    pub inner_radius: f64,
    /// Stop when r exceeds this.
    pub outer_radius: f64,
    pub max_steps: usize,
    pub tolerance: f64,
    pub initial_step: f64,
    pub min_step: f64,
    pub max_step: f64,
    /// Re-project onto the H = −1/2 shell every N accepted steps.
    pub renormalize_interval: usize,
    /// Keep at most this many samples, thinning uniformly in step count.
    pub max_samples: usize,
}

impl Default for WorldlineOptions {
    fn default() -> Self {
        Self {
            inner_radius: 0.0, // replaced with r_h·1.001 by `integrate_worldline`
            outer_radius: 1.0e4,
            max_steps: 200_000,
            tolerance: 1e-10,
            initial_step: 1e-3,
            min_step: 1e-8,
            max_step: 5.0,
            renormalize_interval: 10,
            max_samples: 20_000,
        }
    }
}

/// Build the initial phase-space state for a drop.
///
/// Constructed from the **contravariant** 4-velocity and then lowered with the
/// metric, rather than writing p_μ directly. That matters in Kerr-Schild: a
/// circular orbit has dr/dτ = 0, so u^r = 0 — but g_tr ≠ 0 there, so p_r is
/// *not* zero. Writing p_r = 0 (correct in Boyer-Lindquist) would launch a
/// subtly wrong orbit.
#[must_use]
pub fn initial_state(metric: &Kerr, drop: DropSpec) -> GeodesicState {
    let theta = std::f64::consts::FRAC_PI_2;
    let m = metric.mass();
    let a = metric.a();

    // Apsides are specified by conserved quantities, not by an angular
    // velocity, so this branch writes p_mu straight down instead of going
    // through (omega, u_r). That is deliberate: E = -p_t and L_z = p_phi are
    // the *same numbers* in Boyer-Lindquist and Kerr-Schild, because the two
    // systems share the Killing vectors d/dt and d/dphi, whereas
    // Omega = dphi/dt is not. Converting a Boyer-Lindquist Omega into these
    // coordinates is exactly the kind of quiet coordinate mixing spec §5
    // warns about.
    if let DropSpec::FromApsides { r_apo, r_peri } = drop {
        let solution = crate::physics::apsides::solve_apsides(metric, r_peri, r_apo);
        let r = solution.apoapsis;

        let p_t = -solution.energy;
        let p_phi = solution.angular_momentum;

        // Released at the apoapsis, so u^r = g^{r mu} p_mu = 0. Solving that
        // for p_r is one division; note p_r is NOT zero in Kerr-Schild, where
        // g^{rt} != 0 — writing p_r = 0 (correct in Boyer-Lindquist) would
        // launch a subtly different orbit, the same trap the comment above
        // this function records for circular drops.
        let inverse = metric.contravariant(r, theta);
        let gi = inverse.as_array();
        let (g_rt, g_rr, g_rp) = (gi[4], gi[5], gi[7]);
        let p_r = if g_rr.abs() > 1e-15 {
            -(g_rt * p_t + g_rp * p_phi) / g_rr
        } else {
            0.0
        };

        return GeodesicState {
            x: [0.0, r, theta, 0.0],
            p: [p_t, p_r, 0.0, p_phi],
        };
    }

    let (r, omega, u_r) = match drop {
        DropSpec::Circular { r } => (r, circular_angular_velocity(r, m, a, Orbit::Prograde), 0.0),
        DropSpec::Isco { inward_seed } => {
            let r = metric.isco(Orbit::Prograde);
            (
                r,
                circular_angular_velocity(r, m, a, Orbit::Prograde),
                -inward_seed.abs(),
            )
        }
        // "Radial" must mean zero angular momentum, not zero angular velocity.
        // Around a spinning hole those differ: holding u^phi = 0 leaves
        // p_phi = g_{t phi} u^t != 0, so the object carries angular momentum it
        // was never given. Solving p_phi = 0 instead gives the ZAMO angular
        // velocity, and the object is then dragged by the hole rather than by
        // the initial condition. Identical to omega = 0 at a = 0.
        DropSpec::RadialFall { r } => {
            let g0 = metric.covariant(r, theta);
            let ga0 = g0.as_array();
            let (g_tp0, g_pp0) = (ga0[3], ga0[15]);
            let omega_zamo = if g_pp0.abs() > 1e-12 {
                -g_tp0 / g_pp0
            } else {
                0.0
            };
            (r, omega_zamo, 0.0)
        }
        DropSpec::Eccentric {
            r,
            tangential_fraction,
        } => (
            r,
            circular_angular_velocity(r, m, a, Orbit::Prograde) * tangential_fraction,
            0.0,
        ),
        DropSpec::Custom {
            r,
            tangential_fraction,
            radial_velocity,
        } => (
            r,
            circular_angular_velocity(r, m, a, Orbit::Prograde) * tangential_fraction,
            radial_velocity,
        ),
        // Handled above, before this match, because it builds p_mu directly.
        DropSpec::FromApsides { .. } => unreachable!(),
    };

    // u^mu proportional to (1, u_r, 0, omega); the normalisation N follows from
    // g_{mu nu} u^mu u^nu = -1.
    let g = metric.covariant(r, theta);
    let ga = g.as_array();
    let (g_tt, g_tr, g_tp) = (ga[0], ga[1], ga[3]);
    let (g_rr, g_rp) = (ga[5], ga[7]);
    let g_pp = ga[15];

    let quad = g_tt
        + 2.0 * g_tr * u_r
        + 2.0 * g_tp * omega
        + g_rr * u_r * u_r
        + 2.0 * g_rp * u_r * omega
        + g_pp * omega * omega;

    // quad must be negative for the direction to be timelike; if the caller
    // asked for something superluminal, fall back to a static observer so the
    // integrator gets a valid state rather than a NaN.
    let n = if quad < -1e-12 {
        (-1.0 / quad).sqrt()
    } else {
        (-1.0 / g_tt).sqrt()
    };

    let u = [n, n * u_r, 0.0, n * omega];

    // p_mu = g_{mu nu} u^nu
    let p_t = g_tt * u[0] + g_tr * u[1] + g_tp * u[3];
    let p_r = g_tr * u[0] + g_rr * u[1] + g_rp * u[3];
    let p_theta = 0.0;
    let p_phi = g_tp * u[0] + g_rp * u[1] + g_pp * u[3];

    GeodesicState {
        x: [0.0, r, theta, 0.0],
        p: [p_t, p_r, p_theta, p_phi],
    }
}

/// Integrate a dropped test object, recording proper and coordinate time.
///
/// The adaptive accept/reject loop is written out here rather than reusing
/// `AdaptiveStepper` because the accepted step size is exactly the proper-time
/// increment, and the stepper does not expose it.
pub fn integrate_worldline(
    metric: &Kerr,
    drop: DropSpec,
    options: &WorldlineOptions,
) -> Worldline {
    let mut state = initial_state(metric, drop);

    let inner = if options.inner_radius > 0.0 {
        options.inner_radius
    } else {
        metric.event_horizon() * 1.001
    };

    let mut worldline = Worldline {
        samples: Vec::new(),
        energy: -state.p[0],
        angular_momentum: state.p[3],
        max_energy_drift: 0.0,
        max_angular_momentum_drift: 0.0,
        end: WorldlineEnd::StepBudget,
        proper_time: 0.0,
        coordinate_time: 0.0,
    };

    if renormalize_timelike(&mut state, metric).is_err() {
        worldline.end = WorldlineEnd::NormalizationFailure;
        return worldline;
    }

    // Re-read the conserved quantities after the initial projection onto the
    // mass shell, so drift is measured against the state actually integrated.
    worldline.energy = -state.p[0];
    worldline.angular_momentum = state.p[3];

    let mut tau = 0.0f64;
    let mut h = options.initial_step;

    let m = metric.mass();
    let a = metric.a();
    let sample_at = |tau: f64, s: &GeodesicState| WorldlineSample {
        tau,
        t: s.x[0],
        t_far: distant_observer_time(s.x[0], s.x[1], m, a),
        r: s.x[1],
        theta: s.x[2],
        phi: s.x[3],
        u: crate::physics::tetrad::four_velocity(s, metric),
    };

    worldline.samples.push(sample_at(tau, &state));

    for step in 0..options.max_steps {
        let r = state.x[1];
        if r <= inner {
            worldline.end = WorldlineEnd::ReachedInnerRadius;
            break;
        }
        if r >= options.outer_radius {
            worldline.end = WorldlineEnd::Escaped;
            break;
        }

        // --- adaptive accept/reject, tracking the accepted step ---
        let mut trial = h.clamp(options.min_step, options.max_step);
        let accepted;
        loop {
            let (next, err) = adaptive_rkf45_step(&state, metric, trial);
            let ratio = if err == 0.0 { 0.0 } else { err / options.tolerance };

            if ratio <= 1.0 {
                state = next;
                accepted = trial;
                let growth = if ratio < 1e-4 {
                    5.0
                } else {
                    0.9 * ratio.powf(-0.2)
                };
                h = (trial * growth.min(5.0)).clamp(options.min_step, options.max_step);
                break;
            }

            let shrink = (0.9 * ratio.powf(-0.25)).max(0.1);
            trial *= shrink;

            if trial <= options.min_step {
                // Forced step at the floor: accept it so a hard region cannot
                // stall the integration forever.
                let (forced, _) = adaptive_rkf45_step(&state, metric, options.min_step);
                state = forced;
                accepted = options.min_step;
                h = options.min_step;
                break;
            }
        }

        tau += accepted;

        if step % options.renormalize_interval == 0
            && renormalize_timelike(&mut state, metric).is_err()
        {
            worldline.end = WorldlineEnd::NormalizationFailure;
            break;
        }

        let e_now = -state.p[0];
        let l_now = state.p[3];
        worldline.max_energy_drift = worldline
            .max_energy_drift
            .max((e_now - worldline.energy).abs());
        worldline.max_angular_momentum_drift = worldline
            .max_angular_momentum_drift
            .max((l_now - worldline.angular_momentum).abs());

        // Record every accepted step, then thin once at the end. Striding by
        // `max_steps / max_samples` during the loop assumes the run consumes
        // its whole budget: a plunge that terminates after a few hundred steps
        // would come back with a handful of samples and a marker that jumps.
        worldline.samples.push(sample_at(tau, &state));
    }

    // Always record the final state, whatever ended the run.
    worldline.samples.push(sample_at(tau, &state));

    // Thin uniformly to the caller's cap, always keeping the endpoints.
    let cap = options.max_samples.max(2);
    if worldline.samples.len() > cap {
        let n = worldline.samples.len();
        let stride = n.div_ceil(cap);
        let mut thinned: Vec<WorldlineSample> =
            worldline.samples.iter().step_by(stride).copied().collect();
        if let Some(&last) = worldline.samples.last() {
            if thinned.last().map(|s| s.tau) != Some(last.tau) {
                thinned.push(last);
            }
        }
        worldline.samples = thinned;
    }
    worldline.proper_time = tau;
    worldline.coordinate_time = state.x[0];
    worldline
}

/// Closed-form Schwarzschild proper time for radial free fall from rest at
/// `r0` down to `r`, via the cycloid solution
///
/// ```text
///   r   = (r0/2)(1 + cos eta)
///   tau = sqrt(r0^3 / (8M)) (eta + sin eta)
/// ```
///
/// This is the §4 verification target for the radial-drop preset. It is the
/// object's own clock and stays finite through the horizon — the divergence
/// that freezes the object on the horizon lives in coordinate time, not here.
#[must_use]
pub fn radial_fall_proper_time(r0: f64, r: f64, m: f64) -> f64 {
    let c = (2.0 * r / r0 - 1.0).clamp(-1.0, 1.0);
    let eta = c.acos();
    (r0 * r0 * r0 / (8.0 * m)).sqrt() * (eta + eta.sin())
}
