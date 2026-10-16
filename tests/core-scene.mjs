import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildModel, buildHumanSkeleton, validateModelNodes } from '../src/scene.js';
import { pose, poseMatrix, jointMatrix } from '../src/data.js';
const names = ['agv_base', 'torso_body_link', 'left_wrist_roll_link', 'right_wrist_roll_link', 'left_elbow_link', 'right_elbow_link', 'left_grippera_link', 'right_grippera_link'];
const kin = { joints: ['left', 'right'].flatMap((side) => [{ name: `${side}_gripper_joint_frame`, type: 'fixed', xyz: [-.02852, 0, -.088527], rpy: [0, 0, -Math.PI / 2], parent: `${side}_wrist_roll_link`, child: `${side}_ee` }, { name: `${side}_gripper_front_joint`, parent: `${side}_wrist_roll_link`, child: `${side}_grippera_link`, type: 'prismatic', axis: [0, 1, 0], xyz: [0, 0, 0], rpy: [0, 0, 0] }]) };
function fixture() { const scene = new THREE.Group(); for (const name of names) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshStandardMaterial()); mesh.name = `${name}__0`; mesh.position.set(.01, .02, .03); scene.add(mesh); } return scene; }
const near = (a, b) => a.elements.forEach((value, i) => assert.ok(Math.abs(value - b.elements[i]) < 1e-10));
test('model binding permits identity wrapper, rejects unknown or transformed ancestors', () => {
  const scene = fixture(); assert.equal(validateModelNodes(scene, names).size, names.length); assert.throws(() => validateModelNodes(scene, []), /unknown/);
  const parent = new THREE.Group(); parent.add(scene.children[0]); scene.add(parent); assert.equal(validateModelNodes(scene, names).size, names.length);
  parent.position.x = 1; assert.throws(() => validateModelNodes(scene, names), /transformed/);
});
test('solid world groups apply source pose once and preserve mesh local TRS', () => {
  const model = buildModel(fixture(), kin), wrist = pose([1, 2, 3], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .5).toArray());
  model.update({ taku_links: { left_wrist_roll_link: wrist }, targets: {} });
  near(model.links.get('left_wrist_roll_link').matrixWorld, poseMatrix(wrist));
  near(model.links.get('left_wrist_roll_link').children[0].matrixWorld, poseMatrix(wrist).multiply(new THREE.Matrix4().makeTranslation(.01, .02, .03)));
  assert.equal(model.links.get('agv_base').visible, false); model.dispose();
});
test('EE ghost uses declared frame inverse; unavailable chest/elbow are hidden', () => {
  const model = buildModel(fixture(), kin), target = pose([.5, .3, 1], [0, 0, 0, 1]); model.update({ taku_links: {}, targets: { left: target } });
  near(model.hands.left.group.matrixWorld, poseMatrix(target).multiply(jointMatrix(kin.joints[0]).invert()));
  assert.equal(model.groups.chest.visible, false); assert.equal(model.groups.elbow_left.visible, false); assert.equal(model.groups.right.visible, false); model.dispose();
});
test('elbow position stays fixed while display rotation follows target wrist', () => {
  const model = buildModel(fixture(), kin), elbow = pose([0, 0, 1]); const frame = { taku_links: {}, targets: { elbow_left: elbow, left: pose([1, 0, 1], [0, 0, 0, 1]) } };
  model.update(frame); const before = model.groups.elbow_left.quaternion.clone(); frame.targets.left = pose([0, 0, 2], [0, 0, 0, 1]); model.update(frame);
  assert.deepEqual(model.groups.elbow_left.position.toArray(), [0, 0, 1]); assert.ok(before.angleTo(model.groups.elbow_left.quaternion) > .5); assert.equal(elbow.q, null); model.dispose();
});
test('Nymeria URR layer uses actual torso, elbow, hand and base mesh geometry', () => {
  const source = fixture(), model = buildModel(source, kin);
  for (const [site, link] of Object.entries({ chest: 'torso_body_link', footprint: 'agv_base', elbow_left: 'left_elbow_link', elbow_right: 'right_elbow_link', left: 'left_wrist_roll_link', right: 'right_wrist_roll_link' })) {
    const original = source.children.find((mesh) => mesh.name === `${link}__0`), mesh = model.groups[site].getObjectByName(`${link}__0`);
    assert.equal(mesh.geometry, original.geometry, `${site} must reuse loaded robot geometry`);
    assert.equal(mesh.material, model.ghostMaterial); assert.equal(mesh.material.transparent, true); assert.equal(mesh.material.depthWrite, false);
    assert.equal(model.links.get(link).children[0].geometry, original.geometry);
    assert.notEqual(model.links.get(link).children[0].material, model.ghostMaterial);
  }
  model.dispose();
});
test('target mesh and genuine solved robot transforms are independent', () => {
  const model = buildModel(fixture(), kin), actual = pose([1, 2, .8], [0, 0, 0, 1]);
  const frame = { taku_links: { torso_body_link: actual, agv_base: pose([1, 2, 0], [0, 0, 0, 1]) }, targets: { chest: pose([3, 4, 1.3], [0, 0, 0, 1]), footprint: pose([3, 4, 0], [0, 0, 0, 1]) } };
  model.update(frame); near(model.links.get('torso_body_link').matrixWorld, poseMatrix(actual)); near(model.groups.chest.matrixWorld, poseMatrix(frame.targets.chest));
  frame.targets.chest.p = [8, 9, 2]; model.update(frame); near(model.links.get('torso_body_link').matrixWorld, poseMatrix(actual));
  model.solid.visible = false; assert.equal(model.targets.visible, true); model.targets.visible = false; model.solid.visible = true; assert.equal(model.targets.visible, false);
  assert.deepEqual(actual.p, [1, 2, .8]); model.dispose();
});
test('oriented torso/base/hand meshes do not invent an orientation when masked', () => {
  const model = buildModel(fixture(), kin);
  model.update({ targets: { chest: pose([0, 0, 1]), footprint: pose([0, 0, 0]), left: pose([1, 0, 1]), elbow_left: pose([0, 0, 1]) } });
  for (const site of ['chest', 'footprint', 'left']) assert.equal(model.groups[site].visible, false);
  assert.equal(model.groups.elbow_left.visible, true);
  const heading = new THREE.Vector3(0, 0, -1).applyQuaternion(model.groups.elbow_left.quaternion);
  assert.ok(heading.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-10); model.dispose();
});
test('raw human inset consumes only source skeleton and source targets, never robot mapping', () => {
  const human = buildHumanSkeleton(), raw = { root: pose([0, 0, .8]), elbow: pose([0, .2, 1.2]), wrist: pose([.3, .2, 1.2]) };
  const source_targets = { left: pose([.3, .2, 1.2], [0, 0, 0, 1]), elbow_left: pose([0, .2, 1.2]), footprint: pose([0, 0, 0], [0, 0, 0, 1]) };
  const frame = { raw, source_targets, targets: { left: pose([100, 100, 100], [0, 0, 0, 1]) }, taku_links: { torso_body_link: pose([100, 100, 100], [0, 0, 0, 1]) } };
  const before = JSON.stringify(frame); human.update(frame, { bones: [['elbow', 'wrist']] }, { anatomy: { hip: 'root' } });
  assert.equal(human.bones.count, 1); assert.equal(human.joints.count, 3);
  near(human.groups.left.matrixWorld, poseMatrix(source_targets.left));
  assert.equal(human.axes.left.visible, true); assert.equal(human.axes.elbow_left, undefined);
  const matrix = new THREE.Matrix4(); human.bones.getMatrixAt(0, matrix);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(new THREE.Vector3(.15, .2, 1.2)) < 1e-6);
  assert.deepEqual(Array.from(human.stance.geometry.attributes.position.array).map((x) => +x.toFixed(5)), [0, 0, .8, 0, 0, 0]);
  assert.equal(JSON.stringify(frame), before);
  frame.source_targets = {}; human.update(frame, { bones: [['elbow', 'wrist']] });
  assert.equal(human.groups.left.visible, false, 'must not fall back to robot target');
  assert.equal(human.stance.geometry.attributes.position.count, 0); human.dispose();
});
test('source inset hides invalid joints/bones and invalid orientation axes', () => {
  const human = buildHumanSkeleton(), masked = { ...pose([1, 0, 1]), valid_position: false };
  human.update({ raw: { a: pose([0, 0, 1]), b: masked }, source_targets: { left: pose([0, 0, 1]), right: masked } }, { bones: [['a', 'b']] });
  assert.equal(human.bones.count, 0); assert.equal(human.joints.count, 1); assert.equal(human.groups.left.visible, true);
  assert.equal(human.axes.left.visible, false); assert.equal(human.groups.right.visible, false); human.dispose();
});
