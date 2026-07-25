//! Local orthonormal frames for an observer riding a worldline (spec §1.6).
//!
//! wiki-globe fork. §5 is blunt about why this module exists: "1st-person
//! correctness lives or dies on the tetrad: build it once (static frame +
//! boost), generate rays only through it. Ad-hoc per-effect 'redshift shaders'
//! are how it becomes a toy." So aberration, Doppler and gravitational shift
//! are never applied as separate effects — they are all consequences of
//! expressing the ray's 4-momentum in this basis.
//!
//! **Correction to the spec's construction.** §1.6 describes the frame as "the
//! static-observer frame boosted by the object's 4-velocity". That recipe
//! breaks exactly where the payoff is: inside the horizon **no static observer
//! exists**, so there is no frame to boost. Gram-Schmidt starting from the
//! object's own 4-velocity is well defined everywhere the object is, inside
//! the horizon included, and reduces to the same thing outside up to a spatial
//! rotation — which free-look absorbs anyway.

use crate::geodesic::GeodesicState;
use crate::metric::Metric;

/// An orthonormal frame carried by an observer.
///
/// `e[a][mu]` is the mu-th coordinate component of the a-th basis vector.
/// Row 0 is the observer's 4-velocity (timelike); rows 1-3 are the spatial
/// axes the observer calls "right", "up" and "forward".
#[derive(Clone, Copy, Debug)]
pub struct Tetrad {
    pub e: [[f64; 4]; 4],
}

/// Minkowski metric the tetrad diagonalises the metric into.
pub const ETA: [f64; 4] = [-1.0, 1.0, 1.0, 1.0];

/// Inner product `g_{mu nu} A^mu B^nu` of two contravariant vectors.
#[must_use]
pub fn dot<M: Metric>(metric: &M, r: f64, theta: f64, a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let g = metric.covariant(r, theta);
    let ga = g.as_array();
    let mut sum = 0.0;
    for (mu, &a_mu) in a.iter().enumerate() {
        for (nu, &b_nu) in b.iter().enumerate() {
            sum += ga[mu * 4 + nu] * a_mu * b_nu;
        }
    }
    sum
}

fn scale(v: &[f64; 4], s: f64) -> [f64; 4] {
    [v[0] * s, v[1] * s, v[2] * s, v[3] * s]
}

fn add_scaled(a: &[f64; 4], b: &[f64; 4], s: f64) -> [f64; 4] {
    [
        a[0] + b[0] * s,
        a[1] + b[1] * s,
        a[2] + b[2] * s,
        a[3] + b[3] * s,
    ]
}

/// Contravariant 4-velocity `u^mu = g^{mu nu} p_nu` of a state.
#[must_use]
pub fn four_velocity<M: Metric>(state: &GeodesicState, metric: &M) -> [f64; 4] {
    let g_inv = metric.contravariant(state.x[1], state.x[2]);
    let gi = g_inv.as_array();
    let p = &state.p;
    let mut u = [0.0; 4];
    for (mu, u_mu) in u.iter_mut().enumerate() {
        let mut sum = 0.0;
        for (nu, &p_nu) in p.iter().enumerate() {
            sum += gi[mu * 4 + nu] * p_nu;
        }
        *u_mu = sum;
    }
    u
}

/// Build the observer's orthonormal frame at a point on its worldline.
///
/// Gram-Schmidt with the metric as the inner product: the 4-velocity becomes
/// the time axis, then the coordinate directions are orthogonalised against it
/// and each other. Candidate spatial directions are tried in several orders so
/// a degenerate choice (one that happens to be parallel to something already
/// in the frame, e.g. purely radial motion) falls back to a workable one
/// instead of producing a singular basis.
#[must_use]
pub fn build_tetrad<M: Metric>(state: &GeodesicState, metric: &M) -> Tetrad {
    let r = state.x[1];
    let theta = state.x[2];

    let u = four_velocity(state, metric);

    // Normalise the time leg to <e0,e0> = -1.
    let u_norm2 = dot(metric, r, theta, &u, &u);
    let e0 = if u_norm2 < -1e-12 {
        scale(&u, 1.0 / (-u_norm2).sqrt())
    } else {
        // Non-timelike input: fall back to the coordinate time direction so
        // callers get a usable (if meaningless) frame rather than NaNs.
        [1.0, 0.0, 0.0, 0.0]
    };

    let mut e: [[f64; 4]; 4] = [[0.0; 4]; 4];
    e[0] = e0;

    // Coordinate directions, tried in this order.
    let candidates = [
        [0.0, 1.0, 0.0, 0.0], // d/dr
        [0.0, 0.0, 0.0, 1.0], // d/dphi
        [0.0, 0.0, 1.0, 0.0], // d/dtheta
        [1.0, 0.0, 0.0, 0.0], // d/dt, last resort
    ];

    let mut filled = 1;
    for cand in &candidates {
        if filled >= 4 {
            break;
        }

        // Remove the timelike component. <e0,e0> = -1, so the projection
        // subtracts with a PLUS sign: v = c + <c,e0> e0.
        let c_dot_e0 = dot(metric, r, theta, cand, &e[0]);
        let mut v = add_scaled(cand, &e[0], c_dot_e0);

        // Remove the already-established spatial components (unit norm).
        for k in 1..filled {
            let d = dot(metric, r, theta, &v, &e[k]);
            v = add_scaled(&v, &e[k], -d);
        }

        let n2 = dot(metric, r, theta, &v, &v);
        if n2 > 1e-10 {
            e[filled] = scale(&v, 1.0 / n2.sqrt());
            filled += 1;
        }
    }

    Tetrad { e }
}

impl Tetrad {
    /// Project a coordinate-basis vector onto the frame: the components the
    /// observer actually measures.
    ///
    /// `v^(a) = eta^(ab) g_{mu nu} e_(b)^mu v^nu`, i.e. the time component
    /// picks up the sign flip from the Minkowski metric.
    #[must_use]
    pub fn project<M: Metric>(
        &self,
        metric: &M,
        r: f64,
        theta: f64,
        v: &[f64; 4],
    ) -> [f64; 4] {
        let mut out = [0.0; 4];
        for a in 0..4 {
            out[a] = ETA[a] * dot(metric, r, theta, &self.e[a], v);
        }
        out
    }

    /// Rebuild a coordinate vector from frame components: `v^mu = v^(a) e_(a)^mu`.
    #[must_use]
    pub fn lift(&self, local: &[f64; 4]) -> [f64; 4] {
        let mut out = [0.0; 4];
        for (a, &comp) in local.iter().enumerate() {
            for mu in 0..4 {
                out[mu] += comp * self.e[a][mu];
            }
        }
        out
    }

    /// Largest deviation of `g(e_a, e_b)` from `eta_ab`.
    ///
    /// The single number that says whether the frame is trustworthy; the
    /// 1st-person view is only as correct as this is small.
    #[must_use]
    pub fn orthonormality_error<M: Metric>(&self, metric: &M, r: f64, theta: f64) -> f64 {
        let mut worst: f64 = 0.0;
        for a in 0..4 {
            for b in 0..4 {
                let expected = if a == b { ETA[a] } else { 0.0 };
                let actual = dot(metric, r, theta, &self.e[a], &self.e[b]);
                worst = worst.max((actual - expected).abs());
            }
        }
        worst
    }

    /// Ratio of observed to emitted photon frequency for light with
    /// coordinate 4-momentum `p` arriving at this observer.
    ///
    /// `nu_obs proportional to -g_{mu nu} u^mu p^nu`, so comparing against a
    /// distant static emitter gives the combined gravitational + Doppler
    /// shift in one number. Every colour shift in the 1st-person view comes
    /// from here rather than from a per-effect fudge.
    #[must_use]
    pub fn observed_frequency<M: Metric>(
        &self,
        metric: &M,
        r: f64,
        theta: f64,
        p: &[f64; 4],
    ) -> f64 {
        -dot(metric, r, theta, &self.e[0], p)
    }
}

/// Build the frame directly from a position and 4-velocity.
///
/// The 1st-person camera needs the frame at an arbitrary point on a *stored*
/// worldline, where only (r, theta, u) were kept — not the full phase-space
/// state. Same Gram-Schmidt as [`build_tetrad`].
#[must_use]
pub fn tetrad_from_velocity<M: Metric>(
    metric: &M,
    r: f64,
    theta: f64,
    u: &[f64; 4],
) -> Tetrad {
    let u_norm2 = dot(metric, r, theta, u, u);
    let e0 = if u_norm2 < -1e-12 {
        scale(u, 1.0 / (-u_norm2).sqrt())
    } else {
        [1.0, 0.0, 0.0, 0.0]
    };

    let mut e: [[f64; 4]; 4] = [[0.0; 4]; 4];
    e[0] = e0;

    let candidates = [
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0, 0.0],
    ];

    let mut filled = 1;
    for cand in &candidates {
        if filled >= 4 {
            break;
        }
        let c_dot_e0 = dot(metric, r, theta, cand, &e[0]);
        let mut v = add_scaled(cand, &e[0], c_dot_e0);
        for k in 1..filled {
            let d = dot(metric, r, theta, &v, &e[k]);
            v = add_scaled(&v, &e[k], -d);
        }
        let n2 = dot(metric, r, theta, &v, &v);
        if n2 > 1e-10 {
            e[filled] = scale(&v, 1.0 / n2.sqrt());
            filled += 1;
        }
    }

    Tetrad { e }
}

/// Relativistic aberration: the angle a direction appears at after boosting
/// by speed `beta`.
///
/// `cos(theta') = (cos(theta) + beta) / (1 + beta cos(theta))`
///
/// Provided for verification, not for use in the render path — the render
/// path gets aberration for free by expressing rays in the boosted frame.
#[must_use]
pub fn aberrate(cos_theta: f64, beta: f64) -> f64 {
    (cos_theta + beta) / (1.0 + beta * cos_theta)
}
