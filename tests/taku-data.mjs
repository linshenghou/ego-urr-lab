import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { NYMERIA_CATALOG } from '../src/nymeria.js';
import { createTakuEpisode, fetchVerifiedJson, validateTakuSolution } from '../src/taku-retarget.js';
import { forwardKinematics, matrixPose } from '../src/data.js';

const read = (file) => JSON.parse(fs.readFileSync(new URL(`../public/data/nymeria/${file}`, import.meta.url)));
function fixture() {
  const record = NYMERIA_CATALOG[1], source = read(record.file), solution = read(record.solution);
  for (const key of ['time', 'source_time']) source[key] = source[key].slice(0, 3);
  source.skeleton.positions = source.skeleton.positions.slice(0, 3);
  source.extraction.exported_frame_count = 3;
  for (const dataset of [source, solution]) for (const site of Object.values(dataset.targets)) for (const key of ['p', 'q', 'pv', 'ov', 'interval_pv', 'interval_ov']) if (site[key] !== null) site[key] = site[key].slice(0, key.startsWith('interval') ? 2 : 3);
  solution.time = [...source.time];
  solution.q = Array.from({ length: 3 }, (_, i) => solution.solver.home.map((x, j) => x + (j === 0 ? i * .01 : 0)));
  // Made-up flat fixed tree, NOT redistributed Taku dimensions or assets.
  const kin = { root: 'agv_base', joints: Object.values(solution.mapping.site_links).filter((name) => name !== 'agv_base').map((child, i) => ({ name: `fixture_${i}`, type: 'fixed', parent: 'agv_base', child, xyz: [.2, i * .1, 1], rpy: [0, 0, .2] })) };
  solution.actual = Object.fromEntries(Object.keys(solution.mapping.site_links).map((site) => [site, { p: [], q: site.startsWith('elbow') ? null : [] }]));
  for (const [i, q] of solution.q.entries()) {
    const links = forwardKinematics(kin, Object.fromEntries(solution.joint_names.map((name, j) => [name, q[j]])));
    for (const [site, link] of Object.entries(solution.mapping.site_links)) {
      const actual = matrixPose(links.get(link)); solution.actual[site].p.push(actual.p); solution.actual[site].q?.push(actual.q);
      solution.targets[site].p[i] = actual.p.map((x, j) => x + (j === 2 ? .1 : 0));
      if (solution.targets[site].q) solution.targets[site].q[i] = actual.q;
    }
  }
  return { record, source, solution, kin };
}
test('Taku replay recomputes FK and errors from joints, keeps source URR separate', () => {
  const { record, source, solution, kin } = fixture(), e = createTakuEpisode(record, source, solution, kin);
  assert.equal(e.frames.length, 3); assert.equal(e.videoUrl, null); assert.equal(e.ik.dof, 21);
  assert.ok(Math.abs(e.stats.left.position.mean - .1) < 1e-12, 'does not trust stored solution error arrays');
  const mid = e.sample(source.time[1] / 2);
  assert.ok(Math.abs(mid.actual.left.p[0] - .205) < 1e-12);
  assert.deepEqual(mid.source_targets.left.p, mid.raw.l_wrist.p);
  assert.notDeepEqual(mid.targets.left.p, mid.source_targets.left.p);
  assert.equal(mid.errors.elbow_left.orientation_rad, null);
  assert.equal(e.sample(999).t, source.time.at(-1)); assert.throws(() => e.sample(NaN), /finite/);
});
test('invalid mapped target intervals suppress errors without hiding real FK', () => {
  const { record, source, solution, kin } = fixture(); solution.targets.left.interval_pv[0] = false; solution.targets.left.interval_ov[0] = false;
  const e = createTakuEpisode(record, source, solution, kin), frame = e.sample(source.time[1] / 2);
  assert.equal(frame.targets.left.valid_position, false); assert.equal(frame.errors.left.position_m, null); assert.equal(frame.errors.left.orientation_rad, null);
  assert.equal(frame.actual.left.valid_position, true); assert.equal(frame.source_targets.left.valid_position, true);
});
test('rejects mismatched clocks, provenance, jumps and independently inconsistent FK', () => {
  let f = fixture(); f.solution.time[1] += .01; assert.throws(() => validateTakuSolution(f.record, f.source, f.solution), /clock/);
  f = fixture(); f.solution.source.source_excerpt_sha256 = '0'.repeat(64); assert.throws(() => validateTakuSolution(f.record, f.source, f.solution), /provenance/);
  f = fixture(); f.solution.q[1][0] += 1; assert.throws(() => validateTakuSolution(f.record, f.source, f.solution), /discontinuous/);
  f = fixture(); f.solution.actual.left.p[1][0] += .01; assert.throws(() => createTakuEpisode(f.record, f.source, f.solution, f.kin), /FK disagreement/);
});
test('runtime SHA pins fail closed if any remote or local JSON changes', async () => {
  const original = globalThis.fetch, bytes = '{"fixture":true}', hash = createHash('sha256').update(bytes).digest('hex');
  globalThis.fetch = async () => new Response(bytes);
  try { assert.deepEqual(await fetchVerifiedJson('https://example.org/fixture', hash), { fixture: true }); await assert.rejects(fetchVerifiedJson('https://example.org/fixture', '0'.repeat(64)), /integrity mismatch/); }
  finally { globalThis.fetch = original; }
});
test('all public trajectories agree with independent browser FK', { skip: !process.env.TAKU_KINEMATICS }, () => {
  const kin = JSON.parse(fs.readFileSync(process.env.TAKU_KINEMATICS));
  for (const record of NYMERIA_CATALOG) {
    const solution = read(record.solution), e = createTakuEpisode(record, read(record.file), solution, kin);
    for (const site of Object.keys(e.stats)) for (const metric of ['position', 'orientation']) {
      const actual = e.stats[site][metric], expected = solution.stats[site][metric];
      assert.equal(actual?.n, expected?.n);
      if (actual) for (const key of ['mean', 'p95', 'max']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6);
    }
  }
});
