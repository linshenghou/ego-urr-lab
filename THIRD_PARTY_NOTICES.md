# Third-party notices

## NymeriaPlus numeric excerpts (redistributed; non-audio)

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

The source files `public/data/nymeria/housework-long.json` and `public/data/nymeria/housework-hands.json`, together with their `housework-long-taku.json` and `housework-hands-taku.json` companions in the same directory, contain adapted non-audio motion data from NymeriaPlus v1.0. **All four** are provided under [Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/), **not MIT**. Retain this attribution, the license and disclaimer, source links, and indications of changes when sharing permitted copies or adaptations. This independent research demonstration does not imply Meta's endorsement.

The [complete original split license](licenses/NYMERIAPLUS-DATA-LICENSE.txt) is preserved verbatim. Section B applies to these non-audio excerpts; the separate Section A audio license does not authorize a public audio mirror, and no audio is included. The data are supplied as-is without warranties, subject to the full license's disclaimer and limitation of liability.

Source: [official NymeriaPlus project](https://github.com/facebookresearch/nymeria_dataset), [official dataset license](https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE), and [official source sequence](https://explorer.projectaria.com/nymeria_plus/20231222_s1_kenneth_fischer_act6_kbpn0q). Changes made here: cropped and display-decimated optimized MHR motion; skeleton forward kinematics; selected joint positions and wrist poses; fixed Y-up to Z-up conversion and first-frame planar alignment; derived chest and footprint proxies; validity metadata; compact numeric JSON export. Additional changes in the Taku companions: explicitly selected authored home poses, relative task-space mapping, numerical 21-DOF robot IK, FK and residual summaries. These are our generated research outputs, not official URR annotations, recorded Taku demonstrations or Dyna controller outputs. See [provenance and limitations](docs/nymeriaplus-provenance.md) and [solver methods](docs/methods.md).

No source GLB, body mesh, model weights, images, video, audio, demographic records, private robot data, or signed download links are redistributed. Open availability of the code does not remove the data's noncommercial restriction.

## Taku model and kinematics (remote; not redistributed)

Dyna Robotics owns its branding and publishes the Taku geometry and kinematics linked by this viewer. No model/kinematics redistribution license was found in the inspected materials. The repository does not copy those assets or the official website's application JavaScript. Its MIT license does not grant rights to those resources. The former Dyna demonstration episodes, videos and recorded trajectories are not part of the public player.

Runtime origin and roots:

- `https://www.dyna.co/assets/we/dvt1_kin.json`
- `https://www.dyna.co/assets/we/damping/dvt1_body.glb.txt`

Source article: <https://www.dyna.co/dyna-2.1>. This independent research viewer is not affiliated with, endorsed by, or an official product of Dyna Robotics. The white/green editorial interface is an original implementation; Dyna logos and website copy are not included.

## Three.js

Three.js, pinned to `0.180.0`, is distributed under the MIT license. The build preserves its notice and copies `node_modules/three/LICENSE` to the published `licenses/THREE-LICENSE.txt`.

Source: <https://github.com/mrdoob/three.js>.

## meshoptimizer

Three.js's meshopt decoder comes from meshoptimizer, Copyright (c) Arseny Kapoulkine, MIT licensed. The decoder's distributed notice is preserved in the bundle and published as `licenses/MESHOPT-NOTICE.txt`.

Source and full license: <https://github.com/zeux/meshoptimizer/blob/master/LICENSE.md>.

## Draco

The Draco decoder distributed with Three.js is used for the compressed remote Taku model. Draco is Copyright the Draco authors and licensed under Apache License 2.0. Generated decoder files are prepared locally from the pinned renderer package and deployed, not downloaded from Dyna.

Source and license: <https://github.com/google/draco/blob/main/LICENSE>.

The full Draco license and applicable notices accompany the deployed decoder; dependency licensing is separate from the project's original-code license.
