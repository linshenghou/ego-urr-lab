# EGO / URR Lab

An independent, interactive research notebook for understanding egocentric motion, task-space representations, and recorded Taku playback.

**[Interactive research page](https://linshenghou.github.io/ego-urr-lab/)** · [Dyna's original research](https://www.dyna.co/dyna-2.1)

中文：把 EGO 画面、公开 URR 指令、Taku 回放和逐帧误差放在同一时间轴上，区分哪些量是公开记录、哪些是推导、哪些并未提供。白色研究页面是独立设计，不是 Dyna 官网的镜像。

## What is reproduced—and what is not

Three different source families are deliberately kept separate:

| Source | Available signals | What this page does |
|---|---|---|
| Human demonstrations: Box Kitting, Wipe Metal Shelves, Restock Shelves | EGO video, hand/footprint commands, source skeleton guides, exported Taku link poses | Decode and replay the published **RL simulation** states; no new IK or RL controller runs |
| URR Tracking | Six task targets and recorded Taku joint/base states | Reconstruct robot geometry through FK and overlay the published task-space targets |
| NymeriaPlus housework excerpts | Optimized MHR skeleton motion; wrist, elbow, chest and footprint quantities derived here | Replay the human skeleton and our URR-like extraction; **no Taku solution or tracking error** is claimed |

This is **not affiliated with or endorsed by Dyna Robotics**. It does not reproduce their training pipeline or controller. It contains no private robot geometry, internal robot recordings, or hardware control connection.

The human-replay package does **not** publish the complete chest/elbow RL command stream. Its shoulder guides assume a 0.30 m upper arm; this viewer does not fabricate an EGO chest target. A shoulder-midpoint chest could be a separately labelled research proxy, not a measured sternum. In the separate Tracking source, chest pose and elbow position are official targets. An elbow mesh can rotate toward the wrist even when its recorded position stays fixed; that display rotation is not a measured elbow orientation. No measured leg skeleton is inferred from a footprint.

## Run locally

Requires Node.js 22.12 or newer and an internet connection for the official demonstration assets.

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

Renderer dependencies are pinned by `package-lock.json`. `prepare:vendor` prepares only licensed rendering decoders and license notices, not robot/motion assets.

## Data and licensing

Our original code, tests and documentation are MIT licensed. Two reviewed, non-audio **NymeriaPlus numeric excerpts** are included separately under **CC BY-NC 4.0**, for this independent noncommercial research demonstration. This does not grant commercial-use rights to the data. See the [NymeriaPlus provenance and changes](docs/nymeriaplus-provenance.md), [full dataset license](licenses/NYMERIAPLUS-DATA-LICENSE.txt), and [third-party notices](THIRD_PARTY_NOTICES.md).

The browser fetches Dyna model, trajectory and video resources directly from Dyna's public HTTPS origin when a Dyna source is loaded. Those resources are **not** bundled, mirrored or covered by this repository's MIT license. Public availability and CORS support do not establish permission to redistribute a dataset. NymeriaPlus raw GLB, model weights, imagery, video, audio and participant demographics are not included.

External loading contacts Dyna's servers; availability and source contents can change. Resource failures are shown explicitly—missing measurements are not replaced with synthetic recordings. No analytics, cookies, upload service or account is required. Locally running a viewer does not make upstream resources immutable.

Provenance includes source URLs and observed integrity information. An upstream model may change before its manifest is updated; a stale expected hash is a warning, not a claim that a different binary has been verified against that hash.

## Analysis conventions

- Units: metres and radians internally; centimetres/degrees where indicated in the UI. Dyna coordinates use Z-up source `robot_world`. NymeriaPlus is transformed from glTF Y-up to Z-up, then aligned by initial pelvis XY/yaw; this is not an independently calibrated floor estimate.
- Position error: Euclidean distance between a target and the corresponding achieved position **at the same source time**. There is no lag fitting or best-time alignment.
- Dyna episode statistics use valid native source samples (15 Hz for EGO, 12 Hz for the inspected Tracking source), not display frame rate. No transient trimming, smoothing or hand-selected error exclusion.
- Dyna's exact source crop is retained. Restock Shelves begins at 1.3 s, a half sample at 15 Hz; interpolation is for display, not an extra native measurement.
- In EGO commands, the direct achieved hand quaternion is not published. Direct orientation error remains unavailable, not zero. An optional **FK-derived** orientation overlay composes the exported `wrist_roll` world pose with the fixed `gripper_joint_frame`. Its derived orientation errors are kept separate from direct measurements. The mean/max positional agreement with published `ach.ee` is a source-consistency check, not independent validation of orientation accuracy.
- NymeriaPlus targets are our extraction from human motion, not official URR labels: wrists carry poses, elbows carry positions only, chest uses shoulder/hip geometry, and footprint is a pelvis projection/yaw proxy. There is no robot achieved stream to compare against these targets.
- Player speed changes presentation speed only, not the measurements or statistics.
- A low tracking error does not establish physical safety, collision freedom, contact consistency or deployability.

## GitHub Pages

The Actions workflow runs browser-data/publication tests and standalone synthetic exporter tests (Python 3.14 with pinned NumPy/SciPy), then builds on pull requests and deploys `dist/` from `main` through the `github-pages` environment. The exporter tests do not download any dataset. Select **Settings → Pages → Source → GitHub Actions** once for a new repository. Relative build URLs support a project-page path such as `/ego-urr-lab/`.

To fork, update the README project link and optional `VITE_REPOSITORY_URL`. Do not add raw downloaded datasets or private workspace exports. Only the two explicitly reviewed NymeriaPlus numeric excerpts are permitted; the publication guard checks exact paths, sizes, structure and pinned hashes in source and build output. Additional data require a new license/privacy review. `check:publication` is an additional guard, not a substitute for review.

## Research references

- [Dyna-2.1: source article and interactive demonstrations](https://www.dyna.co/dyna-2.1)
- [Official human-replay episode index](https://www.dyna.co/assets/we/ego-replay/data/episodes.json)
- [Official URR Tracking data](https://www.dyna.co/assets/we/tracking_data.json)
- [Official Nymeria/NymeriaPlus project and download instructions](https://github.com/facebookresearch/nymeria_dataset)
- [Official NymeriaPlus split dataset license](https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE)
- [Three.js documentation](https://threejs.org/docs/)

MIT for original repository code and documentation; CC BY-NC 4.0 for the bundled NymeriaPlus numeric excerpts. See [LICENSE](LICENSE).
