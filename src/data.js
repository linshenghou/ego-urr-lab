/** Source decoders and audit-friendly replay sampling; licensed Nymeria excerpts are local. */
import { Matrix4, Quaternion, Vector3, Euler } from 'three';
import { NYMERIA_CATALOG, loadNymeriaEpisode } from './nymeria.js';

export const EGO_BASE = 'https://www.dyna.co/assets/we/ego-replay/data/';
export const TRACKING_BASE = 'https://www.dyna.co/assets/we/';
export const CATALOG = Object.freeze([
  { id: 'box-kitting', label: 'Box Kitting', kind: 'ego', sourceId: '12545090', start: 0, end: 73.2, description: '73.2 s · original 1× RL simulation replay' },
  { id: 'wipe-shelves', label: 'Wipe Metal Shelves', kind: 'ego', sourceId: '68c67b6dec331250d5e7485d', start: 13, end: 23, description: '10 s · source window 13–23 s' },
  { id: 'restock-shelves', label: 'Restock Shelves', kind: 'ego', sourceId: '68ed3b821d840fbdae1cb24a', start: 1.3, end: 15.5, description: '14.2 s · source window 1.3–15.5 s' },
  { id: 'urr-tracking', label: 'URR Tracking', kind: 'tracking', description: 'Six-site targets and recorded Taku joint states · separate source' },
  ...NYMERIA_CATALOG,
]);
export const SITES = ['left', 'right', 'chest', 'elbow_left', 'elbow_right', 'footprint'];
export const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const validPose = (pose) => Boolean(pose?.valid_position !== false && pose?.p?.length === 3 && pose.p.every(finite));
export const validQuaternion = (q) => q?.length === 4 && q.every(finite) && Math.hypot(...q) > 1e-9;
const normalize = (q) => validQuaternion(q) ? new Quaternion(...q).normalize().toArray() : null;
export function pose(p, q = null) {
  const quaternion = normalize(q);
  return { p, q: quaternion, valid_position: p.length === 3 && p.every(finite), valid_orientation: Boolean(quaternion) };
}
export function poseMatrix(value) {
  return new Matrix4().compose(new Vector3(...value.p), new Quaternion(...(value.q ?? [0, 0, 0, 1])), new Vector3(1, 1, 1));
}
export function matrixPose(matrix, orientation = true) {
  const p = new Vector3(), q = new Quaternion(), scale = new Vector3(); matrix.decompose(p, q, scale);
  return pose(p.toArray(), orientation ? q.toArray() : null);
}
function aligned(value, alignment) {
  if (!validPose(value)) return value;
  return matrixPose(alignment.clone().multiply(poseMatrix(value)), value.valid_orientation);
}
function unwrapDelta(a, b) { const delta = b - a; return delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI)); }
function base64Bytes(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.trim())) throw new Error('Invalid base64 channel');
  return Uint8Array.from(atob(encoded.trim()), (char) => char.charCodeAt(0));
}

/** Both published encodings store signed Int16 little-endian, NOT deltas. */
export function decodeColumns(document, kind = 'ego') {
  if (!Number.isInteger(document.n) || document.n < 2 || !finite(document.fps) || document.fps <= 0) throw new Error('Invalid source clock');
  if (kind === 'ego' && document.schema !== 'dyna.web.columnar-int16.v1') throw new Error('Unsupported ego column schema');
  const channels = new Map(), kinds = new Map();
  for (const [name, payload] of Object.entries(document.channels ?? {})) {
    const channelKind = kind === 'ego' ? document.channel_kinds?.[name] : payload[0];
    const scale = (kind === 'ego' ? document.scales : document.scale)?.[channelKind];
    if (!finite(scale) || scale <= 0) throw new Error(`Invalid channel scale: ${name}`);
    const bytes = base64Bytes(kind === 'ego' ? payload : payload[1]);
    if (bytes.length !== document.n * 2) throw new Error(`Channel length mismatch: ${name}`);
    const view = new DataView(bytes.buffer), values = new Float64Array(document.n);
    for (let i = 0; i < values.length; i++) { const raw = view.getInt16(i * 2, true); values[i] = kind === 'ego' && raw === (document.null_value ?? -32768) ? NaN : kind === 'tracking' ? Math.fround(raw / scale) : raw / scale; }
    channels.set(name, values); kinds.set(name, channelKind);
  }
  for (const [name, raw] of Object.entries(document.constants ?? {})) {
    if (channels.has(name)) throw new Error(`Duplicate constant/channel: ${name}`);
    const channelKind = document.channel_kinds?.[name], scale = document.scales?.[channelKind];
    if (!finite(scale) || scale <= 0) throw new Error(`Invalid constant scale: ${name}`);
    channels.set(name, new Float64Array(document.n).fill(raw === (document.null_value ?? -32768) ? NaN : raw / scale)); kinds.set(name, channelKind);
  }
  return { channels, kinds, n: document.n, fps: document.fps };
}

function sampleColumns(decoded, index, tracking = false) {
  const f = Math.max(0, Math.min(decoded.n - 1, index)), i = Math.floor(f + 1e-9), j = Math.min(i + 1, decoded.n - 1), a = Math.max(0, f - i);
  const value = (name) => {
    const values = decoded.channels.get(name); if (!values) return NaN;
    if (a < 1e-8) return values[i];
    if (!finite(values[i]) || !finite(values[j])) return NaN;
    return values[i] + (tracking && decoded.kinds.get(name) === 'ang' ? unwrapDelta(values[i], values[j]) : values[j] - values[i]) * a;
  };
  const getPose = (prefix, orientation = 'quaternion') => {
    const p = [...'xyz'].map((axis) => value(`${prefix}.${axis}`)); let q = null;
    if (orientation === 'yaw') {
      const values = decoded.channels.get(`${prefix}.yaw`);
      const yaw = values ? values[i] + (a < 1e-8 ? 0 : unwrapDelta(values[i], values[j]) * a) : NaN;
      q = finite(yaw) ? new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), yaw).toArray() : null;
    } else if (orientation === 'quaternion') {
      const qa = [...'xyzw'].map((axis) => decoded.channels.get(`${prefix}.q${axis}`)?.[i] ?? NaN);
      const qb = [...'xyzw'].map((axis) => decoded.channels.get(`${prefix}.q${axis}`)?.[j] ?? NaN);
      if (validQuaternion(qa) && (a < 1e-8 || validQuaternion(qb))) {
        q = tracking ? normalize([... 'xyzw'].map((axis) => value(`${prefix}.q${axis}`))) : new Quaternion(...qa).normalize().slerp(new Quaternion(...(a < 1e-8 ? qa : qb)).normalize(), a).toArray();
      }
    }
    return pose(p, q);
  };
  return { value, pose: getPose };
}
export function errorsFor(targets, actual) {
  return Object.fromEntries(SITES.map((site) => {
    const target = targets[site], achieved = actual[site]; let position_m = null, orientation_rad = null;
    if (validPose(target) && validPose(achieved)) position_m = new Vector3(...target.p).distanceTo(new Vector3(...achieved.p));
    if (target?.valid_orientation && achieved?.valid_orientation && validQuaternion(target.q) && validQuaternion(achieved.q)) orientation_rad = new Quaternion(...target.q).angleTo(new Quaternion(...achieved.q));
    return [site, { position_m, orientation_rad }];
  }));
}
export function summary(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b); if (!sorted.length) return null;
  const p = (sorted.length - 1) * .95, lo = Math.floor(p), hi = Math.ceil(p);
  return { n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95: sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo), max: sorted.at(-1) };
}
function statistics(frames) { return Object.fromEntries(SITES.map((site) => [site, { position: summary(frames.map((frame) => frame.errors[site].position_m)), orientation: summary(frames.map((frame) => frame.errors[site].orientation_rad)) }])); }
function initialAlignment(first) {
  if (!validPose(first) || !first.valid_orientation) throw new Error('Initial footprint pose is invalid');
  return poseMatrix(first).invert();
}
function checkClock(documents) {
  const first = documents[0];
  for (const doc of documents) if (doc.n !== first.n || doc.fps !== first.fps || doc.t0 !== first.t0 || doc.space !== 'robot_world') throw new Error('Source clocks or coordinate frames disagree');
}

/** Optional geometry-derived observation; never overwrite published ach.ee fields. */
export function deriveEgoEndEffectors(links, kinematics) {
  const result = {};
  for (const side of ['left', 'right']) {
    const link = links[`${side}_wrist_roll_link`];
    const fixed = kinematics.joints?.find((joint) => joint.name === `${side}_gripper_joint_frame`);
    if (!validPose(link) || !link.valid_orientation || !fixed || fixed.type !== 'fixed' || fixed.parent !== `${side}_wrist_roll_link`) continue;
    result[side] = matrixPose(poseMatrix(link).multiply(jointMatrix(fixed)));
    result[side].provenance = 'Derived: exported wrist-roll world pose × fixed gripper_joint_frame; not a published achieved quaternion';
  }
  return result;
}

export function createEgoEpisode(record, { manifest, commands, robot, skeleton, kinematics }, warnings = []) {
  if (manifest.schema !== 'dyna.web.ego-replay.v1' || manifest.coordinate_frame !== 'robot_world' || manifest.up_axis !== 'Z' || manifest.units !== 'metres' || manifest.quaternion_order !== 'xyzw') throw new Error('Unsupported ego frame or units');
  if (manifest.variant !== 'rl' || manifest.revision !== 'real_time_1x') throw new Error('Expected recorded real-time RL source');
  checkClock([commands, robot, skeleton]);
  if (manifest.clock?.fps !== commands.fps || manifest.clock?.n !== commands.n || manifest.clock?.t0 !== commands.t0) throw new Error('Manifest clock disagrees with source columns');
  const cmd = decodeColumns(commands), rob = decodeColumns(robot), skel = decodeColumns(skeleton), start = record.start, end = record.end, duration = end - start;
  if (!(start >= 0 && end > start && end <= (cmd.n - 1) / cmd.fps + 1e-7)) throw new Error('Requested crop outside source clock');
  const alignment = initialAlignment(sampleColumns(cmd, start * cmd.fps).pose('cmd.fp', 'yaw'));
  const sample = (time) => {
    if (!finite(time)) throw new Error('Replay time must be finite');
    const t = Math.max(0, Math.min(duration, time)), source = (start + t) * cmd.fps;
    const c = sampleColumns(cmd, source), r = sampleColumns(rob, source), s = sampleColumns(skel, source);
    const targets = {}, actual = {}, raw = {}, taku_links = {};
    for (const [site, prefix] of [['left', 'ee_l'], ['right', 'ee_r']]) { targets[site] = aligned(c.pose(`cmd.${prefix}`), alignment); actual[site] = aligned(c.pose(`ach.${prefix}`, 'none'), alignment); }
    targets.footprint = aligned(c.pose('cmd.fp', 'yaw'), alignment); actual.footprint = aligned(c.pose('ach.base', 'yaw'), alignment);
    for (const name of robot.links ?? []) taku_links[name] = aligned(r.pose(`link.${name}`), alignment);
    for (const name of skeleton.joints ?? []) raw[name] = aligned(s.pose(`skel.${name}`, name.startsWith('elbow_') ? 'quaternion' : 'none'), alignment);
    const derived_actual = deriveEgoEndEffectors(taku_links, kinematics);
    return { t, source_t: commands.t0 + start + t, video_time_s: start + t, targets, actual, errors: errorsFor(targets, actual), derived_actual, derived_errors: errorsFor(targets, derived_actual), raw, taku_links, held: c.value('cmd.held') > .5, command_age_ms: c.value('cmd.age_ms') };
  };
  // Statistical population: only original sample timestamps within the exact crop.
  // Fractional boundaries are valid for display, never extra statistical samples.
  const frames = [];
  for (let i = Math.ceil(start * cmd.fps - 1e-8); i <= Math.floor(end * cmd.fps + 1e-8); i++) frames.push(sample(i / cmd.fps - start));
  const folder = EGO_BASE + record.sourceId + '/';
  const stanceBone = (skeleton.stance_bone ?? []).map((index) => skeleton.joints[index]);
  const bones = (skeleton.bones ?? []).map(([a, b]) => [skeleton.joints[a], skeleton.joints[b]])
    .filter(([a, b]) => !([a, b].includes('pelvis') && [a, b].includes('footprint'))
      && !(stanceBone.length === 2 && stanceBone.includes(a) && stanceBone.includes(b)));
  const derivedPositionAgreement = Object.fromEntries(['left', 'right'].map((site) => [site, summary(frames.map((frame) => errorsFor(frame.actual, frame.derived_actual)[site].position_m))]));
  return { ...record, duration, fps: cmd.fps, start, frames, sample, stats: statistics(frames), videoUrl: folder + 'ego.mp4',
    derivedOrientation: { method: 'Exported world wrist-roll pose multiplied by the fixed gripper_joint_frame transform; native timestamps, no second FK of world poses.', positionAgreement: derivedPositionAgreement },
    model: { modelUrl: EGO_BASE + 'dvt1_body.glb.txt', kinematics, expectedSha256: manifest.model_quality?.model_sha256 ?? manifest.integrity?.['../shared/dvt1_body.glb']?.sha256, expectedLinks: robot.links ?? [] },
    skeleton: { bones, inferred: skeleton.inferred ?? [], stanceBone },
    provenance: [folder + 'manifest.json', folder + 'commands.json', folder + 'robot.json', folder + 'skeleton.json', EGO_BASE + 'dvt1_kin.json'],
    warnings: [...warnings, 'Recorded 1× RL simulation, not physical hardware and not a reimplemented controller.', 'Ego commands expose hands and Footprint only. Skeleton elbows are guides; shoulders use an assumed 0.30 m upper-arm length. No official chest/elbow command is published.', 'Published achieved hand orientations are absent: the direct orientation metric is unavailable, not zero. An optional FK-derived metric reconstructs EE rotation from exported wrist-roll poses and the fixed EE frame; it is labelled separately and is not a measured quaternion.', ...Object.entries(derivedPositionAgreement).filter(([, stat]) => stat).map(([site, stat]) => `FK reference cross-check (${site}): reconstructed EE position versus published achieved position, mean ${(stat.mean * 1000).toFixed(2)} mm / max ${(stat.max * 1000).toFixed(2)} mm. Position agreement does not independently validate orientation; both sources are quantized.`), '15 Hz quantized display data; smooth playback does not recover high-frequency measurements. Video is uncalibrated context, not spatial reprojection.', 'Ego gripper width overlay is not replayed here; target fingers are a fixed reference mesh.'],
  };
}

export function jointMatrix(joint, value = 0) {
  const m = new Matrix4().makeRotationFromEuler(new Euler(...(joint.rpy ?? [0, 0, 0]), 'ZYX')).setPosition(...(joint.xyz ?? [0, 0, 0]));
  if (joint.type === 'prismatic') m.multiply(new Matrix4().makeTranslation(...joint.axis.map((axis) => axis * value)));
  else if (joint.type !== 'fixed' && value) m.multiply(new Matrix4().makeRotationAxis(new Vector3(...joint.axis).normalize(), value));
  return m;
}
export function forwardKinematics(kinematics, values) {
  const root = new Matrix4().makeRotationZ(values['robot.yaw']).setPosition(values['robot.x'], values['robot.y'], 0), links = new Map([[kinematics.root, root]]);
  let pending = [...kinematics.joints];
  while (pending.length) {
    const next = [];
    for (const joint of pending) {
      if (!links.has(joint.parent)) { next.push(joint); continue; }
      if (links.has(joint.child)) throw new Error('Duplicate or cyclic kinematic child');
      let value = values[`robot.${joint.name}`] ?? 0;
      const grip = /^(left|right)_gripper_(front|rear)_joint$/.exec(joint.name);
      if (grip) value = (grip[2] === 'front' ? -.0345 : .0345) * values[`robot.grip_${grip[1] === 'left' ? 'l' : 'r'}`];
      if (!finite(value)) throw new Error(`Missing joint state: ${joint.name}`);
      links.set(joint.child, links.get(joint.parent).clone().multiply(jointMatrix(joint, value)));
    }
    if (next.length === pending.length) throw new Error('Disconnected or cyclic kinematic tree');
    pending = next;
  }
  return links;
}
export function createTrackingEpisode(record, { document, kinematics }) {
  const decoded = decodeColumns(document, 'tracking'), duration = (decoded.n - 1) / decoded.fps;
  // The tracking encoding stores footprint z implicitly as zero.
  decoded.channels.set('target.fp.z', new Float64Array(decoded.n));
  for (const name of ['robot.x', 'robot.y', 'robot.yaw', 'robot.grip_l', 'robot.grip_r']) if (!decoded.channels.has(name)) throw new Error(`Missing tracking channel ${name}`);
  for (const joint of kinematics.joints) if (joint.type !== 'fixed' && !joint.name.includes('_gripper_') && !decoded.channels.has(`robot.${joint.name}`)) throw new Error(`Missing tracking joint ${joint.name}`);
  const alignment = initialAlignment(sampleColumns(decoded, 0, true).pose('target.fp', 'yaw'));
  const siteLinks = { left: 'left_ee_fk_target_frame', right: 'right_ee_fk_target_frame', chest: 'torso_body_link', elbow_left: 'left_elbow_link', elbow_right: 'right_elbow_link', footprint: 'agv_base' };
  const sample = (time) => {
    if (!finite(time)) throw new Error('Replay time must be finite');
    const t = Math.max(0, Math.min(duration, time)), source = sampleColumns(decoded, t * decoded.fps, true), values = Object.fromEntries([...decoded.channels.keys()].filter((name) => name.startsWith('robot.')).map((name) => [name, source.value(name)]));
    const matrices = forwardKinematics(kinematics, values), targets = {}, actual = {}, taku_links = {};
    for (const [name, matrix] of matrices) taku_links[name] = matrixPose(alignment.clone().multiply(matrix));
    for (const [site, prefix, orientation] of [['left', 'ee_l', 'quaternion'], ['right', 'ee_r', 'quaternion'], ['chest', 'chest', 'quaternion'], ['elbow_left', 'elbow_l', 'none'], ['elbow_right', 'elbow_r', 'none'], ['footprint', 'fp', 'yaw']]) {
      targets[site] = aligned(source.pose(`target.${prefix}`, orientation), alignment);
      if (!validPose(targets[site])) throw new Error(`Missing tracking target ${site}`);
      if (!matrices.has(siteLinks[site])) throw new Error(`Missing Taku reference link ${siteLinks[site]}`);
      actual[site] = matrixPose(alignment.clone().multiply(matrices.get(siteLinks[site])), orientation !== 'none');
    }
    return { t, targets, actual, errors: errorsFor(targets, actual), raw: {}, taku_links, joints: values, grip: { left: source.value('target.grip_l'), right: source.value('target.grip_r') } };
  };
  const frames = Array.from({ length: decoded.n }, (_, i) => sample(i / decoded.fps));
  return { ...record, duration, fps: decoded.fps, start: 0, videoUrl: null, frames, sample, stats: statistics(frames), skeleton: { bones: [] },
    model: { modelUrl: TRACKING_BASE + 'damping/dvt1_body.glb.txt', kinematics, expectedLinks: [...new Set([kinematics.root, ...kinematics.joints.map((j) => j.child)])] },
    provenance: [TRACKING_BASE + 'tracking_data.json', TRACKING_BASE + 'dvt1_kin.json'],
    warnings: ['Separate URR Tracking source, not synchronized with the three Ego videos.', 'Recorded robot joints drive forward kinematics. This viewer does not run an IK solver or RL policy.', 'Elbow targets contain position only. Ghost elbow orientation follows the elbow-to-wrist direction for display, not a recorded orientation.', '12 Hz quantized samples; native-sample statistics without temporal lag fitting.'],
  };
}

async function getJson(url, signal) {
  const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`Source HTTP ${response.status}: ${url}`);
  return response.json();
}
export async function loadEpisode(id, { signal, onProgress = () => {} } = {}) {
  const record = CATALOG.find((item) => item.id === id); if (!record) throw new Error('Unknown episode');
  if (record.kind === 'nymeria') return loadNymeriaEpisode(id, { signal, onProgress });
  onProgress(`Loading official ${record.label} source…`);
  if (record.kind === 'tracking') {
    const [document, kinematics] = await Promise.all([getJson(TRACKING_BASE + 'tracking_data.json', signal), getJson(TRACKING_BASE + 'dvt1_kin.json', signal)]);
    onProgress('Decoding recorded joints and native-sample errors…'); return createTrackingEpisode(record, { document, kinematics });
  }
  const folder = EGO_BASE + record.sourceId + '/';
  const [manifest, commands, robot, skeleton, kinematics] = await Promise.all(['manifest.json', 'commands.json', 'robot.json', 'skeleton.json'].map((name) => getJson(folder + name, signal)).concat(getJson(EGO_BASE + 'dvt1_kin.json', signal)));
  onProgress('Decoding source poses and native-sample errors…');
  return createEgoEpisode(record, { manifest, commands, robot, skeleton, kinematics });
}
