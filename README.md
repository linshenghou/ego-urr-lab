# Nymeria → URR → Taku

An independent research notebook for inspecting how estimated human motion becomes task-space targets and a genuinely solved robot trajectory.

**[Interactive research page](https://linshenghou.github.io/ego-urr-lab/)** · [Methods and measured errors](docs/methods.md) · [Data provenance](docs/nymeriaplus-provenance.md)

中文：只研究 NymeriaPlus → 人体骨架 → URR 关键部位 → Taku 逆运动学。页面同时展示原始人体骨架、求解后的实体机器人、半透明机器人目标 mesh 和动态误差。原始人体目标与映射后的机器人目标明确分开；这不是 Dyna 官网回放或其控制器的复现。

## What the page contains

Two excerpts from one licensed NymeriaPlus housework sequence: a continuous approximately 120-second clip and a 15-second hand-motion clip. The former Dyna demonstration episodes are not part of the public player.

| Layer | Meaning |
|---|---|
| Human skeleton and source URR | FK of the estimated MHR skeleton; derived wrist, elbow, chest and footprint quantities |
| Semi-transparent Taku meshes | Robot-space retarget objectives, not the original human coordinates or achieved poses |
| Solid Taku | Our offline 21-DOF IK joint solution, reconstructed by FK during playback |
| Error panel | Same-time mapped-target versus solved-FK residuals; not measured hardware error |

This is original research software, **not affiliated with or endorsed by Dyna Robotics or Meta**. It does not reproduce Dyna's learned policy, training pipeline, or hardware controller. No private robot geometry, internal robot recordings, or hardware connection is included.

## What has—and has not—been solved

The authored solver optimizes planar base motion, four folding/waist joints and fourteen arm joints. Head, wheels and grippers remain at their zero reference. It uses weighted damped position IK, warm starts, experimental joint-position bounds, soft temporal/posture regularization, bounded numerical steps, and FK merit backtracking. It is not a velocity-level QP and does not use velocity feedforward.

Manufacturer velocity/acceleration limits are **not** applied, but motion is **not unlimited**: a per-frame numerical continuity guard limits configuration changes. At approximately 30 Hz it therefore also limits apparent playback speed. Neither those bounds nor the position bounds are verified hardware specifications. Dynamics, collisions, contact, balance and wheel rolling constraints are not modeled.

Initial arm posture is selected explicitly from the initial human wrist height: the long clip starts with an authored arms-down pose, the short clip with bent elbows. Per-site displacement/orientation changes are then applied relative to that home. This changes absolute heights and initial inter-site geometry; it is not a calibrated world-to-robot rigid transform. Physical floor calibration is not established.

The final long clip's left/right hand position error means are **7.70 / 3.61 mm**, with P95 **24.99 / 9.72 mm**. However, maxima reach **143 / 178 mm**, and chest mean error is **68.6 mm**. These remaining failures are visible, not cropped out. See [full results and limitations](docs/methods.md).

## Run locally

Requires Node.js 22.12 or newer and internet access for the remote official Taku model and kinematics.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. No API key or backend is required.

```sh
npm test
npm run check:publication
npm run build
npm run preview
```

Renderer dependencies are pinned by `package-lock.json`. `prepare:vendor` prepares licensed rendering decoders and notices, not third-party robot assets.

## Reproduce the numerical pipeline

Browser playback uses reviewed numerical artifacts; it does not run IK in real time. The standalone Python scripts reproduce extraction and retargeting without any private workspace imports:

```sh
python3 -m pip install -r requirements-export.txt
python3 -B tests/nymeria-export.py
python3 -B tests/taku-retarget.py
```

Obtain the source GLB through the official NymeriaPlus download procedure and the kinematics separately from the official HTTPS endpoint. See [extraction instructions](docs/nymeriaplus-provenance.md#reproduce-or-extend) and [IK reproduction](docs/methods.md#reproduce-the-ik-artifacts). Never commit signed download URLs, credentials, raw body meshes or unreviewed new data.

## Data and licensing

Original code, tests and documentation are MIT licensed. The two human-motion excerpts **and their two generated Taku trajectory companions** are reviewed numerical NymeriaPlus adaptations under **CC BY-NC 4.0**, not MIT. They are included for noncommercial research with source attribution and change notices. See [data provenance](docs/nymeriaplus-provenance.md), [full dataset license](licenses/NYMERIAPLUS-DATA-LICENSE.txt), and [third-party notices](THIRD_PARTY_NOTICES.md).

The browser fetches Taku geometry and kinematics directly from Dyna's public HTTPS origin. These third-party assets are **not bundled or mirrored** and are not covered by this repository's MIT license. No Dyna videos, demonstration trajectories, website application code or logos are included. No NymeriaPlus raw GLB, model weights, images, video, audio or participant demographics are included.

Remote loading contacts Dyna's servers and may fail if availability or CORS policy changes. The kinematics hash is pinned to the version used for optimization, and decoded model geometry is separately hash-pinned; unreviewed changes must not silently produce a different robot. Missing data/assets are shown as unavailable, not replaced by synthetic recordings. No analytics, upload service or account is required.

## GitHub Pages and publication checks

The Actions workflow tests and builds the site, then deploys `dist/` from `main` through the `github-pages` environment. Select **Settings → Pages → Source → GitHub Actions** for a fork. Relative build URLs support a project path such as `/ego-urr-lab/`.

Update this README's project link and optional `VITE_REPOSITORY_URL` when forking. The publication guard restricts included numerical artifacts to reviewed paths, schemas, sizes and pinned hashes in both source and build output. Adding a new recording requires another license/privacy review; passing a guard is not a substitute for that review.

## References

- [Official Nymeria/NymeriaPlus project and download instructions](https://github.com/facebookresearch/nymeria_dataset)
- [Official NymeriaPlus sequence](https://explorer.projectaria.com/nymeria_plus/20231222_s1_kenneth_fischer_act6_kbpn0q)
- [Official NymeriaPlus split dataset license](https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE)
- [Dyna-2.1 research article](https://www.dyna.co/dyna-2.1) and [official Taku kinematics](https://www.dyna.co/assets/we/dvt1_kin.json)
- [Three.js documentation](https://threejs.org/docs/)

MIT for original code/documentation; CC BY-NC 4.0 for all bundled Nymeria-derived numeric data. See [LICENSE](LICENSE).
