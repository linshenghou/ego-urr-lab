import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, Matrix4 } from 'three';
import { decodeColumns, createEgoEpisode, createTrackingEpisode, errorsFor, pose, summary, jointMatrix, forwardKinematics, deriveEgoEndEffectors, CATALOG } from '../src/data.js';

function encoded(values) { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, i) => bytes.writeInt16LE(value, i * 2)); return bytes.toString('base64'); }
function columns(n = 5, fps = 2) { return { schema: 'dyna.web.columnar-int16.v1', n, fps, t0: 20, space: 'robot_world', null_value: -32768, scales: { pos: 1000, quat: 10000, yaw: 1000 }, channels: {}, constants: {}, channel_kinds: {} }; }
function add(document, name, values, kind = 'pos') { document.channels[name] = encoded(values); document.channel_kinds[name] = kind; }
function addPose(document, prefix, positions = Array.from({ length: document.n }, (_, i) => [i * 100, 0, 1000]), orientation = 'quaternion') {
  for (const [i, axis] of [...'xyz'].entries()) add(document, `${prefix}.${axis}`, positions.map((p) => p[i]));
  if (orientation === 'yaw') add(document, `${prefix}.yaw`, positions.map(() => 0), 'yaw');
  else if (orientation === 'quaternion') for (const axis of 'xyzw') add(document, `${prefix}.q${axis}`, positions.map(() => axis === 'w' ? 10000 : 0), 'quat');
}
function egoFixture(start = .25, end = 1.75) {
  const commands = columns(), robot = columns(), skeleton = columns();
  for (const side of ['l', 'r']) { addPose(commands, `cmd.ee_${side}`); addPose(commands, `ach.ee_${side}`, Array.from({ length: 5 }, (_, i) => [i * 100 + 100, 0, 1000]), 'none'); }
  const ground = Array.from({ length: 5 }, (_, i) => [1000 + i * 100, 2000, 0]); addPose(commands, 'cmd.fp', ground, 'yaw'); addPose(commands, 'ach.base', ground, 'yaw');
  robot.links = ['agv_base', 'left_wrist_roll_link']; for (const name of robot.links) addPose(robot, `link.${name}`);
  skeleton.joints = ['pelvis', 'elbow_l']; skeleton.bones = [[0, 1]]; skeleton.inferred = []; for (const name of skeleton.joints) addPose(skeleton, `skel.${name}`, undefined, 'none');
  const manifest = { schema: 'dyna.web.ego-replay.v1', coordinate_frame: 'robot_world', units: 'metres', up_axis: 'Z', quaternion_order: 'xyzw', variant: 'rl', revision: 'real_time_1x', clock: { fps: 2, n: 5, t0: 20 } };
  const record = { id: 'test', sourceId: 'synthetic', label: 'Synthetic test only', kind: 'ego', start, end };
  return { record, input: { manifest, commands, robot, skeleton, kinematics: { joints: [] } } };
}
test('signed little-endian channels preserve invalid sentinel and constants', () => {
  const doc = columns(3); add(doc, 'x', [1000, -2000, -32768]); doc.constants.y = -32768; doc.channel_kinds.y = 'pos';
  const decoded = decodeColumns(doc); assert.deepEqual([...decoded.channels.get('x')].slice(0, 2), [1, -2]); assert.ok(Number.isNaN(decoded.channels.get('x')[2])); assert.ok(Number.isNaN(decoded.channels.get('y')[0]));
  doc.n = 4; assert.throws(() => decodeColumns(doc), /length/); doc.n = 3; doc.constants.x = 0; assert.throws(() => decodeColumns(doc), /Duplicate/);
});
test('malformed scale, frame count and base64 fail explicitly', () => {
  const doc = columns(3); add(doc, 'x', [0, 1, 2]); doc.scales.pos = 0; assert.throws(() => decodeColumns(doc), /scale/); doc.scales.pos = 1; doc.channels.x = '@@@'; assert.throws(() => decodeColumns(doc), /base64/);
  doc.n = 0; assert.throws(() => decodeColumns(doc), /clock/);
});
test('exact crop display is interpolated; statistics contain native samples only', () => {
  const { record, input } = egoFixture(); const episode = createEgoEpisode(record, input);
  assert.equal(episode.duration, 1.5); assert.deepEqual(episode.frames.map((f) => f.t), [.25, .75, 1.25]); assert.equal(episode.stats.left.position.n, 3);
  const first = episode.sample(0); assert.ok(Math.abs(first.targets.left.p[0] + 1) < 1e-12); assert.deepEqual(first.targets.footprint.p, [0, 0, 0]);
  assert.equal(first.video_time_s, .25); assert.equal(first.source_t, 20.25); assert.equal(episode.sample(1.5).video_time_s, 1.75);
  assert.ok(Math.abs(episode.stats.left.position.mean - .1) < 1e-12); assert.equal(episode.stats.left.orientation, null);
  assert.deepEqual(Object.keys(first.targets).sort(), ['footprint', 'left', 'right']); assert.equal(first.targets.chest, undefined); assert.equal(first.targets.elbow_left, undefined);
  assert.throws(() => episode.sample(NaN), /finite/); assert.equal(episode.sample(-99).t, 0); assert.equal(episode.sample(99).t, 1.5);
});
test('manifest/column clock and frame mismatches are blocked', () => {
  const { record, input } = egoFixture(); input.robot.t0 = 21; assert.throws(() => createEgoEpisode(record, input), /clocks/); input.robot.t0 = 20; input.manifest.clock.n = 6; assert.throws(() => createEgoEpisode(record, input), /Manifest clock/);
});
test('pelvis-to-footprint stance guide is never duplicated as an anatomical bone', () => {
  const { record, input } = egoFixture(); input.skeleton.joints.push('footprint'); input.skeleton.bones.push([0, 2]); input.skeleton.stance_bone = [0, 2]; addPose(input.skeleton, 'skel.footprint', undefined, 'none');
  const episode = createEgoEpisode(record, input); assert.deepEqual(episode.skeleton.bones, [['pelvis', 'elbow_l']]); assert.deepEqual(episode.skeleton.stanceBone, ['pelvis', 'footprint']);
});
test('invalid interpolation endpoints are not bridged and exact valid sample remains valid', () => {
  const { record, input } = egoFixture(0, 2); add(input.commands, 'cmd.ee_l.x', [0, -32768, 200, 300, 400]);
  const episode = createEgoEpisode(record, input); assert.ok(episode.sample(0).targets.left.valid_position); assert.equal(episode.sample(.25).targets.left.valid_position, false); assert.equal(episode.sample(.25).errors.left.position_m, null); assert.equal(episode.stats.left.position.n, 4);
});
test('orientation geodesic is sign invariant, missing labels remain unavailable', () => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .8).toArray(); const p = [0, 0, 0];
  assert.ok(errorsFor({ left: pose(p, q) }, { left: pose(p, q.map((v) => -v)) }).left.orientation_rad < 1e-7);
  assert.equal(errorsFor({ left: pose(p, q) }, { left: pose(p) }).left.orientation_rad, null);
  assert.equal(summary([null, NaN]), null); assert.deepEqual(summary([0, 1, 2]), { n: 3, mean: 1, p95: 1.9, max: 2 });
});
test('derived EGO orientation uses the exact fixed EE frame and preserves direct missing data', () => {
  const { record, input } = egoFixture(0, 2);
  input.kinematics.joints.push({ name: 'left_gripper_joint_frame', type: 'fixed', parent: 'left_wrist_roll_link', child: 'left_ee_fk_target_frame', xyz: [.05, 0, 0], rpy: [0, 0, Math.PI / 2] });
  const episode = createEgoEpisode(record, input), frame = episode.sample(0);
  assert.equal(frame.actual.left.q, null);
  assert.equal(frame.errors.left.orientation_rad, null);
  assert.equal(episode.stats.left.orientation, null);
  assert.ok(Math.abs(frame.derived_errors.left.orientation_rad - Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(frame.derived_actual.left.p[0] - frame.taku_links.left_wrist_roll_link.p[0] - .05) < 1e-10);
  assert.equal(frame.derived_actual.right, undefined);
  assert.ok(Math.abs(episode.derivedOrientation.positionAgreement.left.mean - .05) < 1e-10);
  input.kinematics.joints[0].type = 'revolute';
  assert.deepEqual(deriveEgoEndEffectors(frame.taku_links, input.kinematics), {});
});
test('FK origin is Rz Ry Rx then local motion, with root applied once', () => {
  const joint = { name: 'arm', parent: 'base', child: 'tip', type: 'revolute', xyz: [.2, 0, 1], rpy: [0, 0, .3], axis: [0, 0, 1] };
  const kin = { root: 'base', joints: [joint] }, values = { 'robot.x': 1, 'robot.y': 2, 'robot.yaw': .4, 'robot.arm': .6 };
  const links = forwardKinematics(kin, values); const expected = new Matrix4().makeRotationZ(.4).setPosition(1, 2, 0).multiply(jointMatrix(joint, .6));
  links.get('tip').elements.forEach((value, i) => assert.ok(Math.abs(value - expected.elements[i]) < 1e-12));
  assert.throws(() => forwardKinematics({ root: 'base', joints: [{ ...joint, parent: 'missing' }] }, values), /Disconnected/);
});
test('public catalog contains only the two paired Nymeria excerpts', () => {
  assert.equal(CATALOG.length, 2); assert.ok(CATALOG.every((e) => e.kind === 'nymeria'));
  for (const entry of CATALOG) { assert.match(entry.sha256, /^[a-f0-9]{64}$/); assert.match(entry.solutionSha256, /^[a-f0-9]{64}$/); assert.match(entry.solution, /-taku.json$/); }
});

function trackingFixture() {
  const document = { n: 3, fps: 2, scale: { pos: 1000, ang: 10000, unit: 10000 }, channels: {} };
  const add = (name, values, kind = 'pos') => { document.channels[name] = [kind, encoded(values)]; };
  for (const name of ['robot.x', 'robot.y', 'target.fp.x', 'target.fp.y']) add(name, [0, 0, 0]);
  for (const name of ['robot.yaw', 'target.fp.yaw']) add(name, [31000, -31000, -30000], 'ang');
  for (const name of ['robot.grip_l', 'robot.grip_r', 'target.grip_l', 'target.grip_r']) add(name, [0, 0, 0], 'unit');
  for (const prefix of ['ee_l', 'ee_r', 'chest', 'elbow_l', 'elbow_r']) {
    for (const axis of 'xyz') add(`target.${prefix}.${axis}`, [0, 0, 0]);
    if (!prefix.startsWith('elbow')) for (const axis of 'xyzw') add(`target.${prefix}.q${axis}`, [axis === 'w' ? 10000 : 0, axis === 'w' ? 10000 : 0, axis === 'w' ? 10000 : 0], 'unit');
  }
  const root = 'agv_base', names = ['left_ee_fk_target_frame', 'right_ee_fk_target_frame', 'torso_body_link', 'left_elbow_link', 'right_elbow_link'];
  const kinematics = { root, joints: names.map((child) => ({ name: child + '_joint', parent: root, child, type: 'fixed', xyz: [.1, 0, 0], rpy: [0, 0, 0], axis: [0, 0, 1] })) };
  return { document, kinematics };
}
test('tracking has all six native target sites, missing elbow orientation, shortest yaw', () => {
  const episode = createTrackingEpisode({ id: 'test', kind: 'tracking' }, trackingFixture());
  assert.equal(episode.frames.length, 3); assert.equal(episode.videoUrl, null); assert.equal(Object.keys(episode.sample(0).targets).length, 6);
  assert.equal(episode.stats.elbow_left.orientation, null); assert.equal(episode.stats.left.position.n, 3);
  assert.ok(Math.abs(episode.stats.left.position.mean - .1) < 1e-12);
  const q = episode.sample(.25).actual.footprint.q, angle = new Quaternion(...q).angleTo(new Quaternion(0, 0, 0, 1));
  assert.ok(angle < .1, 'after one fixed initial-yaw alignment the halfway pose crosses pi by the short path');
  const before = episode.sample(.2); episode.sample(.8); assert.deepEqual(episode.sample(.2), before);
});
test('tracking fails on absent source joints or targets instead of synthesizing them', () => {
  const input = trackingFixture(); delete input.document.channels['target.ee_l.x']; assert.throws(() => createTrackingEpisode({ kind: 'tracking' }, input), /Missing tracking target/);
  const other = trackingFixture(); other.kinematics.joints[0].type = 'revolute'; assert.throws(() => createTrackingEpisode({ kind: 'tracking' }, other), /Missing tracking joint/);
});
