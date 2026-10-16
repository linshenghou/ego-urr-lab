import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildModel, validateModelNodes } from '../src/scene.js';
import { pose, poseMatrix, jointMatrix } from '../src/data.js';
const names = ['agv_base', 'torso_body_link', 'left_wrist_roll_link', 'right_wrist_roll_link', 'left_elbow_link', 'right_elbow_link', 'left_grippera_link', 'right_grippera_link'];
const kin = { joints: ['left', 'right'].flatMap((side) => [{ name: `${side}_gripper_joint_frame`, type: 'fixed', xyz: [0, 0, -.088527], rpy: [0, 0, 0], parent: `${side}_wrist_roll_link`, child: `${side}_ee` }, { name: `${side}_gripper_front_joint`, parent: `${side}_wrist_roll_link`, child: `${side}_grippera_link`, type: 'prismatic', axis: [0, 1, 0], xyz: [0, 0, 0], rpy: [0, 0, 0] }]) };
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
