"""Synthetic, network-free tests of authored Taku retarget math.

The fixture is a made-up tree with the expected names, NOT copied robot assets.
Optionally set TAKU_KINEMATICS to a separately obtained official JSON to verify
the complete packaged trajectories against independent FK evaluation.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
import numpy as np
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("taku_retarget", ROOT / "scripts/retarget-taku.py")
MODULE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)


def fixture():
    joints = []
    def add(name, parent, child, xyz, axis=(0, 1, 0), kind="revolute", rpy=(0, 0, 0)):
        joints.append(dict(name=name, parent=parent, child=child, xyz=list(xyz), rpy=list(rpy), axis=list(axis), type=kind))
    previous = "agv_base"
    for i, name in enumerate(MODULE.BODY):
        child = "torso_body_link" if i == 3 else f"body_fixture_{i}"
        add(name, previous, child, [.03 * (-1) ** i, 0, .2], [0, 0, 1] if i == 3 else [0, 1, 0]); previous = child
    for side, sign in (("left", 1), ("right", -1)):
        previous = "torso_body_link"
        for i, name in enumerate(MODULE.ARM):
            child = f"{side}_elbow_link" if i == 3 else f"{side}_fixture_{i}"
            axis = [0, 1, 0] if i in (0, 3, 5) else [1, 0, 0] if i in (1, 6) else [0, 0, 1]
            add(f"{side}_{name}", previous, child, [0, sign * .2 if i == 0 else 0, .2 if i == 0 else -.08], axis)
            previous = child
        add(f"{side}_fixed", previous, f"{side}_ee_fk_target_frame", [.01, 0, -.07], kind="fixed", rpy=(.1, -.2, .3))
    return {"root": "agv_base", "joints": list(reversed(joints))}


def source_fixture(model):
    q0 = MODULE.HOME.copy(); q1 = q0.copy(); q1[:3] = [.03, -.01, .06]; q1[9] += .05
    frames = [model.fk(q) for q in (q0, q1, q1)]
    targets = {}
    for site in MODULE.SITES:
        elbow = site.startswith("elbow")
        targets[site] = {"p": [frame[site][:3, 3].tolist() for frame in frames],
                         "q": None if elbow else [Rotation.from_matrix(frame[site][:3, :3]).as_quat().tolist() for frame in frames],
                         "pv": [True] * 3, "ov": [not elbow] * 3,
                         "interval_pv": [True, True], "interval_ov": [not elbow] * 2}
    return {"schema": "ego-urr-lab.nymeria.v1", "time": [0., .0332, .068], "source_time": [5., 5.0332, 5.068],
            "targets": targets, "source": {"sequence_id": "synthetic_test"},
            "license": {"id": "CC-BY-NC-4.0", "changes": "Synthetic test fixture."}}


class RetargetTests(unittest.TestCase):
    def setUp(self):
        self.kin = fixture(); self.model = MODULE.Taku(self.kin)

    def test_geometric_jacobian_agrees_with_finite_differences(self):
        q = MODULE.HOME.copy(); q[2] = .3
        poses, jacobians = self.model.fk(q, jacobians=True)
        epsilon = 1e-6
        for column in range(21):
            step = np.zeros(21); step[column] = epsilon
            moved = self.model.fk(q + step)
            for site in MODULE.SITES:
                dp = (moved[site][:3, 3] - poses[site][:3, 3]) / epsilon
                dr = Rotation.from_matrix(moved[site][:3, :3] @ poses[site][:3, :3].T).as_rotvec() / epsilon
                np.testing.assert_allclose(np.r_[dp, dr], jacobians[site][:, column], atol=1e-6)

    def test_large_orientation_residual_derivative(self):
        q = MODULE.HOME.copy(); poses, jac = self.model.fk(q, jacobians=True)
        desired_q = q.copy(); desired_q[2] = .7; desired_q[7] -= .5
        desired = self.model.fk(desired_q); masks = {site: (True, not site.startswith("elbow")) for site in MODULE.SITES}
        residual, matrix = MODULE.task_system(poses, desired, masks, jac)
        for column in range(21):
            moved_q = q.copy(); moved_q[column] += 1e-6
            moved, _ = MODULE.task_system(self.model.fk(moved_q), desired, masks)
            np.testing.assert_allclose((residual - moved) / 1e-6, matrix[:, column], atol=3e-6)

    def test_relative_mapping_first_frame_home_not_source_absolute_height(self):
        source = source_fixture(self.model)
        for site in MODULE.SITES:
            source["targets"][site]["p"] = (np.array(source["targets"][site]["p"]) + [2., -1., 3.]).tolist()
        home = self.model.fk(MODULE.HOME); targets, matrices = MODULE.map_targets(source, home)
        for site in MODULE.SITES:
            np.testing.assert_allclose(targets[site]["p"][0], home[site][:3, 3], atol=1e-12)
            if not site.startswith("elbow"):
                np.testing.assert_allclose(matrices[site][0], home[site], atol=1e-12)
        self.assertIsNone(targets["elbow_left"]["q"])

    def test_real_optimization_and_saved_error_masks(self):
        source = source_fixture(self.model); source["targets"]["right"]["pv"][2] = False
        output = MODULE.retarget(source, self.kin)
        q = np.asarray(output["q"])
        np.testing.assert_allclose(q[0], MODULE.HOME)
        self.assertGreater(np.linalg.norm(q[1] - q[0]), .01)
        self.assertLess(output["errors"]["left"]["position_m"][1], .003)
        self.assertIsNone(output["errors"]["right"]["position_m"][2])
        self.assertIsNone(output["stats"]["elbow_left"]["orientation"])
        self.assertFalse(output["solver"]["actuator_velocity_limits"])
        self.assertFalse(output["solver"]["bounds_are_manufacturer_limits"])
        self.assertTrue(np.all(np.abs(np.diff(q, axis=0)) <= MODULE.FRAME_TRUST + 2e-9))
        for i in range(3):
            poses = self.model.fk(q[i])
            for site in MODULE.SITES:
                np.testing.assert_allclose(poses[site][:3, 3], output["actual"][site]["p"][i], atol=1e-9)

    def test_unreachable_target_retains_finite_bounds_and_monotonic_merit(self):
        desired = self.model.fk(MODULE.HOME)
        desired["left"] = desired["left"].copy(); desired["left"][:3, 3] += [8, 4, 10]
        masks = {site: (True, not site.startswith("elbow")) for site in MODULE.SITES}
        q, diagnostics = MODULE.solve_frame(self.model, MODULE.HOME, desired, masks)
        self.assertTrue(np.all(np.isfinite(q)))
        self.assertTrue(np.all(q >= MODULE.LOWER - 1e-10)); self.assertTrue(np.all(q <= MODULE.UPPER + 1e-10))
        self.assertLessEqual(diagnostics["final_objective"], diagnostics["initial_objective"])
        self.assertTrue(np.all(np.abs(q - MODULE.HOME) <= MODULE.FRAME_TRUST + 1e-9))
        self.assertTrue(diagnostics["frame_trust_active"])

    def test_source_conditioned_home_is_explicit_and_does_not_scale_motion(self):
        source = source_fixture(self.model)
        for site in ("left", "right"):
            source["targets"][site]["p"][0][2] = source["targets"]["chest"]["p"][0][2] - .6
        home, metadata = MODULE.select_home(source)
        self.assertEqual(metadata["selected"], "arms-down")
        self.assertEqual(home[10], -.25); self.assertEqual(home[17], -.25)
        _, explicit = MODULE.select_home(source, "bent-elbow")
        self.assertEqual(explicit["selected"], "bent-elbow")
        targets, _ = MODULE.map_targets(source, self.model.fk(home))
        for site in MODULE.SITES:
            np.testing.assert_allclose(np.diff(targets[site]["p"], axis=0), np.diff(source["targets"][site]["p"], axis=0), atol=1e-12)

    @unittest.skipUnless(os.environ.get("TAKU_KINEMATICS"), "official asset is deliberately not bundled")
    def test_all_public_frames_against_official_fk(self):
        import hashlib
        data = Path(os.environ["TAKU_KINEMATICS"]).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), MODULE.KIN_SHA)
        model = MODULE.Taku(json.loads(data))
        for name in ("housework-hands", "housework-long"):
            output = json.loads((ROOT / "public/data/nymeria" / (name + "-taku.json")).read_text())
            source_bytes = (ROOT / "public/data/nymeria" / (name + ".json")).read_bytes()
            self.assertEqual(hashlib.sha256(source_bytes).hexdigest(), output["source"]["source_excerpt_sha256"])
            q = np.asarray(output["q"])
            self.assertTrue(np.all(q >= MODULE.LOWER - 1e-9)); self.assertTrue(np.all(q <= MODULE.UPPER + 1e-9))
            self.assertTrue(np.all(np.abs(np.diff(q, axis=0)) <= MODULE.FRAME_TRUST + 2e-9))
            for i in range(len(q)):
                poses = model.fk(q[i])
                for site in MODULE.SITES:
                    np.testing.assert_allclose(poses[site][:3, 3], output["actual"][site]["p"][i], atol=6e-9)
                    error = output["errors"][site]["position_m"][i]
                    if error is not None:
                        expected = np.linalg.norm(poses[site][:3, 3] - output["targets"][site]["p"][i])
                        self.assertAlmostEqual(error, expected, places=8)
                    angle = output["errors"][site]["orientation_rad"][i]
                    if angle is not None:
                        expected = Rotation.from_matrix(Rotation.from_quat(output["targets"][site]["q"][i]).as_matrix() @ poses[site][:3, :3].T).magnitude()
                        self.assertAlmostEqual(angle, expected, places=8)
            for site in MODULE.SITES:
                for metric, key in (("position", "position_m"), ("orientation", "orientation_rad")):
                    recomputed = MODULE.summarize(output["errors"][site][key])
                    self.assertEqual(output["stats"][site][metric], recomputed)


if __name__ == "__main__":
    unittest.main()
