/** Three.js display only. Every solid pose and target is supplied by data.js. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { jointMatrix, poseMatrix, validPose, validQuaternion, SITES } from './data.js';

const modelCache = new Map();
function setPose(group, pose) {
  group.visible = validPose(pose);
  if (!group.visible) return;
  group.position.fromArray(pose.p); group.quaternion.fromArray(pose.q ?? [0, 0, 0, 1]);
}
export function validateModelNodes(modelScene, expectedLinks) {
  const names = new Set(), expected = new Set(expectedLinks);
  modelScene.traverse((node) => {
    if (!node.isMesh) return;
    const name = node.name.split('__')[0]; names.add(name);
    if (!expected.has(name)) throw new Error(`Model/source incompatibility: unknown link ${name}`);
    // Older tracking GLBs add an identity `world` wrapper. No transformed
    // ancestors may be discarded when cloning link-local mesh TRS.
    for (let parent = node.parent; parent && parent !== modelScene; parent = parent.parent) {
      parent.updateMatrix();
      if (!parent.matrix.equals(new THREE.Matrix4())) throw new Error(`Unexpected transformed mesh ancestor: ${node.name}`);
    }
  });
  for (const name of ['agv_base', 'torso_body_link', 'left_wrist_roll_link', 'right_wrist_roll_link', 'left_elbow_link', 'right_elbow_link']) if (!names.has(name)) throw new Error(`Model missing essential link ${name}`);
  return names;
}
async function loadModel(spec) {
  if (!modelCache.has(spec.modelUrl)) {
    const promise = (async () => {
      const response = await fetch(spec.modelUrl); if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
      const text = (await response.text()).trim(), bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      const digest = globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('') : null;
      await MeshoptDecoder.ready;
      const draco = new DRACOLoader();
      draco.setDecoderPath(`${import.meta.env?.BASE_URL ?? './'}draco/`);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco);
      try { const gltf = await loader.parseAsync(bytes.buffer, new URL('.', spec.modelUrl).href); return { scene: gltf.scene, digest, bytes: bytes.length }; }
      finally { draco.dispose(); }
    })();
    modelCache.set(spec.modelUrl, promise);
    promise.catch(() => modelCache.delete(spec.modelUrl));
  }
  return modelCache.get(spec.modelUrl);
}

/** Exposed for synthetic tests: preserve mesh-local transforms under world-pose groups. */
export function buildModel(modelScene, kinematics, { opacity = .38 } = {}) {
  const byLink = new Map(), materials = new Map();
  modelScene.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.name.split('__')[0]; if (!byLink.has(name)) byLink.set(name, []); byLink.get(name).push(object);
  });
  // The ghost layer uses the real remote link geometry, not surrogate glyphs.
  const ghostMaterial = new THREE.MeshPhysicalMaterial({ color: 0x86aa9b, transparent: true, opacity, roughness: .26, metalness: 0,
    clearcoat: .45, clearcoatRoughness: .25, transmission: .06, thickness: .02, ior: 1.25, depthWrite: false, side: THREE.DoubleSide });
  function visual(name, ghost = false) {
    const group = new THREE.Group(); group.name = name;
    for (const source of byLink.get(name) ?? []) {
      const mesh = source.clone();
      if (!materials.has(source.material)) materials.set(source.material, new THREE.MeshStandardMaterial({ color: source.material?.color?.clone() ?? new THREE.Color(0xe8e8e2), roughness: .47, metalness: .06 }));
      mesh.material = ghost ? ghostMaterial : materials.get(source.material); mesh.castShadow = !ghost; mesh.receiveShadow = !ghost;
      if (ghost) mesh.renderOrder = 5;
      group.add(mesh);
    }
    return group;
  }
  const solid = new THREE.Group(), targets = new THREE.Group(), links = new Map(), groups = {};
  for (const name of byLink.keys()) { const group = visual(name); links.set(name, group); solid.add(group); }
  const joints = new Map(kinematics.joints.map((joint) => [joint.name, joint]));
  groups.chest = visual('torso_body_link', true); groups.footprint = visual('agv_base', true);
  for (const joint of kinematics.joints) {
    if (!joint.name.startsWith('agv_') || !joint.name.endsWith('steering_joint')) continue;
    const steering = new THREE.Group(); steering.matrixAutoUpdate = false; steering.matrix.copy(jointMatrix(joint)); steering.add(visual(joint.child, true));
    const wheel = kinematics.joints.find((item) => item.parent === joint.child);
    if (wheel) { const child = new THREE.Group(); child.matrixAutoUpdate = false; child.matrix.copy(jointMatrix(wheel)); child.add(visual(wheel.child, true)); steering.add(child); }
    groups.footprint.add(steering);
  }
  const hands = {};
  for (const side of ['left', 'right']) {
    const group = new THREE.Group(); group.matrixAutoUpdate = false; group.add(visual(`${side}_wrist_roll_link`, true));
    const frameJoint = joints.get(`${side}_gripper_joint_frame`); if (!frameJoint) throw new Error(`Missing ${side} EE frame transform`);
    const fingers = {};
    for (const end of ['front', 'rear']) {
      const joint = joints.get(`${side}_gripper_${end}_joint`); if (!joint) continue;
      const finger = new THREE.Group(); finger.matrixAutoUpdate = false; finger.add(visual(joint.child, true)); group.add(finger); fingers[end] = { group: finger, joint };
    }
    groups[side] = group; groups[`elbow_${side}`] = visual(`${side}_elbow_link`, true); hands[side] = { group, inverse: jointMatrix(frameJoint).invert(), fingers };
  }
  targets.add(...Object.values(groups));
  function update(frame) {
    for (const [name, group] of links) setPose(group, frame.taku_links?.[name]);
    for (const site of ['chest', 'footprint']) {
      const target = frame.targets?.[site]; setPose(groups[site], target);
      groups[site].visible &&= validQuaternion(target?.q) && target?.valid_orientation !== false;
    }
    for (const side of ['left', 'right']) {
      const hand = hands[side], target = frame.targets?.[side];
      hand.group.visible = validPose(target) && validQuaternion(target.q) && target.valid_orientation !== false;
      if (hand.group.visible) { hand.group.matrix.copy(poseMatrix(target)).multiply(hand.inverse); hand.group.matrixWorldNeedsUpdate = true; }
      for (const [end, finger] of Object.entries(hand.fingers)) {
        const opening = frame.grip?.[side] ?? 0;
        finger.group.matrix.copy(jointMatrix(finger.joint, (end === 'front' ? -.0345 : .0345) * opening)); finger.group.matrixWorldNeedsUpdate = true;
      }
      const elbow = groups[`elbow_${side}`]; setPose(elbow, frame.targets?.[`elbow_${side}`]);
      // Elbow URR has position only. This mesh direction is purely a display
      // convention and never feeds the actual FK or error measurements.
      if (elbow.visible && validPose(target)) {
        const direction = (hand.group.visible ? new THREE.Vector3().setFromMatrixPosition(hand.group.matrix) : new THREE.Vector3(...target.p)).sub(elbow.position);
        if (direction.lengthSq() > 1e-12) elbow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.normalize());
        else elbow.quaternion.identity();
      } else if (elbow.visible) {
        elbow.quaternion.identity();
      }
    }
    solid.updateMatrixWorld(true); targets.updateMatrixWorld(true);
  }
  return { solid, targets, links, groups, hands, ghostMaterial, update, dispose() { ghostMaterial.dispose(); materials.forEach((material) => material.dispose()); } };
}

function lineSegments(color, dashed = false) {
  const material = dashed ? new THREE.LineDashedMaterial({ color, dashSize: .035, gapSize: .025, transparent: true, opacity: .7 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity: .9 });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material); lines.frustumCulled = false; return lines;
}
/** Source-only inset: never consumes robot-space `targets` or solved link poses. */
export function buildHumanSkeleton() {
  const root = new THREE.Group(), references = new THREE.Group(), groups = {}, axes = {};
  root.name = 'source-human-skeleton'; references.name = 'source-task-references'; root.add(references);
  const material = new THREE.MeshStandardMaterial({ color: 0x728a7c, roughness: .72 });
  const bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(.008, .008, 1, 8), material, 100);
  const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(.018, 12, 8), material, 100);
  for (const mesh of [bones, joints]) { mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(mesh); }
  const marker = new THREE.Object3D(), vertical = new THREE.Vector3(0, 1, 0);
  const referenceMaterial = new THREE.MeshStandardMaterial({ color: 0x279c80, roughness: .4 }), markerGeometry = new THREE.SphereGeometry(.028, 12, 8);
  const stance = lineSegments(0x93a29a, true); root.add(stance);
  for (const site of SITES) {
    const group = new THREE.Group(); group.name = `source-${site}`; group.add(new THREE.Mesh(markerGeometry, referenceMaterial));
    if (!site.startsWith('elbow')) { axes[site] = new THREE.AxesHelper(.14); group.add(axes[site]); }
    groups[site] = group; references.add(group);
  }
  function update(frame, skeleton = {}, extraction = {}) {
    bones.count = 0; joints.count = 0;
    for (const [a, b] of skeleton.bones ?? []) {
      const first = frame.raw?.[a], second = frame.raw?.[b]; if (!validPose(first) || !validPose(second) || bones.count >= 100) continue;
      const start = new THREE.Vector3(...first.p), end = new THREE.Vector3(...second.p), direction = end.clone().sub(start), length = direction.length();
      if (length <= 1e-9) continue;
      marker.position.copy(start).add(end).multiplyScalar(.5); marker.quaternion.setFromUnitVectors(vertical, direction.divideScalar(length)); marker.scale.set(1, length, 1); marker.updateMatrix(); bones.setMatrixAt(bones.count++, marker.matrix);
    }
    for (const value of Object.values(frame.raw ?? {})) {
      if (!validPose(value) || joints.count >= 100) continue;
      marker.position.fromArray(value.p); marker.quaternion.identity(); marker.scale.setScalar(1); marker.updateMatrix(); joints.setMatrixAt(joints.count++, marker.matrix);
    }
    for (const site of SITES) {
      const source = frame.source_targets?.[site]; setPose(groups[site], source);
      const oriented = !site.startsWith('elbow') && validQuaternion(source?.q) && source?.valid_orientation !== false;
      if (!oriented) groups[site].quaternion.identity();
      if (axes[site]) axes[site].visible = oriented;
    }
    const hip = frame.raw?.[extraction.anatomy?.hip], footprint = frame.source_targets?.footprint;
    setLinePoints(stance, validPose(hip) && validPose(footprint) ? [...hip.p, ...footprint.p] : []);
    bones.instanceMatrix.needsUpdate = true; joints.instanceMatrix.needsUpdate = true; root.updateMatrixWorld(true);
  }
  return { root, bones, joints, groups, axes, stance, update, dispose() {
    const geometries = new Set(), materials = new Set();
    root.traverse((object) => { if (object.geometry) geometries.add(object.geometry); if (object.material) for (const item of [object.material].flat()) materials.add(item); });
    geometries.forEach((geometry) => geometry.dispose()); materials.forEach((item) => item.dispose()); bones.dispose(); joints.dispose();
  } };
}

function createHumanInset(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute('aria-label', 'Original human skeleton and source URR references in a separate coordinate view. Drag to orbit; grid is source z=0, not calibrated floor.'); container.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(36, 1, .01, 200); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minDistance = .4; controls.maxDistance = 30;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c9d91, 3)); const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(2, -3, 6); scene.add(light);
  const grid = new THREE.GridHelper(30, 120, 0xd0d8ce, 0xe7ece3); grid.rotation.x = Math.PI / 2; grid.material.transparent = true; grid.material.opacity = .38; scene.add(grid);
  const human = buildHumanSkeleton(); scene.add(human.root);
  let currentFrame = null, currentEpisode = null, currentHip = null;
  const resize = () => { const width = container.clientWidth, height = container.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const hipFor = (frame) => frame?.raw?.[currentEpisode?.extraction?.anatomy?.hip];
  function reset() {
    const values = Object.values(currentFrame?.raw ?? {}).filter(validPose), box = new THREE.Box3();
    for (const value of values) box.expandByPoint(new THREE.Vector3(...value.p));
    const center = values.length ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, .85);
    const height = values.length ? box.getSize(new THREE.Vector3()).z : 1.7;
    controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(1.7, -2.7, 1.2).multiplyScalar(Math.max(.65, height / 1.65))); controls.update();
    const hip = hipFor(currentFrame); currentHip = validPose(hip) ? [...hip.p] : null;
  }
  reset();
  function update(frame) {
    currentFrame = frame; if (!currentEpisode) return;
    human.update(frame, currentEpisode.skeleton, currentEpisode.extraction);
    const hip = hipFor(frame);
    if (validPose(hip)) {
      if (currentHip) { const delta = new THREE.Vector3(hip.p[0] - currentHip[0], hip.p[1] - currentHip[1], 0); camera.position.add(delta); controls.target.add(delta); }
      currentHip = [...hip.p];
    }
  }
  return { setEpisode(episode) { currentEpisode = episode; currentHip = null; update(episode.sample(0)); reset(); resize(); }, update, reset,
    render() { controls.update(); renderer.render(scene, camera); },
    dispose() { observer.disconnect(); controls.dispose(); human.dispose(); grid.geometry.dispose(); grid.material.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
function setLinePoints(object, coordinates) {
  object.geometry.dispose(); object.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
  if (object.material.isLineDashedMaterial) object.computeLineDistances();
}
export function createScene(container, { rawContainer = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.18;
  renderer.domElement.setAttribute('aria-label', 'Interactive Taku replay: drag to orbit, scroll to zoom'); container.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, .01, 300); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .1; controls.minDistance = .45; controls.maxDistance = 20;
  const rawView = rawContainer ? createHumanInset(rawContainer) : null;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x899383, 2.7));
  for (const [color, power, position] of [[0xfff9ed, 3.1, [3, -4, 7]], [0xe3efff, 1.8, [-3, 3, 5]]]) { const light = new THREE.DirectionalLight(color, power); light.position.set(...position); scene.add(light); }
  const grid = new THREE.GridHelper(40, 160, 0xc3cdc0, 0xe0e6db); grid.rotation.x = Math.PI / 2; grid.position.z = -.007; grid.material.transparent = true; grid.material.opacity = .58; scene.add(grid);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: 0xf4f6ef, transparent: true, opacity: .5, depthWrite: false })); floor.position.z = -.009; scene.add(floor);
  const skeletonRoot = new THREE.Group(), boneLines = lineSegments(0xc17b38), inferredLines = lineSegments(0xbba58b, true), stanceLines = lineSegments(0x9a998d, true), errorLines = lineSegments(0xb56d4c);
  skeletonRoot.add(boneLines, inferredLines, stanceLines); scene.add(skeletonRoot, errorLines);
  let model = null, episode = null, currentFrame = null, currentBase = null, stopped = false, revision = 0, opacity = .38;
  const layers = { solid: true, targets: true, skeleton: false, errors: false };
  const applyLayers = () => { if (model) { model.solid.visible = layers.solid; model.targets.visible = layers.targets; } skeletonRoot.visible = layers.skeleton && episode?.kind !== 'nymeria'; errorLines.visible = layers.errors; };
  const basePosition = (frame) => validPose(frame?.actual?.footprint) ? frame.actual.footprint.p : validPose(frame?.targets?.footprint) ? frame.targets.footprint.p : null;
  function reset() {
    const base = basePosition(currentFrame) ?? [0, 0, 0]; let height = .85;
    if (episode?.kind === 'nymeria') {
      const points = Object.values(currentFrame?.taku_links ?? {}).filter(validPose);
      if (points.length) height = (Math.min(...points.map((p) => p.p[2])) + Math.max(...points.map((p) => p.p[2]))) / 2;
    }
    controls.target.set(base[0], base[1], height); camera.position.copy(controls.target).add(episode?.kind === 'nymeria' ? new THREE.Vector3(1.8, -2.3, 1.25) : new THREE.Vector3(2.7, -3.2, 1.7)); controls.update(); currentBase = [...base];
  }
  reset();
  const resize = () => { const width = container.clientWidth, height = container.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  function update(frame) {
    currentFrame = frame; if (!model || !episode) return; model.update(frame);
    if (episode.kind === 'nymeria') rawView?.update(frame);
    const base = basePosition(frame);
    if (base && currentBase) { const delta = new THREE.Vector3(base[0] - currentBase[0], base[1] - currentBase[1], 0); camera.position.add(delta); controls.target.add(delta); }
    if (base) currentBase = [...base];
    const bones = [], inferred = [], stance = [], errors = [], inferredNames = new Set(episode.skeleton?.inferred ?? []);
    for (const [a, b] of episode.kind === 'nymeria' ? [] : episode.skeleton?.bones ?? []) {
      const first = frame.raw?.[a], second = frame.raw?.[b]; if (!validPose(first) || !validPose(second)) continue;
      (inferredNames.has(a) || inferredNames.has(b) ? inferred : bones).push(...first.p, ...second.p);
    }
    if (validPose(frame.raw?.pelvis) && validPose(frame.raw?.footprint)) stance.push(...frame.raw.pelvis.p, ...frame.raw.footprint.p);
    for (const site of SITES) if (validPose(frame.targets?.[site]) && validPose(frame.actual?.[site])) errors.push(...frame.targets[site].p, ...frame.actual[site].p);
    setLinePoints(boneLines, bones); setLinePoints(inferredLines, inferred); setLinePoints(stanceLines, stance); setLinePoints(errorLines, errors); applyLayers();
  }
  function tick() { if (stopped) return; controls.update(); renderer.render(scene, camera); if (episode?.kind === 'nymeria') rawView?.render(); requestAnimationFrame(tick); } tick();
  return {
    async setEpisode(next) {
      if (!next.model?.modelUrl || !next.model?.kinematics) throw new Error('Taku model/kinematics are required; a generic glyph is not a robot replay.');
      const token = ++revision; const loaded = await loadModel(next.model); if (stopped || token !== revision) return [];
      const warnings = [];
      if (loaded) {
        if (next.model.strictIntegrity && loaded.digest !== next.model.expectedSha256) throw new Error('Official Taku geometry integrity mismatch; refusing to bind unreviewed mesh transforms.');
        validateModelNodes(loaded.scene, next.model.expectedLinks);
        if (!loaded.digest) warnings.push('Model integrity hash is unavailable in this browser context.');
        else if (next.model.expectedSha256 && next.model.expectedSha256 !== loaded.digest) warnings.push(`Upstream model changed: manifest SHA-256 ${next.model.expectedSha256} differs from downloaded ${loaded.digest}. Link names and flat mesh binding were validated; model version parity is not established.`);
      }
      if (model) { scene.remove(model.solid, model.targets); model.dispose(); }
      model = buildModel(loaded.scene, next.model.kinematics, { opacity }); scene.add(model.solid, model.targets); episode = next; currentBase = null;
      floor.visible = true; grid.position.z = -.007; grid.material.opacity = .48;
      renderer.domElement.setAttribute('aria-label', next.kind === 'nymeria' ? 'Solved Taku robot and semi-transparent Taku mesh targets, independent layers. Original human skeleton is in the separate source view.' : 'Interactive Taku replay: drag to orbit, scroll to zoom');
      if (next.kind === 'nymeria') rawView?.setEpisode(next);
      update(next.sample(0)); reset(); applyLayers(); return warnings;
    },
    update, setLayers(next) { Object.assign(layers, next); applyLayers(); }, setOpacity(value) { opacity = Math.max(0, Math.min(1, value)); if (model) model.ghostMaterial.opacity = opacity; }, reset, resetRaw() { rawView?.reset(); },
    dispose() { stopped = true; revision++; observer.disconnect(); controls.dispose(); model?.dispose(); rawView?.dispose(); renderer.dispose(); renderer.domElement.remove(); for (const object of [boneLines, inferredLines, stanceLines, errorLines, floor, grid]) { object.geometry.dispose(); object.material.dispose(); } },
  };
}
