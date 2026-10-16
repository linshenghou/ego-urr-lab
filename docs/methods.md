# Nymeria → URR → Taku: methods and results

This page describes the **new authored offline Taku retargeter**, not a Dyna policy, a recorded Taku demonstration, or the earlier velocity-level tracking experiments. The public player is Nymeria-only. Its solid robot is reconstructed from actual optimized joint configurations; its translucent meshes depict the targets used in that optimization.

## 1. Human motion and task extraction

The [provenance document](nymeriaplus-provenance.md) specifies the source, skeleton FK, anatomical aliases, coordinate conversion and validity checks. Source wrist poses come from `l_wrist`/`r_wrist`; elbows are positions at `l_lowarm`/`r_lowarm`; chest is a shoulder-midpoint geometric frame; footprint is pelvis XY and projected heading.

These are **derived human task quantities**, not official Nymeria URR labels or robot commands. Source Z=0 is not an independently calibrated physical floor. The viewer retains the aligned human skeleton and `source_targets` separately from the mapped robot-space `targets`.

## 2. Taku task references and initial posture

Kinematics are read from the [official Taku JSON](https://www.dyna.co/assets/we/dvt1_kin.json), independently verified against SHA-256 `02505a774c55fb3f998265e32840bffd86fba690bd4c9e1af857663ca39ec83f`. This document describes link origins and axes, but does **not** provide manufacturer position, speed, acceleration or torque limits. It is fetched separately, not copied into this repository.

| Task | Exact Taku reference | Target components |
|---|---|---|
| Left / right wrist | `left_ee_fk_target_frame` / `right_ee_fk_target_frame` | Position and rotation; includes the official fixed transform after wrist-roll |
| Left / right elbow | `left_elbow_link` / `right_elbow_link` origin | Position only, no target quaternion |
| Chest | `torso_body_link` origin and axes | Position and rotation, no additional offset |
| Footprint | `agv_base` | Planar XY and yaw, with Z=0 |

The human shoulder midpoint and the robot torso origin are different anatomical/reference locations. They are associated by an explicit retargeting rule, not asserted to be the same physical point.

An authored reference pose uses folding/waist angles `(0.08, 0.50, −0.43, 0)` radians, giving a net forward torso pitch of 0.15 rad. An explicit `auto` rule chooses the arm posture from the first human frame:

- If mean wrist height is more than 0.50 m below the human chest, choose an **arms-down** reference: shoulder pitch −0.15 rad, elbow −0.25 rad.
- Otherwise choose **bent elbows**: shoulder pitch −0.30 rad, elbow −1.55 rad.
- Both use shoulder roll +0.20 rad on the left and −0.20 rad on the right; other arm angles start at zero. `--home` can explicitly override the heuristic.

The long excerpt's initial mean wrist drop is 0.556833 m, so it uses arms-down; the short excerpt's drop is 0.384923 m, so it uses bent elbows. This is an interpretable first-pose heuristic, not a learned calibration or proof of physical safety. The complete selected configuration and rule are saved in every companion artifact.

## 3. Relative mapping

For each site independently:

```text
p_target(t) = p_taku_home + p_source(t) − p_source(0)
R_target(t) = R_source(t) R_source(0)ᵀ R_taku_home
```

The rotation equation applies to wrists, chest and footprint, not elbows. Human translational changes are preserved without limb-length scaling. The initial robot pose replaces the initial human pose, so **absolute height and initial inter-site distances are not preserved**. This is not one rigid world-to-world transform. It may still produce mutually inconsistent or unreachable targets after large rotations, reaches or body motion.

Initial posture matters: using bent elbows for the long clip made a later wrist-height request approximately 2.31 m and the left position-error maximum approximately 43 cm. Selecting the explicitly documented arms-down initial pose substantially reduces that artificial height offset; no time segment or target displacement was removed. Remaining errors are still reported below.

## 4. Genuine offline position IK

[retarget-taku.py](../scripts/retarget-taku.py) solves 21 variables:

- Planar base X, Y, yaw: 3.
- Folding-low, folding-high, waist-pitch, waist-yaw: 4.
- Seven joints per arm: 14.

Head, grippers and wheel joints stay at zero. The base is a holonomic planar kinematic degree of freedom; no wheel steering/rolling model is enforced.

Each exported source frame, at approximately 30 Hz with its actual nonuniform timestamp, starts from the previous solution. The solver minimizes a simultaneous weighted task residual plus soft temporal and posture terms. It uses geometric Jacobians, the SO(3) logarithm derivative for orientation residuals, damped Gauss–Newton, a bounded linear least-squares subproblem, and up to ten FK merit-backtracking attempts. It allows up to 24 iterations per frame. This is **not hierarchical QP, not velocity IK, and not velocity feedforward**. Browser playback performs interpolation and FK, not live optimization.

Residual multipliers are explicit; they are squared inside the least-squares objective:

| Site | Position multiplier | Rotation multiplier, m/rad |
|---|---:|---:|
| Each wrist | 3.00 | 0.30 |
| Each elbow | 0.45 | Not applicable |
| Chest | 2.00 | 0.45 |
| Footprint | 5.00 | 0.60 |

The squared previous-frame penalty coefficient is 0.05; the articulated-joint home-posture coefficient is 0.00015. The local step damping coefficient is 0.006. Mobile-base X/Y/yaw are not tethered to their initial position. Low elbow weights mean their residuals can be sacrificed for wrist, chest and footprint objectives; small hand error must not be described as uniformly accurate whole-body tracking.

### Limits and continuity: what “no velocity limits” means here

No manufacturer actuator velocity/acceleration limits are supplied or enforced. The solver nevertheless retains:

- Explicit experiment-defined joint-position boxes, recorded in `solver.lower/upper`; these are **not validated manufacturer limits**.
- A per-iteration numerical trust box and backtracking.
- A separate per-export-frame box around the previous configuration: each base X/Y change ≤0.06 m; each yaw/arm angle change ≤0.20 rad; each folding/waist-pitch angle change ≤0.15 rad.
- Soft temporal regularization and finite/bounds/merit checks.

The frame box **is an effective per-frame displacement/angular cap**, and therefore constrains playback speed at the sample rate. It must not be advertised as unrestricted velocity. At nominal 30 Hz, 0.20 rad/frame corresponds to roughly 6 rad/s and 0.06 m/frame to 1.8 m/s per horizontal component; exact effective rates vary with timestamps. It is not dt-scaled, is not a hardware specification, and imposes no explicit acceleration limit. It prevents discontinuous IK branch changes, not collisions or actuator damage.

For the final artifacts, the frame box is active on 95/3601 long-clip frames and 0/451 short-clip frames. Maximum angular changes are 0.20 and 0.1722 rad/frame respectively; maximum per-component XY changes are 0.06 and 0.0248 m/frame. No accepted frame increases its starting-frame merit. `backtracking_stalls` counts termination when another proposed step cannot reduce merit; it is not a count of invalid FK outputs or hardware failures.

Dynamics, mass/inertia, torque, collision, contact, balance, actuator feasibility and latency are not modeled. Do not stream these trajectories directly to hardware.

## 5. Final measured residuals

Statistics use only valid targets at the retained **approximately 30 Hz exported sample times**, not the approximately 240 Hz original stream and not interpolated display frames. Invalid source samples remain unavailable. There is no lag fitting, hand-selected transient trimming or post-hoc exclusion based on large robot error. Position error is Euclidean distance; orientation error is the SO(3) geodesic angle. Elbow orientation error is unavailable, not zero.

Position residuals, in millimetres:

| Excerpt | Site | Mean | P95 | Maximum |
|---|---|---:|---:|---:|
| 120 s | Left wrist | 7.70 | 24.99 | 142.77 |
| 120 s | Right wrist | 3.61 | 9.72 | 178.14 |
| 120 s | Left elbow | 93.56 | 198.17 | 277.02 |
| 120 s | Right elbow | 87.22 | 168.25 | 352.97 |
| 120 s | Chest | 68.62 | 144.01 | 293.08 |
| 120 s | Footprint | 9.42 | 20.42 | 58.14 |
| 15 s | Left wrist | 3.06 | 7.68 | 14.68 |
| 15 s | Right wrist | 3.19 | 8.05 | 16.12 |
| 15 s | Left elbow | 89.95 | 194.19 | 224.55 |
| 15 s | Right elbow | 95.57 | 197.44 | 223.06 |
| 15 s | Chest | 41.40 | 83.95 | 98.40 |
| 15 s | Footprint | 6.32 | 13.91 | 15.73 |

Orientation residuals, in degrees:

| Excerpt | Site | Mean | P95 | Maximum |
|---|---|---:|---:|---:|
| 120 s | Left wrist | 2.97 | 6.94 | 87.20 |
| 120 s | Right wrist | 2.54 | 7.05 | 76.09 |
| 120 s | Chest | 10.80 | 19.94 | 41.02 |
| 120 s | Footprint | 3.78 | 12.50 | 31.00 |
| 15 s | Left wrist | 2.53 | 6.69 | 16.16 |
| 15 s | Right wrist | 2.29 | 6.34 | 9.59 |
| 15 s | Chest | 6.52 | 14.54 | 17.22 |
| 15 s | Footprint | 3.54 | 12.59 | 14.94 |

These are **optimization residuals against our mapped targets**, not accuracy against independently measured Taku motion. Large orientation outliers and chest/elbow deviations remain important limitations. Lower hand means alone do not validate mapping quality or physical execution.

The source `motionStats` speed summaries are a different quantity: they use valid native human-motion intervals before decimation. They must not be relabelled as robot speed or robot tracking error.

## 6. Rendering semantics

Solid robot meshes follow the solved joints through FK. Translucent robot mesh copies follow mapped target frames. The wrist mesh uses the inverse official EE-to-wrist link transform so its visual origin does not accidentally shift the target. Chest and base copies use their link origins. An elbow has only a target position: its ghost mesh may orient toward the target wrist for readability. That display-derived rotation is not an elbow target, measurement, or extra IK constraint.

The human skeleton stays in its original aligned source frame in a separate source view. It must not be silently displaced site-by-site to make it appear coincident with the retargeted robot.

## Reproduce the IK artifacts

Install the pinned optional Python dependencies, then obtain the official kinematics outside the repository:

```sh
python3 -m pip install -r requirements-export.txt
curl -fL https://www.dyna.co/assets/we/dvt1_kin.json -o /tmp/dvt1_kin.json
python3 -B scripts/retarget-taku.py public/data/nymeria/housework-long.json \
  --kinematics /tmp/dvt1_kin.json --home auto \
  --output /tmp/housework-long-taku.json
python3 -B scripts/retarget-taku.py public/data/nymeria/housework-hands.json \
  --kinematics /tmp/dvt1_kin.json --home auto \
  --output /tmp/housework-hands-taku.json
```

The kinematics hash is verified before solving. Overwriting is refused unless `--overwrite-derived` is explicit and the existing file has the exact companion schema; inputs cannot be overwritten. Different numerical-library/platform versions may produce small floating-point differences, so reviewed output hashes identify artifacts rather than guarantee byte-identical optimization on every platform.

Tests:

```sh
python3 -B tests/taku-retarget.py
TAKU_KINEMATICS=/tmp/dvt1_kin.json python3 -B tests/taku-retarget.py
```

The first command runs network-free synthetic tree/Jacobian/mapping/optimization/guard tests; the optional second additionally checks all bundled real trajectories against FK and recomputes saved errors/statistics. The synthetic fixture is authored test geometry, not a redistributed Taku model. Separate browser FK cross-checks on all 4,052 frames agree with exported reference positions within 0.5 nm and rotations within 4.3×10⁻⁸ rad, consistent with numerical rounding; this is software consistency, **not physical measurement accuracy**.

Both `*-taku.json` companions remain non-audio NymeriaPlus numerical adaptations under CC BY-NC 4.0. The scripts are original MIT-licensed code. See [data provenance and license terms](nymeriaplus-provenance.md).
