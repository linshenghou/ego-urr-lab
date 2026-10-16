/** Our offline Nymeria retarget, never an official Dyna tracking recording. */
import { Quaternion } from 'three';
import { forwardKinematics, matrixPose, errorsFor, summary } from './data.js';
import { createNymeriaEpisode } from './nymeria.js';

export const TAKU_KINEMATICS_URL = 'https://www.dyna.co/assets/we/dvt1_kin.json';
export const TAKU_KINEMATICS_SHA256 = '02505a774c55fb3f998265e32840bffd86fba690bd4c9e1af857663ca39ec83f';
const SITES = ['left', 'right', 'elbow_left', 'elbow_right', 'chest', 'footprint'];
const LINKS = { left: 'left_ee_fk_target_frame', right: 'right_ee_fk_target_frame', elbow_left: 'left_elbow_link', elbow_right: 'right_elbow_link', chest: 'torso_body_link', footprint: 'agv_base' };
const JOINTS = ['robot.x', 'robot.y', 'robot.yaw', 'robot.folding_low_joint', 'robot.folding_high_joint', 'robot.waist_pitch_joint', 'robot.waist_yaw_joint', ...['left', 'right'].flatMap((side) => ['shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_yaw', 'wrist_pitch', 'wrist_roll'].map((name) => `robot.${side}_${name}_joint`))];

export async function fetchVerifiedJson(url, expected, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Source HTTP ${response.status}: ${url}`);
  const bytes = await response.arrayBuffer();
  if (!globalThis.crypto?.subtle) throw new Error('HTTPS / localhost is required for source integrity verification');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hash !== expected) throw new Error(`Source integrity mismatch: ${url}. Refusing to combine a changed source with stored IK.`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function validateTakuSolution(record, source, solution) {
  const n = source.time.length;
  if (solution?.schema !== 'ego-urr-lab.taku-retarget.v1' || JSON.stringify(solution.joint_names) !== JSON.stringify(JOINTS)) throw new Error('Unsupported Taku IK schema / joint order');
  if (!Array.isArray(solution.time) || solution.time.length !== n || solution.time.some((t, i) => t !== source.time[i])) throw new Error('Taku/source clock mismatch');
  if (solution.source?.source_excerpt_sha256 !== record.sha256 || solution.source?.kinematics_sha256 !== TAKU_KINEMATICS_SHA256 || solution.source?.kinematics_url !== TAKU_KINEMATICS_URL || solution.source?.sequence_id !== source.source.sequence_id) throw new Error('Taku/source provenance mismatch');
  if (solution.license?.id !== 'CC-BY-NC-4.0' || !solution.license.attribution) throw new Error('Missing Taku derivative source license');
  if (JSON.stringify(solution.mapping?.site_links) !== JSON.stringify(LINKS)) throw new Error('Unexpected Taku reference links');
  const solver = solution.solver;
  if (solver?.dof !== 21 || solver.bounds_are_manufacturer_limits !== false || solver.actuator_velocity_limits !== false || solver.actuator_acceleration_limits !== false) throw new Error('Invalid solver scope');
  for (const name of ['lower', 'upper', 'home', 'trust_step_per_frame']) if (!Array.isArray(solver[name]) || solver[name].length !== 21 || !solver[name].every(Number.isFinite)) throw new Error('Invalid numerical bounds');
  if (!Array.isArray(solution.q) || solution.q.length !== n) throw new Error('Invalid solved joint frames');
  for (const [i, q] of solution.q.entries()) {
    if (!Array.isArray(q) || q.length !== 21 || q.some((value, j) => !Number.isFinite(value) || value < solver.lower[j] - 2e-9 || value > solver.upper[j] + 2e-9 || (i && Math.abs(value - solution.q[i - 1][j]) > solver.trust_step_per_frame[j] + 2e-9))) throw new Error(`Invalid or discontinuous Taku configuration at frame ${i}`);
  }
  for (const site of SITES) {
    const expected = solution.actual?.[site];
    if (expected?.p?.length !== n || expected.p.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))) throw new Error(`Invalid saved FK positions: ${site}`);
    if (!site.startsWith('elbow') && (expected.q?.length !== n || expected.q.some((q) => !Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-7))) throw new Error(`Invalid saved FK rotations: ${site}`);
  }
  return solution;
}

export function createTakuEpisode(record, document, solution, kinematics) {
  const source = createNymeriaEpisode(record, document);
  validateTakuSolution(record, document, solution);
  // Reuse the same strict clock/pose/mask sampler; the raw skeleton is not remapped.
  const mapped = createNymeriaEpisode(record, { ...document, targets: solution.targets });
  const times = solution.time;
  function sample(value) {
    const human = source.sample(value), targetFrame = mapped.sample(value), t = human.t;
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= t + 1e-10) lo = mid + 1; else hi = mid; }
    const i = Math.max(0, lo - 1), j = Math.min(i + 1, times.length - 1), a = i === j ? 0 : Math.max(0, (t - times[i]) / (times[j] - times[i]));
    const joints = { 'robot.grip_l': 0, 'robot.grip_r': 0 };
    for (const [k, name] of JOINTS.entries()) joints[name] = solution.q[i][k] * (1 - a) + solution.q[j][k] * a;
    const matrices = forwardKinematics(kinematics, joints), actual = {};
    for (const site of SITES) {
      if (!matrices.has(LINKS[site])) throw new Error(`Missing Taku reference link: ${LINKS[site]}`);
      actual[site] = matrixPose(matrices.get(LINKS[site]), !site.startsWith('elbow'));
    }
    return { t, source_t: human.source_t, raw: human.raw, source_targets: human.targets, targets: targetFrame.targets, actual,
      taku_links: Object.fromEntries([...matrices].map(([name, matrix]) => [name, matrixPose(matrix)])), joints,
      errors: errorsFor(targetFrame.targets, actual) };
  }
  const frames = times.map(sample);
  // Browser Three.js FK is independent of Python's exported FK. Fail closed on
  // frame-reference/model drift instead of silently showing mismatched geometry.
  for (const [i, frame] of frames.entries()) for (const site of SITES) {
    const saved = solution.actual[site], actual = frame.actual[site];
    if (Math.hypot(...actual.p.map((x, k) => x - saved.p[i][k])) > 2e-7 || (actual.valid_orientation && new Quaternion(...actual.q).angleTo(new Quaternion(...saved.q[i]).normalize()) > 1e-6)) throw new Error(`Independent Taku FK disagreement: ${site} frame ${i}`);
  }
  const stats = Object.fromEntries(SITES.map((site) => [site, { position: summary(frames.map((f) => f.errors[site].position_m)), orientation: summary(frames.map((f) => f.errors[site].orientation_rad)) }]));
  return { ...source, frames, sample, stats, mapping: solution.mapping, ik: solution.solver,
    model: { modelUrl: 'https://www.dyna.co/assets/we/damping/dvt1_body.glb.txt', kinematics, expectedSha256: '71d9896eb4646c3c4f5b0a1fc0c9ed4acf54c1040fdbfab49345bb9ed20d443c', strictIntegrity: true, expectedLinks: [...new Set([kinematics.root, ...kinematics.joints.map((joint) => joint.child)])] },
    provenance: [...source.provenance, TAKU_KINEMATICS_URL, 'scripts/retarget-taku.py', 'docs/methods.md'],
    warnings: ['Our offline numerical Taku IK, not official Dyna motion, a learned policy or physical robot measurements.',
      'Per-site first-frame-relative mapping anchors source motion to an authored Taku home; it does not preserve the human absolute heights or limb lengths.',
      'Source-conditioned home uses two explicit pose presets, not a learned calibration. The original human skeleton remains separate in the source inset.',
      solution.solver.bounds_notice, solution.solver.frame_trust_notice,
      'No hardware velocity/acceleration specification, dynamics, collision, contact, balance or wheel rolling constraints are enforced. Not safe hardware commands.',
      'Real Taku component meshes depict mapped URR targets. Elbow mesh heading is display-derived, not an orientation target. Grippers remain at reference opening.',
      ...source.warnings.slice(1)],
  };
}
