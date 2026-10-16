#!/usr/bin/env python3
"""Export a non-audio NymeriaPlus MHR excerpt, without any robot or body mesh.

Dependencies: numpy, scipy. Input: a user-obtained optimized xdata_mhr.glb.
Source coordinates/timestamps are interpreted from standard glTF and the
FB_momentum timestamp extension. No private workspace modules are imported.
The output is a CC BY-NC 4.0 derivative, NOT covered by the viewer's MIT license.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import mmap
from pathlib import Path
import struct

import numpy as np
from scipy.spatial.transform import Rotation

ZUP = np.array([[1., 0., 0.], [0., 0., -1.], [0., 1., 0.]])
ANATOMY = {"left": "l_wrist", "right": "r_wrist", "elbow_left": "l_lowarm",
           "elbow_right": "r_lowarm", "shoulder_left": "l_uparm", "shoulder_right": "r_uparm", "hip": "root"}
BODY_JOINTS = ["root", "c_spine0", "c_spine1", "c_spine2", "c_spine3", "c_neck", "c_head",
               *[f"{side}_{joint}" for side in ("l", "r") for joint in ("clavicle", "uparm", "lowarm", "wrist", "upleg", "lowleg", "foot", "ball")]]
SITES = ("left", "right", "elbow_left", "elbow_right", "chest", "footprint")


class MHRReader:
    """Strict standard baked glTF FK reader; never evaluate mesh geometry."""
    def __init__(self, path):
        self.file = Path(path).open("rb")
        self.data = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        magic, version, length = struct.unpack_from("<4sII", self.data)
        if magic != b"glTF" or version != 2 or length != len(self.data):
            raise ValueError("Expected complete glTF 2 binary")
        cursor, document, self.binary_offset, self.binary_length = 12, None, None, 0
        while cursor < length:
            size, kind = struct.unpack_from("<I4s", self.data, cursor); cursor += 8
            if cursor + size > length:
                raise ValueError("GLB chunk exceeds file")
            if kind == b"JSON":
                document = json.loads(self.data[cursor:cursor + size])
            elif kind == b"BIN\0":
                self.binary_offset, self.binary_length = cursor, size
            cursor += size
        if document is None or self.binary_offset is None:
            raise ValueError("Embedded JSON and binary buffer required")
        self.document = document
        self.nodes = document.get("nodes", [])
        self.names = [node.get("name", f"node_{i}") for i, node in enumerate(self.nodes)]
        self.parents = np.full(len(self.nodes), -1, dtype=int)
        for i, node in enumerate(self.nodes):
            for child in node.get("children", []):
                if child < 0 or child >= len(self.nodes) or self.parents[child] != -1:
                    raise ValueError("Invalid/multiply parented skeleton")
                self.parents[child] = i
        self.order, active = [], set()
        def visit(index):
            if index in active:
                raise ValueError("Cyclic skeleton")
            active.add(index); self.order.append(index)
            for child in self.nodes[index].get("children", []):
                visit(child)
            active.remove(index)
        for index in np.flatnonzero(self.parents < 0):
            visit(int(index))
        if len(self.order) != len(self.nodes):
            raise ValueError("Disconnected cyclic skeleton")
        self.joint_indices = sorted(set(j for skin in document.get("skins", []) for j in skin["joints"]))
        self.joint_names = [self.names[j] for j in self.joint_indices]
        if not self.joint_indices or len(set(self.joint_names)) != len(self.joint_names):
            raise ValueError("Missing or ambiguous skin joints")
        self.name_to_index = dict(zip(self.joint_names, self.joint_indices))
        animations = document.get("animations", [])
        if len(animations) != 1:
            raise ValueError("Exactly one baked animation is required")
        self.channels, timelines = [], []
        for channel in animations[0].get("channels", []):
            target = channel["target"]
            if target["path"] == "weights":
                continue
            if target["path"] not in ("translation", "rotation", "scale"):
                raise ValueError("Unsupported animation channel")
            sampler = animations[0]["samplers"][channel["sampler"]]
            if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP"):
                raise ValueError("Unsupported interpolation; refusing approximation")
            times, values = self.accessor(sampler["input"]).reshape(-1).astype(float), self.accessor(sampler["output"])
            if len(times) != len(values) or len(times) < 2 or np.any(np.diff(times) <= 0):
                raise ValueError("Invalid animation clock")
            self.channels.append((target["node"], target["path"], values)); timelines.append(times)
        if not timelines or any(not np.array_equal(timelines[0], t) for t in timelines):
            raise ValueError("One shared native frame grid is required")
        extension = document.get("extensions", {}).get("FB_momentum", {})
        timestamps = extension.get("motion", {}).get("timestamps")
        if timestamps is None:
            raise ValueError("FB_momentum timestamps required; do not infer a camera clock")
        timestamps = np.asarray(timestamps, np.int64)
        if timestamps.shape != timelines[0].shape or np.any(np.diff(timestamps) <= 0):
            raise ValueError("Invalid absolute timestamp mapping")
        self.times = (timestamps - timestamps[0]).astype(float) / 1e6
        self.fps = float(extension.get("fps", 1 / np.median(np.diff(self.times))))

    def accessor(self, index):
        a = self.document["accessors"][index]
        if "sparse" in a or a.get("normalized"):
            raise ValueError("Sparse/normalized animation accessor unsupported")
        view = self.document["bufferViews"][a["bufferView"]]
        if view.get("buffer", 0) != 0:
            raise ValueError("External animation buffer unsupported")
        dtype = np.dtype({5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[a["componentType"]])
        components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        count, stride = int(a["count"]), int(view.get("byteStride", dtype.itemsize * components))
        local = int(a.get("byteOffset", 0)); extent = max(0, count - 1) * stride + components * dtype.itemsize
        offset = int(view.get("byteOffset", 0)) + local
        if count < 0 or stride < dtype.itemsize * components or local + extent > int(view["byteLength"]) or offset + extent > self.binary_length:
            raise ValueError("Animation accessor exceeds buffer")
        return np.ndarray((count, components), dtype=dtype, buffer=self.data, offset=self.binary_offset + offset, strides=(stride, dtype.itemsize))

    def fk(self, indices, names):
        indices = np.asarray(indices, int); n = len(indices)
        requested = [self.name_to_index[name] for name in names]; needed = set(requested)
        for joint in requested:
            while self.parents[joint] >= 0:
                joint = int(self.parents[joint]); needed.add(joint)
        components = {}
        for j in needed:
            node = self.nodes[j]
            if "matrix" in node:
                matrix = np.asarray(node["matrix"], float).reshape(4, 4).T
                scale = np.linalg.norm(matrix[:3, :3], axis=0); rotation = matrix[:3, :3] / scale; translation = matrix[:3, 3]
            else:
                translation = node.get("translation", [0., 0., 0.]); rotation = Rotation.from_quat(node.get("rotation", [0., 0., 0., 1.])).as_matrix(); scale = node.get("scale", [1., 1., 1.])
            components[j] = [np.tile(translation, (n, 1)), np.tile(rotation, (n, 1, 1)), np.tile(scale, (n, 1))]
        for j, channel, values in self.channels:
            if j in needed:
                selected = np.asarray(values[indices], float)
                components[j][{"translation": 0, "rotation": 1, "scale": 2}[channel]] = Rotation.from_quat(selected).as_matrix() if channel == "rotation" else selected
        world, result = {}, {}
        axis = np.eye(4); axis[:3, :3] = ZUP
        for j in self.order:
            if j not in needed:
                continue
            translation, rotation, scale = components[j]
            local = np.repeat(np.eye(4)[None], n, axis=0); local[:, :3, :3] = rotation * scale[:, None, :]; local[:, :3, 3] = translation
            world[j] = local if self.parents[j] < 0 else world[self.parents[j]] @ local
        for j in requested:
            poses = axis @ world[j]; scales = np.linalg.norm(poses[:, :3, :3], axis=1)
            if np.any(scales < 1e-8):
                raise ValueError("Degenerate skeleton scale")
            rotations = poses[:, :3, :3] / scales[:, None, :]
            if np.max(np.linalg.norm(rotations.transpose(0, 2, 1) @ rotations - np.eye(3), axis=(1, 2))) > 1e-4 or np.any(np.linalg.det(rotations) < 0):
                raise ValueError("Sheared/non-rigid skeleton orientation")
            poses[:, :3, :3] = Rotation.from_matrix(rotations).as_matrix(); result[self.names[j]] = poses
        return result

    def close(self):
        self.channels = []
        self.data.close(); self.file.close()


def chest_frame(left, right, pelvis):
    center = (left + right) * .5
    y = left - right; y /= np.linalg.norm(y)
    z = center - pelvis; z -= y * np.dot(y, z); z /= np.linalg.norm(z)
    x = np.cross(y, z)
    result = np.eye(4); result[:3, :3] = np.column_stack((x, y, z)); result[:3, 3] = center
    return result


def summarize(values):
    values = np.asarray(values, float); values = values[np.isfinite(values)]
    if not len(values):
        return None
    return {"n": len(values), "mean": float(np.mean(values)), "p95": float(np.percentile(values, 95)), "max": float(np.max(values))}


def extract(reader, start, duration, display_fps=30.):
    if not all(math.isfinite(x) for x in (start, duration, display_fps)) or start < 0 or duration <= 0 or display_fps <= 0:
        raise ValueError("Invalid requested interval or display rate")
    indices = np.flatnonzero((reader.times >= start - 1e-9) & (reader.times <= start + duration + 1e-9))
    if len(indices) < 2:
        raise ValueError("Crop has fewer than two native frames")
    names = [name for name in BODY_JOINTS if name in reader.name_to_index]
    if any(name not in names for name in ANATOMY.values()):
        raise ValueError("Expected MHR anatomical joints are absent; add an explicit verified mapping")
    raw = reader.fk(indices, names); times = reader.times[indices]; n = len(indices); dt = np.diff(times)
    sites = {site: raw[ANATOMY[site]].copy() for site in SITES[:4]}
    chest = np.repeat(np.eye(4)[None], n, axis=0); chest_valid = np.zeros(n, bool)
    for i in range(n):
        left, right, hip = [raw[ANATOMY[key]][i, :3, 3] for key in ("shoulder_left", "shoulder_right", "hip")]
        if .1 < np.linalg.norm(left - right) < .8 and .1 < np.linalg.norm((left + right) / 2 - hip) < 1.:
            frame = chest_frame(left, right, hip)
            if np.all(np.isfinite(frame)):
                chest[i], chest_valid[i] = frame, True
    sites["chest"] = chest
    hip = raw[ANATOMY["hip"]]
    candidates = np.flatnonzero(chest_valid & np.all(np.isfinite(hip), axis=(1, 2)))
    if not len(candidates):
        raise ValueError("No valid pelvis/chest heading calibration frame")
    heading_index = int(candidates[0]); dots = hip[heading_index, :3, :3].T @ chest[heading_index, :3, 0]
    axis = int(np.argmax(np.abs(dots))); sign = 1. if dots[axis] >= 0 else -1.
    directions = hip[:, :3, axis] * sign
    fp = np.repeat(np.eye(4)[None], n, axis=0); fp[:, :2, 3] = hip[:, :2, 3]
    fp_valid = np.all(np.isfinite(hip[:, :3, 3]), axis=1)
    fp_rotation_valid = fp_valid & np.all(np.isfinite(hip[:, :3, :3]), axis=(1, 2)) & (np.linalg.norm(directions[:, :2], axis=1) > .2)
    fp[fp_rotation_valid, :3, :3] = Rotation.from_euler("z", np.arctan2(directions[fp_rotation_valid, 1], directions[fp_rotation_valid, 0])[:, None]).as_matrix()
    sites["footprint"] = fp
    pv = {site: np.all(np.isfinite(value[:, :3, 3]), axis=1) for site, value in sites.items()}
    ov = {site: np.all(np.isfinite(value[:, :3, :3]), axis=(1, 2)) & pv[site] for site, value in sites.items()}
    pv["chest"] = chest_valid.copy(); ov["chest"] = chest_valid.copy(); pv["footprint"] = fp_valid; ov["footprint"] = fp_rotation_valid
    ov["elbow_left"][:] = False; ov["elbow_right"][:] = False
    filters = {}
    for site, value in sites.items():
        threshold = 4. if site in SITES[:4] else 2.5
        speeds = np.linalg.norm(np.diff(value[:, :3, 3], axis=0), axis=1) / dt
        bad = np.flatnonzero(pv[site][:-1] & pv[site][1:] & (speeds > threshold)); flagged = np.unique(np.r_[bad, bad + 1])
        pv[site][flagged] = False; ov[site][flagged] = False
        pairs = np.flatnonzero(ov[site][:-1] & ov[site][1:]); angular_bad = np.array([], int)
        if len(pairs):
            delta = value[pairs + 1, :3, :3] @ value[pairs, :3, :3].transpose(0, 2, 1)
            bad = pairs[Rotation.from_matrix(delta).magnitude() / dt[pairs] > 20.]; angular_bad = np.unique(np.r_[bad, bad + 1]); ov[site][angular_bad] = False
        filters[site] = {"position_threshold_m_s": threshold, "angular_threshold_rad_s": 20., "position_flagged_frames": len(flagged), "orientation_flagged_frames": len(angular_bad)}
    common = np.logical_and.reduce([pv[s] & (ov[s] if not s.startswith("elbow") else True) for s in SITES])
    if not np.any(common):
        raise ValueError("No common valid six-site initial frame")
    t0 = int(np.flatnonzero(common)[0]); alignment = np.linalg.inv(fp[t0])
    sites = {site: alignment @ values for site, values in sites.items()}
    raw = {name: alignment @ values for name, values in raw.items()}
    edges = []
    for name in names:
        parent = int(reader.parents[reader.name_to_index[name]])
        while parent >= 0 and reader.names[parent] not in names:
            parent = int(reader.parents[parent])
        if parent >= 0:
            edges.append([reader.names[parent], name])
    stride = max(1, round(reader.fps / display_fps)); selected = np.unique(np.r_[np.arange(t0, n, stride), n - 1]).astype(int)
    def rounded(values):
        values = np.round(np.asarray(values), 6)
        return np.where(np.isfinite(values), values, None).tolist()
    targets = {}
    for site, values in sites.items():
        targets[site] = {"p": rounded(values[selected, :3, 3]), "q": None if site.startswith("elbow") else rounded(Rotation.from_matrix(values[selected, :3, :3]).as_quat()), "pv": pv[site][selected].tolist(), "ov": ov[site][selected].tolist()}
        # Never bridge a masked native interval that display decimation skipped.
        targets[site]["interval_pv"] = [bool(np.all(pv[site][a:b + 1]) and times[b] - times[a] <= .1) for a, b in zip(selected[:-1], selected[1:])]
        targets[site]["interval_ov"] = [bool(np.all(ov[site][a:b + 1]) and times[b] - times[a] <= .1) for a, b in zip(selected[:-1], selected[1:])]
    motion = {"sampling": "Native timestamp intervals (~240 Hz), valid URR endpoints; before display decimation", "units": "m/s"}
    for site in ("left", "right", "chest", "footprint"):
        speeds = np.linalg.norm(np.diff(sites[site][t0:, :3, 3], axis=0), axis=1) / dt[t0:]
        motion[site] = summarize(speeds[pv[site][t0:-1] & pv[site][t0 + 1:]])
    return {"schema": "ego-urr-lab.nymeria.v1", "time": rounded(times[selected] - times[t0]), "source_time": rounded(times[selected]),
            "skeleton": {"joints": names, "edges": edges, "positions": rounded(np.stack([raw[name][selected, :3, 3] for name in names], axis=1))},
            "targets": targets, "motionStats": motion,
            "extraction": {"anatomy": ANATOMY, "chest": "Shoulder midpoint. Y=left-right; Z=pelvis-to-midpoint orthogonalized against Y; X=Y cross Z. Geometric proxy, not measured sternum.",
                           "footprint": {"position": "Pelvis horizontal projection onto Aria z=0 (not measured floor)", "heading": "One fixed signed pelvis-local axis selected against initial chest forward; yaw from its horizontal projection", "axis": axis, "sign": sign, "calibration_source_frame": int(indices[heading_index])},
                           "coordinate_frame": "Metres, Z-up. glTF (x,y,z) -> (x,-z,y), then one fixed inverse initial footprint transform shared by raw skeleton and every site.",
                           "alignment": alignment.tolist(), "source_fps": reader.fps, "display_fps": reader.fps / stride, "native_frame_count": n - t0, "exported_frame_count": len(selected),
                           "source_frame_start": int(indices[t0]), "source_frame_end": int(indices[-1]), "actual_start_s": float(times[t0]), "actual_end_s": float(times[-1]),
                           "native_dt_min_s": float(np.min(dt)), "native_dt_max_s": float(np.max(dt)), "display_selection": f"Every {stride}th native sample plus final sample; original nonuniform timestamps retained, no display resampling",
                           "continuity_filter": filters, "confidence": "Not supplied. Validity means numeric/geometric/continuity checks only.",
                           "robot_retarget": "Not performed. No robot state, IK result, tracking error, collision or dynamics claim.", "raw_rotation": "Reduced skeleton exports positions only; wrist/chest/footprint orientations are preserved in derived targets."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Locally obtained optimized MHR GLB")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sequence-id", required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--display-fps", type=float, default=30.)
    parser.add_argument("--overwrite-derived", action="store_true", help="Replace only an existing export with this script's schema")
    args = parser.parse_args()
    if args.output.exists():
        if not args.overwrite_derived or args.output.resolve() == args.source.resolve() or json.loads(args.output.read_text()).get("schema") != "ego-urr-lab.nymeria.v1":
            parser.error("Refusing to overwrite; use --overwrite-derived only for this script's existing JSON export")
    if not args.sequence_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in args.sequence_id):
        parser.error("Sequence ID must not contain paths or signed URLs")
    reader = MHRReader(args.source)
    try:
        document = extract(reader, args.start, args.duration, args.display_fps)
    finally:
        reader.close()
    digest = hashlib.sha256()
    with args.source.open("rb") as stream:
        while block := stream.read(4 * 1024 * 1024):
            digest.update(block)
    document["extraction"]["source_sha256"] = digest.hexdigest()
    document["source"] = {"dataset": "NymeriaPlus", "release": "v1.0", "sequence_id": args.sequence_id, "sequence_url": "https://explorer.projectaria.com/nymeria_plus/" + args.sequence_id, "kind": "Optimized MHR human-body estimate; not original Nymeria XSens or independent ground truth", "url": "https://github.com/facebookresearch/nymeria_dataset", "requested_start_s": args.start, "requested_duration_s": args.duration}
    document["license"] = {"id": "CC-BY-NC-4.0", "url": "https://creativecommons.org/licenses/by-nc/4.0/", "source_url": "https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE", "attribution": "NymeriaPlus Dataset, Meta Platforms, Inc. and affiliates", "copyright": "Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.", "notice": "Non-audio numerical derivative. Noncommercial use only; provided AS-IS without warranty. No endorsement implied.", "changes": "Read-only GLB skeleton FK; Y-up to Z-up conversion; fixed initial-footprint alignment; chest/footprint proxies; explicit validity masks; reduced skeleton; temporal decimation and six-decimal rounding. No audio, video, body mesh or robot trajectory included."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, separators=(",", ":"), allow_nan=False) + "\n")
    print(json.dumps({"frames": len(document["time"]), "joints": len(document["skeleton"]["joints"]), "duration_s": document["time"][-1], "bytes": args.output.stat().st_size, "source_sha256": digest.hexdigest()}))


if __name__ == "__main__":
    main()
