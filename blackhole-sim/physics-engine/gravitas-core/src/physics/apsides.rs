//! Equatorial orbits specified by their two turning points (spec §6.3).
//!
//! wiki-globe fork, milestone 9. The drop panel used to offer presets plus a
//! start radius; this lets the user name the **periapsis and apoapsis** and get
//! the orbit that has them. Everything here is closed form except the
//! separatrix, which needs one bisection.
//!
//! # Why Boyer-Lindquist algebra is safe here
//!
//! Spec §5 says stay in Kerr-Schild end to end, and the integrator does. The
//! radial potential below is usually written in Boyer-Lindquist, but every
//! quantity in it — `E = -p_t`, `L_z = p_phi`, `r`, and `dr/dtau` — is
//! *identical* in the two systems: Kerr-Schild differs from Boyer-Lindquist by
//! `t_KS = t_BL + f(r)` and `phi_KS = phi_BL + g(r)`, which leaves the Killing
//! vectors `d/dt` and `d/dphi` (and therefore their conserved momenta)
//! unchanged, and leaves `r` alone entirely. So the constants solved for here
//! drop straight into a Kerr-Schild initial state without a transformation.
//! What would *not* survive is `Omega = dphi/dt`, which is why the caller
//! builds `p_mu` directly rather than going through an angular velocity.
//!
//! # The radial potential
//!
//! For an equatorial timelike geodesic (Bardeen, Press & Teukolsky 1972):
//!
//! ```text
//!   r^4 (dr/dtau)^2 = R(r) = [E(r^2 + a^2) - L a]^2 - Delta [r^2 + (L - aE)^2]
//! ```
//!
//! With `x = L - aE` that collapses to `R(r) = [E r^2 - a x]^2 - Delta(r^2 + x^2)`,
//! and `R(r)/r` is the cubic
//!
//! ```text
//!   C(r) = (E^2 - 1) r^3 + 2M r^2 - (a^2 + 2 a E x + x^2) r + 2 M x^2
//! ```
//!
//! whose roots are the turning points. Motion is allowed where `C >= 0`.

use crate::metric::{Kerr, Metric, Orbit};
use crate::physics::plunge::circular_specific_angular_momentum;

/// What a requested pair of apsides turned out to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApsidesKind {
    /// A genuine bound orbit with turning points at both requested radii.
    BoundOrbit,
    /// The requested periapsis is inside the **separatrix** for that apoapsis,
    /// so no bound orbit reaches it and the object falls in.
    ///
    /// Note this is *not* the same as "periapsis inside the ISCO", which the
    /// spec's milestone-9 sketch says. An eccentric orbit's periapsis can sit
    /// well inside the ISCO and still be perfectly stable — for Schwarzschild
    /// the limit is `r_p = 4 M r_a / (r_a - 2M)`, which tends to 4M rather
    /// than 6M for a distant apoapsis. See [`separatrix_periapsis`].
    Plunge,
}

/// Conserved quantities for a requested pair of apsides, plus what the request
/// actually turned out to be.
#[derive(Clone, Copy, Debug)]
pub struct ApsidesSolution {
    /// Conserved energy E = −p_t.
    pub energy: f64,
    /// Conserved axial angular momentum L_z = p_phi.
    pub angular_momentum: f64,
    /// Launch radius. Always the outer of the two requested radii, and always a
    /// genuine turning point: the object is released there with dr/dtau = 0.
    pub apoapsis: f64,
    /// The periapsis these constants actually produce, or `None` when there is
    /// no inner turning point (the plunge case).
    pub periapsis: Option<f64>,
    /// Smallest periapsis any bound orbit can reach from this apoapsis.
    pub separatrix_periapsis: f64,
    pub kind: ApsidesKind,
}

/// `R(r)/r` — the cubic whose roots are the turning points. Positive where
/// radial motion is allowed.
#[must_use]
pub fn radial_cubic(r: f64, m: f64, a: f64, energy: f64, angular_momentum: f64) -> f64 {
    let x = angular_momentum - a * energy;
    (energy * energy - 1.0) * r * r * r + 2.0 * m * r * r
        - (a * a + 2.0 * a * energy * x + x * x) * r
        + 2.0 * m * x * x
}

/// Energy of an orbit that has a turning point at `r` with angular momentum
/// `l`, i.e. the positive root of `R(r) = 0` read as a quadratic in E.
///
/// Returns `None` when no future-directed timelike solution exists there.
#[must_use]
pub fn energy_at_turning_point(r: f64, m: f64, a: f64, l: f64) -> Option<f64> {
    if !(r.is_finite() && r > 0.0) {
        return None;
    }
    // R(r)/r^2 = 0 expanded in E, using x = L - aE:
    //   E^2 (r^2 + a^2 (1 + 2M/r)) - E (4 a L M / r) + (2M/r - 1) L^2 - Delta = 0
    let quad_a = r * r + a * a * (1.0 + 2.0 * m / r);
    let quad_b = -4.0 * a * l * m / r;
    let quad_c = (2.0 * m / r - 1.0) * l * l - (r * r - 2.0 * m * r + a * a);

    let disc = quad_b * quad_b - 4.0 * quad_a * quad_c;
    if disc < 0.0 || quad_a.abs() < f64::EPSILON {
        return None;
    }
    let energy = (-quad_b + disc.sqrt()) / (2.0 * quad_a);
    if energy.is_finite() && energy > 0.0 {
        Some(energy)
    } else {
        None
    }
}

/// Real roots of `qa y² + qb y + qc`, via the cancellation-free form.
///
/// `collapse` is the relative width of the window in which a discriminant is
/// treated as exactly zero — one double root — and it is not a matter of taste:
///
/// * [`constants_from_turning_points`] needs it wide. Its discriminant vanishes
///   *identically* at `a = 0`, so a naive `disc < 0 → no solution` rejects
///   every Schwarzschild input on a rounding error, and `(−b ± √disc)/2a`
///   throws away half the digits of a root it already knows exactly.
/// * [`inner_turning_point`] needs it zero. The separatrix is exactly where
///   that discriminant changes sign, and a collapse window there reports a
///   turning point across a whole band of angular momenta that have none —
///   which drags the bisected separatrix inward. It cost 4% at a distant
///   apoapsis before the two cases were separated.
fn real_roots(qa: f64, qb: f64, qc: f64, collapse: f64) -> [Option<f64>; 2] {
    let scale = (qb * qb).abs().max((4.0 * qa * qc).abs()).max(1.0);

    if qa.abs() < 1e-18 * scale {
        return if qb.abs() > f64::EPSILON {
            [Some(-qc / qb), None]
        } else {
            [None, None]
        };
    }

    let disc = qb * qb - 4.0 * qa * qc;
    if disc < -collapse * scale {
        return [None, None];
    }
    if disc <= collapse * scale {
        return [Some(-qb / (2.0 * qa)), None];
    }

    let s = disc.sqrt();
    let q = -0.5 * (qb + qb.signum() * s);
    [Some(q / qa), if q.abs() > 0.0 { Some(qc / q) } else { None }]
}

/// Largest turning point strictly inside `r_apo` and outside the horizon, given
/// constants for which `r_apo` is already a root.
///
/// Because `r_apo` is known to be a root, the cubic is deflated by
/// `(r − r_apo)` and the remaining quadratic solved exactly — no root finding,
/// and no risk of a numerical solver wandering onto the wrong root.
///
/// `None` means there is no inner turning point: the object released at
/// `r_apo` falls all the way in.
#[must_use]
pub fn inner_turning_point(
    m: f64,
    a: f64,
    energy: f64,
    angular_momentum: f64,
    r_apo: f64,
) -> Option<f64> {
    let (b, c, k) = deflated_quadratic(m, a, energy, angular_momentum, r_apo)?;

    if k.abs() < 1e-18 {
        // Marginally bound (E = 1): the cubic degenerates to a linear factor.
        if b.abs() < f64::EPSILON {
            return None;
        }
        return finite_inner_root(-c / b, m, a, r_apo);
    }

    let mut best: Option<f64> = None;
    for root in real_roots(k, b, c, 0.0).into_iter().flatten() {
        if let Some(valid) = finite_inner_root(root, m, a, r_apo) {
            best = Some(match best {
                Some(current) if current >= valid => current,
                _ => valid,
            });
        }
    }
    best
}

/// The cubic deflated by its known root at `r_apo`: returns `(b, c, k)` for the
/// remaining `k r² + b r + c`.
///
/// Two numerical choices here, both because a distant apoapsis makes `E` sit a
/// rounding error away from 1:
///
/// * `k = E² − 1` computed directly loses every significant digit at large
///   `r_apo` (E² − 1 ≈ −2M/r). It is recovered instead from the statement that
///   `r_apo` *is* a root, `k = −(c₂r² + c₁r + c₀)/r³`, where every term is
///   well-conditioned.
/// * The synthetic division runs **backwards** from the constant term
///   (`c = −c₀/r_apo`) rather than forwards from the leading one
///   (`b = c₂ + k·r_apo`). The forward form differences two nearly equal
///   numbers exactly when `r_apo` is large, which is where the answer matters.
fn deflated_quadratic(
    m: f64,
    a: f64,
    energy: f64,
    angular_momentum: f64,
    r_apo: f64,
) -> Option<(f64, f64, f64)> {
    if !(r_apo.is_finite() && r_apo > 0.0 && energy.is_finite()) {
        return None;
    }
    let x = angular_momentum - a * energy;
    let c2 = 2.0 * m;
    let c1 = -(a * a + 2.0 * a * energy * x + x * x);
    let c0 = 2.0 * m * x * x;

    let k = -(c2 / r_apo + c1 / (r_apo * r_apo) + c0 / (r_apo * r_apo * r_apo));
    let c = -c0 / r_apo;
    let b = (c - c1) / r_apo;
    Some((b, c, k))
}

fn finite_inner_root(root: f64, m: f64, a: f64, r_apo: f64) -> Option<f64> {
    let horizon = m + (m * m - a * a).max(0.0).sqrt();
    // Strictly below the apoapsis, or a circular orbit reports itself as its
    // own periapsis and every eccentricity readout collapses.
    if root.is_finite() && root > horizon && root < r_apo * (1.0 - 1e-12) {
        Some(root)
    } else {
        None
    }
}

/// Smallest periapsis reachable by a bound orbit released from `r_apo`, and the
/// angular momentum that reaches it: the **separatrix**.
///
/// At the separatrix the inner turning point is a *double* root — the orbit
/// whirls arbitrarily many times at periapsis before coming back out — and any
/// less angular momentum has no inner turning point at all.
///
/// Found by bisection on `L` rather than in closed form because only
/// Schwarzschild has one. There the answer is
/// `r_p = 4 M r_a / (r_a − 2M)`, which this reproduces and which the tests
/// check against; for `a != 0` the separatrix condition is a quartic and the
/// bisection is both shorter and easier to trust than its root selection.
///
/// Returns `(r_peri_min, l_separatrix)`.
#[must_use]
pub fn separatrix_periapsis(m: f64, a: f64, r_apo: f64) -> (f64, f64) {
    // Upper bracket: just under the circular angular momentum at r_apo, which
    // gives a periapsis just under r_apo. Exactly circular would make the
    // deflated quadratic's root coincide with r_apo and report nothing.
    let l_circular = circular_specific_angular_momentum(r_apo, m, a, Orbit::Prograde);
    let mut hi = l_circular * (1.0 - 1e-9);
    let mut lo = 0.0;

    // At or inside the ISCO there is no eccentric bound orbit at all: the most
    // any angular momentum achieves is the circular orbit itself, so the
    // smallest reachable periapsis *is* the apoapsis. Reporting the horizon
    // here instead would claim the whole range down to r_+ was orbitable.
    if reachable_periapsis(m, a, hi, r_apo).is_none() {
        return (r_apo, l_circular);
    }

    // 200 halvings takes an O(10) bracket well past f64 resolution; the loop is
    // bounded rather than tolerance-driven so it cannot spin on a flat region.
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if reachable_periapsis(m, a, mid, r_apo).is_some() {
            hi = mid;
        } else {
            lo = mid;
        }
        if hi - lo <= f64::EPSILON * hi.max(1.0) {
            break;
        }
    }

    // At the separatrix the inner turning point is a double root, so read it
    // off as the vertex of the deflated quadratic rather than as one of the two
    // roots. Near a double root `(−b ± √disc)/2k` keeps only half its digits —
    // the bisection converges on L to full precision and the roots then throw
    // most of it away.
    let r_peri = energy_at_turning_point(r_apo, m, a, hi)
        .and_then(|energy| deflated_quadratic(m, a, energy, hi, r_apo))
        .filter(|(_, _, k)| k.abs() > 0.0)
        .map_or(r_apo, |(b, _, k)| -b / (2.0 * k));

    (r_peri, hi)
}

/// Periapsis of the orbit released from rest-in-radius at `r_apo` with angular
/// momentum `l`. `None` when it plunges.
fn reachable_periapsis(m: f64, a: f64, l: f64, r_apo: f64) -> Option<f64> {
    let energy = energy_at_turning_point(r_apo, m, a, l)?;
    inner_turning_point(m, a, energy, l, r_apo)
}

/// Conserved `(E, L)` for the equatorial orbit whose turning points are exactly
/// `r_peri` and `r_apo`.
///
/// Both `R(r_peri) = 0` and `R(r_apo) = 0` are quadratic in `(E, x)` with
/// `x = L − aE`, but their **difference** loses the cross term entirely and is
/// linear in `E²` and `x²`:
///
/// ```text
///   E^2 = alpha + beta x^2,   alpha = 1 - 2M/(r_p + r_a),
///                             beta  = 2M / (r_p r_a (r_p + r_a))
/// ```
///
/// Substituting that back into either original equation and squaring away the
/// remaining `2 a E x` leaves a quadratic in `y = x²`, solved in closed form.
/// Squaring introduces the retrograde branch, so the root is chosen by checking
/// it against the *unsquared* relation.
///
/// Returns `None` if no prograde solution exists.
#[must_use]
pub fn constants_from_turning_points(
    m: f64,
    a: f64,
    r_peri: f64,
    r_apo: f64,
) -> Option<(f64, f64)> {
    if !(r_peri.is_finite() && r_apo.is_finite()) || r_peri <= 0.0 || r_apo <= r_peri {
        return None;
    }

    let sum = r_peri + r_apo;
    let alpha = 1.0 - 2.0 * m / sum;
    let beta = 2.0 * m / (r_peri * r_apo * sum);

    let delta_p = r_peri * r_peri - 2.0 * m * r_peri + a * a;
    let a0 = alpha * r_peri * r_peri - delta_p;
    let b0 = beta * r_peri * r_peri + 2.0 * m / r_peri - 1.0;

    // (4 a^2 beta - b0^2) y^2 + (4 a^2 alpha - 2 a0 b0) y - a0^2 = 0
    let qa = 4.0 * a * a * beta - b0 * b0;
    let qb = 4.0 * a * a * alpha - 2.0 * a0 * b0;
    let qc = -a0 * a0;

    let mut best: Option<(f64, f64, f64)> = None;
    for candidate in real_roots(qa, qb, qc, 1e-11).into_iter().flatten() {
        if !(candidate.is_finite() && candidate >= 0.0) {
            continue;
        }
        let energy_sq = alpha + beta * candidate;
        if energy_sq <= 0.0 {
            continue;
        }
        let energy = energy_sq.sqrt();
        let x = candidate.sqrt();
        // The unsquared relation, which the retrograde branch fails.
        let residual = (2.0 * a * energy * x - (a0 + b0 * candidate)).abs();
        let scale = (a0.abs() + (b0 * candidate).abs()).max(1.0);
        match best {
            Some((_, _, best_residual)) if best_residual <= residual / scale => {}
            _ => best = Some((energy, x + a * energy, residual / scale)),
        }
    }

    let (energy, angular_momentum, residual) = best?;
    // A residual this large means neither branch solved the original pair, so
    // reporting constants would be inventing an orbit.
    if residual > 1e-6 {
        return None;
    }
    Some((energy, angular_momentum))
}

/// Solve a requested pair of apsides, classifying what it really is.
///
/// The two radii are ordered rather than validated: dragging the inner handle
/// past the outer one swaps them, which is what §6.3 asks for ("`r_peri >
/// r_apo` swaps them") — the alternative is a dead zone in the drag.
///
/// Below the separatrix there is no orbit to return, so the angular momentum is
/// scaled down in proportion to how far inside the request went:
/// `L = L_sep · (r_peri / r_peri_sep)`. That is continuous at the separatrix
/// (ratio 1) and tends to zero as the requested periapsis tends to the centre,
/// where a zero-angular-momentum radial free fall is exactly right. The
/// launch radius stays the requested apoapsis in both cases, so the outer
/// handle always means what it says.
#[must_use]
pub fn solve_apsides(metric: &Kerr, r_peri_request: f64, r_apo_request: f64) -> ApsidesSolution {
    let m = metric.mass();
    let a = metric.a();

    let r_peri = r_peri_request.min(r_apo_request);
    let r_apo = r_peri_request.max(r_apo_request);

    let (separatrix, l_separatrix) = separatrix_periapsis(m, a, r_apo);

    if r_peri >= separatrix {
        if let Some((energy, angular_momentum)) =
            constants_from_turning_points(m, a, r_peri, r_apo)
        {
            let periapsis = inner_turning_point(m, a, energy, angular_momentum, r_apo);
            return ApsidesSolution {
                energy,
                angular_momentum,
                apoapsis: r_apo,
                periapsis,
                separatrix_periapsis: separatrix,
                kind: if periapsis.is_some() {
                    ApsidesKind::BoundOrbit
                } else {
                    ApsidesKind::Plunge
                },
            };
        }
    }

    let ratio = if separatrix > 0.0 {
        (r_peri / separatrix).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let angular_momentum = l_separatrix * ratio;
    let energy = energy_at_turning_point(r_apo, m, a, angular_momentum).unwrap_or(1.0);
    let periapsis = inner_turning_point(m, a, energy, angular_momentum, r_apo);

    ApsidesSolution {
        energy,
        angular_momentum,
        apoapsis: r_apo,
        periapsis,
        separatrix_periapsis: separatrix,
        kind: if periapsis.is_some() {
            ApsidesKind::BoundOrbit
        } else {
            ApsidesKind::Plunge
        },
    }
}

/// Schwarzschild closed form for the separatrix, `r_p = 4 M r_a / (r_a − 2M)`.
///
/// Kept as the check on [`separatrix_periapsis`]'s bisection rather than as the
/// production path, so the general (Kerr) route is the one that is exercised.
/// Two sanity points it reproduces: `r_a → ∞` gives 4M (the marginally bound
/// orbit) and `r_a = 6M` gives 6M (the ISCO, where the two apsides merge).
#[must_use]
pub fn schwarzschild_separatrix_periapsis(m: f64, r_apo: f64) -> f64 {
    4.0 * m * r_apo / (r_apo - 2.0 * m)
}
