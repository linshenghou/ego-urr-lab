# NymeriaPlus: skeleton → URR → authored Taku IK

This is an independent, noncommercial study of a human motion representation and robot retargeting. Two bundled source excerpts contain **human skeleton motion and quantities derived from it**. Two companion artifacts contain **our genuinely optimized Taku joint configurations and FK residuals**. These are not official Dyna motion, hardware measurements, a learned policy, or a reproduction of Dyna's training pipeline. The public player is Nymeria-only; source extraction and robot retargeting remain distinct stages.

## Source and permission

Source dataset: **NymeriaPlus v1.0**, official sequence `20231222_s1_kenneth_fischer_act6_kbpn0q` (UID `kbpn0q`), housekeeping activity. The source is the optimized MHR human-body estimate in `body/xdata_mhr.glb`, not original Nymeria XSens data and not independent motion-capture ground truth. See the [official dataset repository](https://github.com/facebookresearch/nymeria_dataset) and [official sequence page](https://explorer.projectaria.com/nymeria_plus/20231222_s1_kenneth_fischer_act6_kbpn0q).

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

The [official NymeriaPlus license](https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE) separates audio from the remainder of the dataset. These **non-audio numeric adaptations** are distributed under **[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)**, not the repository's MIT code license. Sharing or adapting them requires compliance with that license, including noncommercial use, attribution, preservation of applicable notices, and an indication of changes. No endorsement is implied. The data are provided as-is, without warranties; consult the full license for its disclaimer and limitation of liability.

The [full original split-license text](../licenses/NYMERIAPLUS-DATA-LICENSE.txt) is preserved verbatim, including Section A for context; **Section B applies to these excerpts**. No audio is redistributed. The license-file SHA-256 is `bcf386cc34840ba008feadfc90c16a795210e2ed18bbfab01f647ccf5b435691`.

## Published excerpts

| File | Requested source-relative interval | Purpose |
|---|---|---|
| `public/data/nymeria/housework-long.json` | 30–150 s | Longer walking/manipulation context |
| `public/data/nymeria/housework-hands.json` | 562.5–577.5 s | Shorter hand-motion inspection |
| `public/data/nymeria/housework-long-taku.json` | Same retained long-clip timestamps | Authored IK solution, mapped targets, FK and errors |
| `public/data/nymeria/housework-hands-taku.json` | Same retained short-clip timestamps | Authored IK solution, mapped targets, FK and errors |

Both source excerpts are cropped from the same source recording. They retain source-relative timestamps alongside an excerpt-relative clock. Exact retained endpoints, native frame counts and display frame counts are in the source JSON's `extraction` object. Each robot companion preserves that excerpt's clock and pins its input-file SHA-256. A source-relative interval is not a wall-clock time or a camera synchronization claim.

The source excerpts contain 23 selected major-body joint positions, skeleton edges, six derived task quantities, validity masks and numerical provenance/statistics. The companions add 21 optimized variables, mapped target/achieved poses, explicit solver/mapping metadata and residual summaries. All four are non-audio numerical adaptations under CC BY-NC 4.0. No raw GLB, skinned mesh, model weights, video, images, audio, participant demographics, private robot geometry or third-party robot assets are included. The official sequence identifier is retained for provenance, not as a claim about participant identity. Signed download URLs are not stored or published.

The reviewed source GLB SHA-256 is `08d7caad28d066969d023d6f1424a5b0e1daa850cd85601a49f51189a0fea653`. Each exported file's byte count and SHA-256 are pinned separately in [the publication manifest](../scripts/nymeria-assets.json). These hashes establish which inputs/outputs were inspected; they are not evidence that the motion estimates are physically accurate.

## Processing and changes

The standalone [exporter](../scripts/export-nymeria.py) reads the baked glTF animation and the source `FB_momentum` timestamps. It does not load the mesh geometry or require model weights. The inspected stream is approximately 240 Hz.

1. **Skeleton FK.** Compose animated local transforms through the file's parent hierarchy, using that file's own rest transforms and scales. This uses the recorded skeleton, not a newly assumed generic set of limb lengths.
2. **Shared coordinates.** Convert glTF Y-up metres to Z-up with `(x, y, z) → (x, −z, y)`. Apply one inverse initial-footprint transform to the skeleton and every extracted quantity. This removes initial horizontal translation/yaw while preserving source height; it is not independent alignment of each body part.
3. **Task extraction.** Derive the sites in the table below. They are our URR-like research definitions, not official NymeriaPlus URR labels or robot-frame calibration.
4. **Validity checks.** Compute geometric and continuity flags at native timestamps before display decimation. Retain explicit per-frame and per-interval masks; a viewer must not interpolate across invalid skipped native samples.
5. **Compact export.** Select every eighth native frame (approximately 30 Hz) plus the final sample, preserving original nonuniform timestamps. Round numeric arrays to six decimal places. This is temporal decimation, not a new measurement stream or smoothing filter.

The initial alignment uses the first frame in the requested crop where all required site quantities pass the checks; this may skip an invalid leading portion. The raw skeleton positions remain an estimate to inspect, not a claim that every displayed joint has passed the task-site validity checks.

| Quantity | Source joints | Definition and limits |
|---|---|---|
| Left/right wrist pose | `l_wrist`, `r_wrist` | Anatomical wrist joint origin and rotation from FK; not the wristband device trajectory or a calibrated robot flange frame |
| Left/right elbow position | `l_lowarm`, `r_lowarm` | Joint origin only; quaternion is explicitly `null` and orientation validity is false |
| Chest pose | `l_uparm`, `r_uparm`, `root` | Shoulder midpoint; local Y points right-to-left, local Z is pelvis-to-midpoint orthogonalized against Y, local X is Y×Z; a geometric proxy, not measured sternum motion |
| Footprint pose | `root` pelvis and initial chest forward | Pelvis XY projected to source Z=0; yaw from one signed pelvis-local axis chosen once to best match initial chest forward, then projected horizontally each frame |

The chest-to-pelvis construction and the selected pelvis axis are recorded in metadata. Footprint does **not** measure feet, support contacts, balance, or a robot base. Source Z=0 is a coordinate-plane proxy: this export does **not** establish a calibrated physical floor. A rendering mesh that points from an elbow toward its wrist adds a display orientation; it does not create a recorded elbow orientation.

## Robot retargeting: additional changes

The standalone [Taku retargeter](../scripts/retarget-taku.py) uses separately obtained official Taku kinematics to optimize actual robot joint configurations. It selects an explicitly recorded initial arm posture from source wrist height, then maps per-site position displacement and orientation change relative to robot FK home. Absolute human height and initial inter-site geometry are not preserved. No limb-length scaling or time trimming is applied.

The solver is weighted damped **position IK**, with warm starts, experimental position bounds, soft temporal/posture regularization, per-iteration and per-frame numerical trust boxes, and FK merit backtracking. It is not the earlier velocity-level QP/feedforward experiment and not a learned Dyna controller. Manufacturer joint limits are absent from the public kinematics; no claim of hardware-safe bounds is made. A per-frame jump guard is an effective numerical displacement/speed cap at the sample rate, despite not being a manufacturer velocity or acceleration specification.

The browser recomputes FK from the saved solution; transparent Taku mesh copies display mapped targets, while the separate source skeleton view retains the original aligned human coordinates. Elbow mesh heading is only a display construction, not an additional recorded or optimized elbow orientation. See [exact mappings, solver configuration, safeguards, reproduction and measured residuals](methods.md).

The generated robot data do not copy the Taku kinematics document or mesh. Those assets remain external and separately licensed; the repo's MIT code license does not grant rights to them.

## Validity and motion summaries

The exporter marks both endpoints of a native position interval invalid if speed exceeds **4 m/s for wrists/elbows** or **2.5 m/s for chest/footprint**. Orientation intervals exceeding **20 rad/s** are marked invalid for orientation. Chest construction also checks shoulder separation and pelvis-to-shoulder distance; footprint heading requires a sufficiently nonvertical selected axis. These are explicit research heuristics, not sensor confidence or physical safety guarantees. Thresholds and flagged-frame counts are exported.

`motionStats` contains speed summaries from adjacent **native** samples with valid task endpoints, before display decimation. Invalid intervals are excluded and counts are provided. Consequently these summaries do not describe the unrestricted raw stream and are not robot tracking errors. The Taku companions' error statistics instead use valid targets at retained approximately 30 Hz sample times, comparing mapped targets with solved FK. They are not physical tracking measurements. The playback speed control affects presentation only.

## Reproduce or extend

Obtain the dataset through the [official getting-started workflow](https://github.com/facebookresearch/nymeria_dataset#getting-started) and accept its applicable terms. Keep download credentials and signed URL manifests outside this repository. The standalone exporter is tested with Python 3.14 and the exact NumPy/SciPy versions in [requirements-export.txt](../requirements-export.txt). These are optional export/test dependencies, not needed for browser playback. In an isolated Python environment, install them and run the synthetic tests (no dataset download):

```sh
python3 -m pip install -r requirements-export.txt
python3 -B tests/nymeria-export.py
python3 -B tests/taku-retarget.py
```

Then supply a locally obtained optimized MHR GLB:

```sh
python3 -B scripts/export-nymeria.py input/xdata_mhr.glb \
  --sequence-id 20231222_s1_kenneth_fischer_act6_kbpn0q \
  --start 30 --duration 120 --display-fps 30 \
  --output /tmp/nymeria-candidate.json
```

The exporter refuses to overwrite an existing output by default. Its explicit `--overwrite-derived` option only accepts an existing export with this exporter's schema, never the source GLB. Continue with the separately documented [IK reproduction commands](methods.md#reproduce-the-ik-artifacts) to create robot companions.

Review any new artifact and its license/privacy implications before publication. Generating a file does not add it to the public allowlist: the guard accepts only the four exact paths above with reviewed schema, attribution, byte counts and hashes. Arbitrary JSON, models and media remain blocked in both `public/` and the final `dist/` artifact.
