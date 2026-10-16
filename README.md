# EGO / URR Lab

An independent, interactive research notebook for understanding egocentric motion, task-space representations, and recorded Taku playback.

**[Interactive research page](https://linshenghou.github.io/ego-urr-lab/)** · [Dyna's original research](https://www.dyna.co/dyna-2.1)

中文：把 EGO 画面、公开 URR 指令、Taku 回放和逐帧误差放在同一时间轴上，区分哪些量是公开记录、哪些是推导、哪些并未提供。白色研究页面是独立设计，不是 Dyna 官网的镜像。

## What is reproduced—and what is not

Two different source families are deliberately kept separate:

| Source | Available signals | What this page does |
|---|---|---|
| Human demonstrations: Box Kitting, Wipe Metal Shelves, Restock Shelves | EGO video, hand/footprint commands, source skeleton guides, exported Taku link poses | Decode and replay the published **RL simulation** states; no new IK or RL controller runs |
| URR Tracking | Six task targets and recorded Taku joint/base states | Reconstruct robot geometry through FK and overlay the published task-space targets |

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

Renderer dependencies are pinned by `package-lock.json`. `prepare:vendor` prepares only licensed rendering decoders, not robot/data assets.

## Data and licensing

Only our source code, tests and documentation are published here. The browser fetches model, trajectory and video resources directly from Dyna's public HTTPS origin when a source is loaded. Third-party media are **not** bundled, mirrored or covered by this repository's MIT license. Public availability and CORS support do not establish permission to redistribute a dataset. See [third-party notices](THIRD_PARTY_NOTICES.md).

External loading contacts Dyna's servers; availability and source contents can change. Resource failures are shown explicitly—missing measurements are not replaced with synthetic recordings. No analytics, cookies, upload service or account is required. Locally running a viewer does not make upstream resources immutable.

Provenance includes source URLs and observed integrity information. An upstream model may change before its manifest is updated; a stale expected hash is a warning, not a claim that a different binary has been verified against that hash.

## Analysis conventions

- Units: metres and radians internally; centimetres/degrees where indicated in the UI. Coordinates: Z-up, source `robot_world`.
- Position error: Euclidean distance between a target and the corresponding achieved position **at the same source time**. There is no lag fitting or best-time alignment.
- Episode statistics use valid native source samples (15 Hz for EGO, 12 Hz for the inspected Tracking source), not display frame rate. No transient trimming, smoothing or hand-selected error exclusion.
- The source's exact crop is retained. Restock Shelves begins at 1.3 s, a half sample at 15 Hz; interpolation is for display, not an extra native measurement.
- In EGO commands, achieved hand quaternion is not published. Orientation error is therefore unavailable under that measurement definition; it is not reported as zero.
- Player speed changes presentation speed only, not the measurements or statistics.
- A low tracking error does not establish physical safety, collision freedom, contact consistency or deployability.

## GitHub Pages

The Actions workflow validates and builds on pull requests, then deploys `dist/` from `main` through the `github-pages` environment. Select **Settings → Pages → Source → GitHub Actions** once for a new repository. Relative build URLs support a project-page path such as `/ego-urr-lab/`.

To fork, update the README project link and optional `VITE_REPOSITORY_URL`. Never add downloaded source datasets or private workspace exports to a commit. `check:publication` is an additional guard, not a substitute for review.

## Research references

- [Dyna-2.1: source article and interactive demonstrations](https://www.dyna.co/dyna-2.1)
- [Official human-replay episode index](https://www.dyna.co/assets/we/ego-replay/data/episodes.json)
- [Official URR Tracking data](https://www.dyna.co/assets/we/tracking_data.json)
- [Three.js documentation](https://threejs.org/docs/)

MIT for original repository code and documentation only; see [LICENSE](LICENSE).
