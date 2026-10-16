#!/usr/bin/env python3
"""Reproducible offline Nymeria URR -> Taku position IK (not a robot controller).

Inputs are the licensed numerical excerpt and the separately obtained official
Taku kinematics JSON. No third-party model/kinematics file is copied to output.
Only numpy/scipy are required. All limits below are experiment-defined numerical
bounds: the public kinematics document contains no manufacturer joint limits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import time

import numpy as np
from scipy.optimize import lsq_linear
from scipy.spatial.transform import Rotation

SCHEMA = "ego-urr-lab.taku-retarget.v1"
KIN_URL = "https://www.dyna.co/assets/we/dvt1_kin.json"
KIN_SHA = "02505a774c55fb3f998265e32840bffd86fba690bd4c9e1af857663ca39ec83f"
SITES = ("left", "right", "elbow_left", "elbow_right", "chest", "footprint")
SITE_LINKS = {"left": "left_ee_fk_target_frame", "right": "right_ee_fk_target_frame",
              "elbow_left": "left_elbow_link", "elbow_right": "right_elbow_link",
              "chest": "torso_body_link", "footprint": "agv_base"}
BODY = ["folding_low_joint", "folding_high_joint", "waist_pitch_joint", "waist_yaw_joint"]
ARM = ["shoulder_pitch_joint", "shoulder_roll_joint", "shoulder_yaw_joint", "elbow_joint",
       "wrist_yaw_joint", "wrist_pitch_joint", "wrist_roll_joint"]
JOINT_NAMES = ["robot.x", "robot.y", "robot.yaw"] + ["robot." + j for j in BODY] + ["robot." + s + "_" + j for s in ("left", "right") for j in ARM]
HOME = np.array([0., 0., 0., .08, .50, -.43, 0., -.30, .20, 0., -1.55, 0., 0., 0., -.30, -.20, 0., -1.55, 0., 0., 0.])
LOWER = np.array([-25., -25., -20 * math.pi, -.4, .05, -1.2, -1.2, -2.2, -.3, -2., -2.6, -2.4, -1.5, -2.4, -2.2, -1.5, -2., -2.6, -2.4, -1.5, -2.4])
UPPER = np.array([25., 25., 20 * math.pi, .6, 1.2, .6, 1.2, 1.2, 1.5, 2., -.08, 2.4, 1.5, 2.4, 1.2, .3, 2., -.08, 2.4, 1.5, 2.4])
TRUST = np.array([.10, .10, .20, .10, .10, .10, .15] + [.20] * 14)
FRAME_TRUST = np.array([.06, .06, .20, .15, .15, .15, .20] + [.20] * 14)
# Residuals have metres and radians; orientation factors are explicit m/rad.
WEIGHTS = {"left": (3., .30), "right": (3., .30), "elbow_left": (.45, 0.),
           "elbow_right": (.45, 0.), "chest": (2., .45), "footprint": (5., .6)}
DAMPING, TEMPORAL, POSTURE = .006, .05, .00015


def select_home(source, mode="auto"):
    """An explicit first-pose heuristic; no source motion is scaled or trimmed."""
    chest_z = source["targets"]["chest"]["p"][0][2]
    drop = float(np.mean([chest_z - source["targets"][site]["p"][0][2] for site in ("left", "right")]))
    selected = "arms-down" if mode == "auto" and drop > .5 else "bent-elbow" if mode == "auto" else mode
    if selected not in ("arms-down", "bent-elbow"):
        raise ValueError("Unknown authored home")
    home = HOME.copy()
    if selected == "arms-down":
        home[[7, 14]] = -.15
        home[[10, 17]] = -.25
    return home, {"requested": mode, "selected": selected, "initial_mean_wrist_drop_below_human_chest_m": drop,
                  "rule": "auto: choose authored arms-down home if mean initial wrist height is >0.50 m below source chest; otherwise bent-elbow home. Explicit first-pose heuristic, not learned calibration."}


def transform(xyz=(0., 0., 0.), rotation=None):
    out = np.eye(4)
    out[:3, 3] = xyz
    if rotation is not None:
        out[:3, :3] = rotation
    return out


def axis_rotation(axis, angle):
    """Rodrigues rotation without allocating a scipy Rotation per FK joint."""
    x, y, z = axis
    k = np.array([[0., -z, y], [z, 0., -x], [-y, x, 0.]])
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * (k @ k)


def right_log_jacobian_inverse(vector):
    """Derivative of log(R exp(delta)) with respect to delta (SO(3))."""
    angle = np.linalg.norm(vector)
    x, y, z = vector
    cross = np.array([[0., -z, y], [z, 0., -x], [-y, x, 0.]])
    factor = 1 / 12 + angle * angle / 720 if angle < 1e-5 else (1 - .5 * angle / math.tan(.5 * angle)) / (angle * angle)
    return np.eye(3) + .5 * cross + factor * cross @ cross


class Taku:
    """glTF-independent URDF-convention FK + world geometric Jacobians."""
    def __init__(self, document):
        self.root = document["root"]
        if self.root != "agv_base":
            raise ValueError("Unexpected Taku root")
        pending = list(document["joints"])
        self.joints, known, self.chains = [], {self.root}, {self.root: []}
        variables = {name.removeprefix("robot."): i for i, name in enumerate(JOINT_NAMES)}
        while pending:
            rest = []
            for joint in pending:
                if joint["parent"] not in known:
                    rest.append(joint); continue
                if joint["child"] in known:
                    raise ValueError("Duplicate/cyclic Taku link")
                index = variables.get(joint["name"])
                axis = np.asarray(joint["axis"], float)
                if joint["type"] != "fixed":
                    axis /= np.linalg.norm(axis)
                origin = transform(joint["xyz"], Rotation.from_euler("xyz", joint["rpy"]).as_matrix())
                self.joints.append((joint["name"], joint["parent"], joint["child"], joint["type"], origin, axis, index))
                self.chains[joint["child"]] = self.chains[joint["parent"]] + ([] if index is None else [index])
                known.add(joint["child"])
            if len(rest) == len(pending):
                raise ValueError("Disconnected/cyclic Taku tree")
            pending = rest
        if any(name not in known for name in SITE_LINKS.values()) or sum(j[-1] is not None for j in self.joints) != 18:
            raise ValueError("Required Taku sites or 18 articulated optimization joints missing")
        # Solver need not walk cameras/wheels/fingers. Rendering FK still can.
        required = set(SITE_LINKS.values())
        for _, parent, child, *_ in reversed(self.joints):
            if child in required:
                required.add(parent)
        self.solver_joints = [joint for joint in self.joints if joint[2] in required]

    def fk(self, q, jacobians=False, full=False):
        q = np.asarray(q, float)
        if q.shape != (21,) or not np.all(np.isfinite(q)):
            raise ValueError("Expected finite 21-DOF configuration")
        base = transform([q[0], q[1], 0.], axis_rotation([0., 0., 1.], q[2]))
        links, origins, axes = {self.root: base}, {}, {}
        for _, parent, child, kind, fixed, axis, index in self.joints if full else self.solver_joints:
            world = links[parent] @ fixed
            value = 0. if index is None else q[index]
            if index is not None:
                origins[index], axes[index] = world[:3, 3].copy(), world[:3, :3] @ axis
            if kind == "prismatic":
                world[:3, 3] += world[:3, :3] @ (axis * value)
            elif kind != "fixed" and value:
                world[:3, :3] = world[:3, :3] @ axis_rotation(axis, value)
            links[child] = world
        poses = {site: links[link] for site, link in SITE_LINKS.items()}
        if not jacobians:
            return links if full else poses
        jac = {}
        for site, link in SITE_LINKS.items():
            p = links[link][:3, 3]
            matrix = np.zeros((6, 21)); matrix[0, 0] = matrix[1, 1] = 1.
            matrix[:3, 2] = np.cross([0., 0., 1.], p - base[:3, 3]); matrix[5, 2] = 1.
            for index in self.chains[link]:
                matrix[:3, index] = np.cross(axes[index], p - origins[index]); matrix[3:, index] = axes[index]
            jac[site] = matrix
        return poses, jac


def validate_source(source):
    if source.get("schema") != "ego-urr-lab.nymeria.v1" or source.get("license", {}).get("id") != "CC-BY-NC-4.0":
        raise ValueError("Expected licensed numerical Nymeria excerpt")
    times = np.asarray(source["time"], float)
    if len(times) < 2 or times[0] != 0 or np.any(np.diff(times) <= 0) or not np.all(np.isfinite(times)):
        raise ValueError("Invalid source time grid")
    for site in SITES:
        data = source["targets"][site]
        if np.shape(data["p"]) != (len(times), 3) or len(data["pv"]) != len(times) or len(data["ov"]) != len(times):
            raise ValueError("Mismatched source target shape")
        if not np.all(np.isfinite(np.asarray(data["p"], float))):
            raise ValueError("Excerpt contains non-finite coordinates; keep this interval unavailable instead of solving it")
        if not data["pv"][0] or (not site.startswith("elbow") and not data["ov"][0]):
            raise ValueError("First source frame must have valid six-site anchors")
        if not site.startswith("elbow") and np.shape(data["q"]) != (len(times), 4):
            raise ValueError("Mismatched source rotation shape")
        if not site.startswith("elbow") and (not np.all(np.isfinite(np.asarray(data["q"], float))) or np.any(np.linalg.norm(data["q"], axis=1) < 1e-9)):
            raise ValueError("Excerpt contains undefined rotations")
    return times


def map_targets(source, home_poses):
    """Preserve each site's displacement and world rotation delta, not raw z."""
    validate_source(source)
    mapped, matrices = {}, {}
    for site in SITES:
        data = source["targets"][site]
        p = np.asarray(data["p"], float)
        points = p - p[0] + home_poses[site][:3, 3]
        poses = np.repeat(np.eye(4)[None], len(p), axis=0); poses[:, :3, 3] = points
        if not site.startswith("elbow"):
            rotations = Rotation.from_quat(np.asarray(data["q"], float)).as_matrix()
            poses[:, :3, :3] = rotations @ rotations[0].T @ home_poses[site][:3, :3]
        mapped[site] = {"p": points, "q": None if site.startswith("elbow") else Rotation.from_matrix(poses[:, :3, :3]).as_quat(),
                        **{name: data[name] for name in ("pv", "ov", "interval_pv", "interval_ov")}}
        matrices[site] = poses
    return mapped, matrices


def task_system(poses, desired, masks, jacobians=None):
    residual, rows = [], []
    for site in SITES:
        wp, wr = WEIGHTS[site]
        if masks[site][0]:
            residual.extend(wp * (desired[site][:3, 3] - poses[site][:3, 3]))
            if jacobians is not None:
                rows.extend(wp * jacobians[site][:3])
        if masks[site][1] and wr:
            rotation_error = Rotation.from_matrix(desired[site][:3, :3] @ poses[site][:3, :3].T).as_rotvec()
            residual.extend(wr * rotation_error)
            if jacobians is not None:
                rows.extend(wr * right_log_jacobian_inverse(rotation_error) @ jacobians[site][3:])
    return np.asarray(residual), np.asarray(rows).reshape(-1, 21) if jacobians is not None else None


def objective(model, q, desired, masks, previous, home=HOME):
    residual, _ = task_system(model.fk(q), desired, masks)
    # Never tether mobile-base x/y/yaw to their starting location.
    return float(residual @ residual + TEMPORAL * np.sum((q - previous) ** 2) + POSTURE * np.sum((q[3:] - home[3:]) ** 2))


def solve_frame(model, previous, desired, masks, iterations=24, home=HOME):
    """Warm-started damped Gauss-Newton, numerical box/trust bounds, merit search."""
    q = previous.copy(); initial = objective(model, q, desired, masks, previous, home)
    frame_lower, frame_upper = np.maximum(LOWER, previous - FRAME_TRUST), np.minimum(UPPER, previous + FRAME_TRUST)
    value, rejected, accepted = initial, 0, 0
    for iteration in range(iterations):
        poses, jac = model.fk(q, jacobians=True)
        residual, matrix = task_system(poses, desired, masks, jac)
        # BVLS solves the *whole* linearized bounded subproblem, instead of
        # clipping an unconstrained inverse and thereby losing its descent sign.
        matrix = np.vstack([matrix, math.sqrt(TEMPORAL) * np.eye(21),
                            math.sqrt(POSTURE) * np.eye(21)[3:], math.sqrt(DAMPING) * np.eye(21)])
        residual = np.r_[residual, math.sqrt(TEMPORAL) * (previous - q),
                         math.sqrt(POSTURE) * (home[3:] - q[3:]), np.zeros(21)]
        lower_step, upper_step = np.maximum(frame_lower - q, -TRUST), np.minimum(frame_upper - q, TRUST)
        step = lsq_linear(matrix, residual, bounds=(lower_step, upper_step), method="bvls", tol=1e-9, max_iter=100).x
        if not np.all(np.isfinite(step)):
            raise ValueError("Non-finite IK step")
        if np.linalg.norm(step) < 2e-6:
            break
        improved = False
        for power in range(10):
            candidate = q + step * (0.5 ** power)
            candidate_value = objective(model, candidate, desired, masks, previous, home)
            if candidate_value < value - 1e-11:
                q, value = candidate, candidate_value; accepted += 1; improved = True; break
        if not improved:
            rejected += 1; break
        if value < 1e-9 or initial - value < 1e-12:
            break
    if not np.all(np.isfinite(q)) or np.any(q < frame_lower - 1e-10) or np.any(q > frame_upper + 1e-10) or value > initial + 1e-9:
        raise ValueError("IK violated a finite/bounds/merit invariant")
    return q, {"iterations": iteration + 1, "accepted": accepted, "rejected": rejected,
               "initial_objective": initial, "final_objective": value,
               "frame_trust_active": bool(np.any(np.abs(q - previous) >= FRAME_TRUST - 1e-7))}


def summarize(values):
    a = np.asarray([x for x in values if x is not None], float)
    return None if not len(a) else {"n": len(a), "mean": float(a.mean()), "p95": float(np.percentile(a, 95)), "max": float(a.max())}


def numeric(value):
    if isinstance(value, np.ndarray):
        return np.round(value, 9).tolist()
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    if isinstance(value, dict):
        return {key: numeric(item) for key, item in value.items()}
    if isinstance(value, list):
        return [numeric(item) for item in value]
    return value


def retarget(source, kinematics, iterations=24, progress=False, home_mode="auto"):
    times = validate_source(source); model = Taku(kinematics)
    home, home_selection = select_home(source, home_mode)
    targets, desired = map_targets(source, model.fk(home))
    q, configurations, diagnostics = home.copy(), [], []
    actual = {site: {"p": [], "q": None if site.startswith("elbow") else []} for site in SITES}
    errors = {site: {"position_m": [], "orientation_rad": []} for site in SITES}
    started = time.monotonic()
    for i, t in enumerate(times):
        masks = {site: (targets[site]["pv"][i], targets[site]["ov"][i]) for site in SITES}
        wanted = {site: desired[site][i] for site in SITES}
        if i:
            q, diagnostic = solve_frame(model, q, wanted, masks, iterations, home)
        else:
            diagnostic = {"iterations": 0, "accepted": 0, "rejected": 0, "initial_objective": 0., "final_objective": 0., "frame_trust_active": False}
        # Quantize q before final FK: exported errors correspond exactly to saved q.
        q = np.round(q, 9); poses = model.fk(q)
        configurations.append(q.copy()); diagnostics.append(diagnostic)
        for site in SITES:
            pose = poses[site]; actual[site]["p"].append(pose[:3, 3])
            if actual[site]["q"] is not None:
                actual[site]["q"].append(Rotation.from_matrix(pose[:3, :3]).as_quat())
            errors[site]["position_m"].append(float(np.linalg.norm(pose[:3, 3] - wanted[site][:3, 3])) if masks[site][0] else None)
            errors[site]["orientation_rad"].append(float(Rotation.from_matrix(wanted[site][:3, :3] @ pose[:3, :3].T).magnitude()) if masks[site][1] else None)
        if progress and (i % 200 == 0 or i == len(times) - 1):
            print(f"IK {i + 1}/{len(times)} | t={t:.3f}s | elapsed={time.monotonic() - started:.1f}s", flush=True)
    for data in actual.values():
        for key in ("p", "q"):
            if data[key] is not None:
                data[key] = np.asarray(data[key])
    stats = {site: {"position": summarize(data["position_m"]), "orientation": summarize(data["orientation_rad"])} for site, data in errors.items()}
    displacement = np.diff(np.asarray(configurations), axis=0)
    result = {"schema": SCHEMA, "time": source["time"], "joint_names": JOINT_NAMES, "q": np.asarray(configurations),
              "targets": targets, "actual": actual, "errors": errors, "stats": stats,
              "mapping": {"method": "Per-site first-frame relative displacement and world orientation delta, anchored to authored Taku FK home.",
                          "position_equation": "p_target(t) = p_taku_home + p_source(t) - p_source(0)",
                          "orientation_equation": "R_target(t) = R_source(t) R_source(0)^T R_taku_home",
                          "absolute_source_height_preserved": False, "limb_length_scaling": False, "home_selection": home_selection,
                          "source_skeleton": "Unmodified aligned human world positions; distinct from robot-space retarget targets.",
                          "site_links": SITE_LINKS, "chest": "torso_body_link origin and orientation; not a shoulder midpoint or an added translation",
                          "elbows": "Position-only at left/right_elbow_link origins; mesh heading may be derived only for display."},
              "solver": {"method": "Offline warm-started weighted damped position IK, Gauss-Newton with active numerical bounds, trust-region step and FK merit backtracking.",
                         "dof": 21, "weights": {site: {"position": w[0], "orientation_m_per_rad": w[1]} for site, w in WEIGHTS.items()},
                         "damping": DAMPING, "temporal_regularization": TEMPORAL, "posture_regularization": POSTURE,
                         "home": home, "lower": LOWER, "upper": UPPER, "trust_step_per_iteration": TRUST,
                         "trust_step_per_frame": FRAME_TRUST,
                         "frame_trust_notice": "Fixed numerical per-export-frame configuration jump guard: base x/y <=0.06 m; angular <=0.20 rad (folding/pitch <=0.15). This also bounds apparent playback speed at the sample rate; it is NOT a manufacturer actuator speed/acceleration specification and is not dt-scaled.",
                         "max_iterations_per_frame": iterations, "actuator_velocity_limits": False, "actuator_acceleration_limits": False,
                         "bounds_are_manufacturer_limits": False,
                         "bounds_notice": "Public kinematics lacks manufacturer limits. These are experiment-defined numeric pose bounds, not validated hardware-safe limits.",
                         "not_modeled": ["dynamics", "torques", "collision", "contact", "balance", "wheel rolling constraints", "physical actuator feasibility"],
                         "fixed_joints": "Head, grippers and wheel joints stay at zero reference; mobile base is holonomic planar x/y/yaw, not wheel control.",
                         "metric_sampling": "Original excerpt timestamps (~30 Hz decimated from ~240 Hz); only valid target samples, no display-interpolated error samples.",
                         "max_abs_joint_step": np.max(np.abs(displacement), axis=0),
                         "diagnostics": {"frames": len(times), "total_iterations": sum(d["iterations"] for d in diagnostics),
                                         "backtracking_stalls": sum(d["rejected"] for d in diagnostics),
                                         "frame_trust_active_frames": sum(d["frame_trust_active"] for d in diagnostics),
                                         "maximum_final_objective": max(d["final_objective"] for d in diagnostics),
                                         "merit_increase_frames": sum(d["final_objective"] > d["initial_objective"] + 1e-9 for d in diagnostics),
                                         "near_numerical_bound_frames": int(np.sum(np.any((np.asarray(configurations) < LOWER + .001) | (np.asarray(configurations) > UPPER - .001), axis=1))) }},
              "source": {"sequence_id": source["source"]["sequence_id"], "kinematics_url": KIN_URL,
                         "kinematics_sha256": KIN_SHA, "source_excerpt_sha256": None,
                         "source_time_start_s": source["source_time"][0], "source_time_end_s": source["source_time"][-1]},
              "license": {**source["license"], "changes": source["license"]["changes"] + " Further modified: per-site relative retargeting, authored home, numerical IK joint configurations and FK error summaries. Not official Dyna motion or a learned policy."}}
    return numeric(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Licensed Nymeria numerical excerpt JSON")
    parser.add_argument("--kinematics", type=Path, required=True, help="Separately obtained official dvt1_kin.json; SHA256 is verified")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=24)
    parser.add_argument("--home", choices=("auto", "arms-down", "bent-elbow"), default="auto")
    parser.add_argument("--overwrite-derived", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.iterations <= 100:
        parser.error("iterations must be 1..100")
    if args.output.resolve() in (args.source.resolve(), args.kinematics.resolve()):
        parser.error("output must not overwrite an input")
    if args.output.exists():
        if not args.overwrite_derived or json.loads(args.output.read_text()).get("schema") != SCHEMA:
            parser.error("refusing overwrite; explicit --overwrite-derived only replaces this schema")
    kin_bytes, source_bytes = args.kinematics.read_bytes(), args.source.read_bytes()
    if hashlib.sha256(kin_bytes).hexdigest() != KIN_SHA:
        parser.error("official kinematics hash mismatch: review changes before regenerating")
    result = retarget(json.loads(source_bytes), json.loads(kin_bytes), args.iterations, progress=True, home_mode=args.home)
    result["source"]["source_excerpt_sha256"] = hashlib.sha256(source_bytes).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
    print(json.dumps({"frames": len(result["time"]), "stats": result["stats"], "diagnostics": result["solver"]["diagnostics"]}, indent=2))


if __name__ == "__main__":
    main()
