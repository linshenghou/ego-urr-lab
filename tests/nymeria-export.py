"""Independent synthetic GLB tests; no downloaded data or private modules.

Run: python -B tests/nymeria-export.py (requires numpy and scipy).
"""
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

import numpy as np

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/export-nymeria.py"
spec = importlib.util.spec_from_file_location("public_nymeria_export", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def synthetic_glb(path):
    nodes = [{"name": "root", "translation": [0, 1, 0], "children": [1, 4]}]
    for side, lateral, start in (("l", -.2, 1), ("r", .2, 4)):
        nodes += [{"name": f"{side}_uparm", "translation": [0, .5, lateral], "children": [start + 1]},
                  {"name": f"{side}_lowarm", "translation": [.25, -.1, 0], "children": [start + 2]},
                  {"name": f"{side}_wrist", "translation": [.25, -.1, 0]}]
    times = np.array([0, .25, .5, .75, 1], dtype="<f4")
    translation = np.array([[x, 1, 0] for x in [0, .1, .2, .3, .4]], dtype="<f4")
    binary = times.tobytes() + translation.tobytes()
    doc = {"asset": {"version": "2.0"}, "nodes": nodes, "skins": [{"joints": list(range(7))}],
           "buffers": [{"byteLength": len(binary)}],
           "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": times.nbytes}, {"buffer": 0, "byteOffset": times.nbytes, "byteLength": translation.nbytes}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 5, "type": "SCALAR"}, {"bufferView": 1, "componentType": 5126, "count": 5, "type": "VEC3"}],
           "animations": [{"samplers": [{"input": 0, "output": 1}], "channels": [{"sampler": 0, "target": {"node": 0, "path": "translation"}}]}],
           "extensions": {"FB_momentum": {"fps": 4, "motion": {"timestamps": [1000000, 1240000, 1510000, 1750000, 2020000]}}}}
    payload = json.dumps(doc).encode(); payload += b" " * (-len(payload) % 4)
    total = 12 + 8 + len(payload) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(payload), b"JSON") + payload + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / "synthetic.glb"
        synthetic_glb(self.source)

    def tearDown(self):
        self.directory.cleanup()

    def test_real_hierarchy_fk_metric_zup_and_absolute_timestamp_extension(self):
        reader = exporter.MHRReader(self.source)
        try:
            np.testing.assert_allclose(reader.times, [0, .24, .51, .75, 1.02])
            fk = reader.fk([0, 2], ["l_wrist", "r_uparm"])
            np.testing.assert_allclose(fk["l_wrist"][:, :3, 3], [[.5, .2, 1.3], [.7, .2, 1.3]], atol=1e-7)
            np.testing.assert_allclose(fk["r_uparm"][:, :3, 3], [[0, -.2, 1.5], [.2, -.2, 1.5]], atol=1e-7)
            self.assertAlmostEqual(np.linalg.det(fk["l_wrist"][0, :3, :3]), 1)
        finally:
            reader.close()

    def test_derived_chest_footprint_and_original_timestamps_survive_decimation(self):
        reader = exporter.MHRReader(self.source)
        try:
            result = exporter.extract(reader, 0, 2, 2)
        finally:
            reader.close()
        self.assertEqual(result["time"], [0, .51, 1.02])
        np.testing.assert_allclose(result["targets"]["chest"]["p"][0], [0, 0, 1.5])
        np.testing.assert_allclose(result["targets"]["chest"]["q"][0], [0, 0, 0, 1])
        np.testing.assert_allclose(result["targets"]["footprint"]["p"][0], [0, 0, 0])
        self.assertEqual(result["targets"]["elbow_left"]["q"], None)
        self.assertEqual(result["targets"]["elbow_left"]["ov"], [False] * 3)
        self.assertEqual(result["extraction"]["native_frame_count"], 5)
        self.assertEqual(result["motionStats"]["left"]["n"], 4)
        # Display intervals >0.1s remain invalid for interpolation, not invented continuity.
        self.assertEqual(result["targets"]["left"]["interval_pv"], [False, False])

    def test_cli_public_provenance_allowlist_and_safe_overwrite_policy(self):
        output = self.root / "excerpt.json"
        command = [sys.executable, "-B", str(SCRIPT), str(self.source), "--output", str(output), "--sequence-id", "synthetic_test", "--start", "0", "--duration", "2"]
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(command, capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(output.read_text())
        self.assertEqual(set(document), {"schema", "time", "source_time", "skeleton", "targets", "motionStats", "extraction", "source", "license"})
        self.assertEqual(document["license"]["id"], "CC-BY-NC-4.0")
        self.assertEqual(document["source"]["release"], "v1.0")
        self.assertNotIn(str(self.root), output.read_text())
        self.assertNotEqual(subprocess.run(command, capture_output=True, env=environment).returncode, 0)
        self.assertEqual(subprocess.run(command + ["--overwrite-derived"], capture_output=True, env=environment).returncode, 0)


if __name__ == "__main__":
    unittest.main()
