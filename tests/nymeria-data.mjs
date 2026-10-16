import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NYMERIA_CATALOG, createNymeriaEpisode, validateNymeria } from '../src/nymeria.js';

function fixture() {
  const p = [[0, 0, 1], [1, 0, 1], [2, 0, 1]], q = p.map(() => [0, 0, 0, 1]);
  const sites = ['left', 'right', 'elbow_left', 'elbow_right', 'chest', 'footprint'];
  return { schema: 'ego-urr-lab.nymeria.v1', time: [0, .04, .09], source_time: [30, 30.04, 30.09],
    skeleton: { joints: ['root', 'l_wrist'], edges: [['root', 'l_wrist']], positions: p.map((position) => [[0, 0, 0], position]) },
    targets: Object.fromEntries(sites.map((site) => [site, { p: structuredClone(p), q: site.startsWith('elbow') ? null : structuredClone(q), pv: [true, true, true], ov: [!site.startsWith('elbow'), !site.startsWith('elbow'), !site.startsWith('elbow')], interval_pv: [true, true], interval_ov: [!site.startsWith('elbow'), !site.startsWith('elbow')] }])),
    motionStats: { sampling: 'native timestamp intervals', units: 'm/s', left: { n: 24, mean: 1, p95: 2, max: 3 } },
    extraction: { source_sha256: 'a'.repeat(64), display_fps: 30 }, source: { sequence_id: 'synthetic', url: 'https://example.org' }, license: { id: 'CC-BY-NC-4.0', attribution: 'Synthetic fixture', url: 'https://creativecommons.org/licenses/by-nc/4.0/' } };
}
test('nonuniform native timestamp interpolation is not frame/fps indexing', () => {
  const episode = createNymeriaEpisode({ id: 'synthetic' }, fixture());
  assert.equal(episode.sample(.065).targets.left.p[0], 1.5); assert.equal(episode.sample(.065).source_t, 30.065);
  assert.equal(episode.sample(-1).t, 0); assert.equal(episode.sample(2).t, .09); assert.throws(() => episode.sample(NaN), /finite/);
});
test('Nymeria has no model, no actual robot poses and no fabricated tracking errors', () => {
  const episode = createNymeriaEpisode({ id: 'synthetic' }, fixture());
  assert.equal(episode.kind, 'nymeria'); assert.equal(episode.model, null); assert.equal(episode.videoUrl, null); assert.deepEqual(episode.sample(0).actual, {}); assert.deepEqual(episode.sample(0).taku_links, {});
  for (const frame of episode.frames) for (const error of Object.values(frame.errors)) { assert.equal(error.position_m, null); assert.equal(error.orientation_rad, null); }
  assert.equal(episode.stats.left.position, null); assert.equal(episode.motionStats.left.n, 24); assert.equal(episode.frames.length, 3); assert.equal(episode.sample(0).targets.elbow_left.q, null);
});
test('masked native intervals hidden by decimation cannot be interpolated across', () => {
  const document = fixture(); document.targets.left.interval_pv[0] = false; document.targets.left.interval_ov[0] = false;
  const episode = createNymeriaEpisode({ id: 'synthetic' }, document);
  assert.equal(episode.sample(0).targets.left.valid_position, true); assert.equal(episode.sample(.02).targets.left.valid_position, false); assert.equal(episode.sample(.02).targets.left.valid_orientation, false); assert.equal(episode.sample(.04).targets.left.valid_position, true);
  assert.equal(episode.sample(.02).raw.l_wrist.valid_position, true, 'raw numeric skeleton is not silently replaced by filtered URR');
});
test('strict schema rejects robot payloads, invalid clocks, invalid elbow pose claims and absent license', () => {
  let document = fixture(); document.robot = {}; assert.throws(() => validateNymeria(document), /schema/);
  document = fixture(); document.time[1] = 0; assert.throws(() => validateNymeria(document), /clock/);
  document = fixture(); document.source_time[1] += .2; assert.throws(() => validateNymeria(document), /clock/);
  document = fixture(); document.targets.elbow_left.ov[0] = true; assert.throws(() => validateNymeria(document), /Elbows/);
  document = fixture(); document.license.id = 'MIT'; assert.throws(() => validateNymeria(document), /license/);
});
test('packaged excerpts validate and retain source-frame semantics without robot state', () => {
  for (const record of NYMERIA_CATALOG) {
    const document = JSON.parse(fs.readFileSync(new URL(`../public/data/nymeria/${record.file}`, import.meta.url)));
    const episode = createNymeriaEpisode(record, document);
    assert.equal(episode.frames.length, document.extraction.exported_frame_count); assert.equal(episode.duration, document.time.at(-1)); assert.equal(episode.skeleton.joints.length, 23);
    assert.ok(episode.extraction.source_fps > 200); assert.equal(episode.fps, 30); assert.ok(episode.motionStats.left.n > episode.frames.length);
    assert.ok(episode.sample(0).targets.footprint.p.every((x) => Math.abs(x) < 1e-6));
    for (const frame of episode.frames) {
      assert.deepEqual(frame.targets.left.p, frame.raw.l_wrist.p); assert.deepEqual(frame.targets.right.p, frame.raw.r_wrist.p);
      assert.deepEqual(frame.targets.elbow_left.p, frame.raw.l_lowarm.p); assert.equal(frame.targets.elbow_left.q, null);
      assert.ok(Math.abs(frame.targets.chest.p[0] - (frame.raw.l_uparm.p[0] + frame.raw.r_uparm.p[0]) / 2) < 1.1e-6);
      assert.equal(frame.targets.footprint.p[2], 0); assert.ok(Math.abs(frame.targets.footprint.p[0] - frame.raw.root.p[0]) < 1.1e-6);
    }
  }
});
