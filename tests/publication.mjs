import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkPublication } from '../scripts/check-publication.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ego-urr-publication-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'package.json', '{}\n');
  await put(root, 'src/app.js', 'export const greeting = "research";\n');
  await put(root, 'src/tokens.css', ':root { --color: white; }\n');
  await put(root, 'tests/example.mjs', '// Synthetic test fixture\n');
  return root;
}
async function put(root, relative, bytes) {
  const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); return filename;
}
async function vendor(root, destination = 'public') {
  const inputs = [
    ['draco/draco_decoder.js', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.js', '// pinned Draco JS\n'],
    ['draco/draco_decoder.wasm', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm', Buffer.from([0, 97, 115, 109])],
    ['draco/draco_wasm_wrapper.js', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js', '// pinned wrapper\n'],
    ['licenses/THREE-LICENSE.txt', 'node_modules/three/LICENSE', 'MIT: Three authors\n'],
    ['licenses/DRACO-LICENSE.txt', 'licenses/DRACO-LICENSE.txt', 'Apache-2.0 Draco license\n'],
    ['licenses/MESHOPT-LICENSE.txt', 'licenses/MESHOPT-LICENSE.txt', 'MIT: meshoptimizer authors\n'],
    ['licenses/NYMERIAPLUS-DATA-LICENSE.txt', 'licenses/NYMERIAPLUS-DATA-LICENSE.txt', 'NymeriaPlus non-audio: CC BY-NC 4.0\n'],
  ];
  for (const [output, input, bytes] of inputs) {
    const source = await put(root, input, bytes); const target = path.join(root, destination, output);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target);
  }
  const notice = '// MIT License\n// Copyright example authors\n';
  await put(root, 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js', notice + 'export const decoder = {};\n');
  await put(root, `${destination}/licenses/MESHOPT-NOTICE.txt`, notice);
}
function rejects(result, reason = /allowlist|unexpected/) { assert.ok(result.problems.some((problem) => reason.test(problem)), result.problems.join('\n')); }

async function nymeria(root, destination = 'public', mutate = () => {}) {
  const sourceHash = '08d7caad28d066969d023d6f1424a5b0e1daa850cd85601a49f51189a0fea653';
  const joints = ['root', 'c_spine0', 'c_spine1', 'c_spine2', 'c_spine3', 'c_neck', 'c_head',
    ...['l', 'r'].flatMap((side) => ['clavicle', 'uparm', 'lowarm', 'wrist', 'upleg', 'lowleg', 'foot', 'ball'].map((name) => `${side}_${name}`))];
  const sites = ['left', 'right', 'elbow_left', 'elbow_right', 'chest', 'footprint'];
  const sequence = '20231222_s1_kenneth_fischer_act6_kbpn0q';
  const review = { schema: 'ego-urr-lab.nymeria-publication.v1', source_sha256: sourceHash, files: {} };
  for (const [name, start, duration] of [['housework-long', 30, 120], ['housework-hands', 562.5, 15]]) {
    const document = {
      schema: 'ego-urr-lab.nymeria.v1', time: [0, 1], source_time: [start, start + 1],
      skeleton: { joints, edges: joints.slice(1).map((joint) => ['root', joint]), positions: [joints.map(() => [0, 0, 1]), joints.map(() => [0, 0, 1])] },
      targets: Object.fromEntries(sites.map((site) => [site, { p: [[0, 0, 1], [0, 0, 1]], q: site.startsWith('elbow') ? null : [[0, 0, 0, 1], [0, 0, 0, 1]],
        pv: [true, true], ov: [!site.startsWith('elbow'), !site.startsWith('elbow')], interval_pv: [true], interval_ov: [!site.startsWith('elbow')] }])),
      source: { dataset: 'NymeriaPlus', release: 'v1.0', sequence_id: sequence, sequence_url: `https://explorer.projectaria.com/nymeria_plus/${sequence}`,
        kind: 'Optimized MHR human-body estimate', url: 'https://github.com/facebookresearch/nymeria_dataset', requested_start_s: start, requested_duration_s: duration },
      license: { id: 'CC-BY-NC-4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/', source_url: 'https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE',
        attribution: 'NymeriaPlus Dataset, Meta Platforms, Inc. and affiliates', copyright: 'Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.', notice: 'AS-IS', changes: 'FK' },
      motionStats: { sampling: 'Native samples', units: 'm/s', ...Object.fromEntries(['left', 'right', 'chest', 'footprint'].map((site) => [site, { n: 1, mean: 0, p95: 0, max: 0 }])) },
      extraction: {
        anatomy: { left: 'l_wrist', right: 'r_wrist', elbow_left: 'l_lowarm', elbow_right: 'r_lowarm', shoulder_left: 'l_uparm', shoulder_right: 'r_uparm', hip: 'root' },
        chest: 'Shoulder midpoint proxy', footprint: { position: 'Pelvis projection', heading: 'Fixed signed local axis', axis: 0, sign: 1, calibration_source_frame: 0 },
        coordinate_frame: 'Z-up', alignment: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], source_fps: 240, display_fps: 30, native_frame_count: 240, exported_frame_count: 2,
        source_frame_start: 0, source_frame_end: 240, actual_start_s: start, actual_end_s: start + 1, native_dt_min_s: 1 / 240, native_dt_max_s: 1 / 240, display_selection: 'Decimated',
        continuity_filter: Object.fromEntries(sites.map((site) => [site, { position_threshold_m_s: site.startsWith('elbow') || ['left', 'right'].includes(site) ? 4 : 2.5,
          angular_threshold_rad_s: 20, position_flagged_frames: 0, orientation_flagged_frames: 0 }])), confidence: 'Not supplied', robot_retarget: 'Not performed', raw_rotation: 'Positions only', source_sha256: sourceHash,
      },
    };
    mutate(document);
    const relative = `data/nymeria/${name}.json`, bytes = Buffer.from(JSON.stringify(document) + '\n');
    await put(root, `${destination}/${relative}`, bytes);
    review.files[relative] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  await put(root, 'scripts/nymeria-assets.json', JSON.stringify(review) + '\n');
}

test('authored source and exact generated vendor files are publishable', async (t) => {
  const root = await fixture(t); assert.deepEqual((await checkPublication(root)).problems, []);
  await vendor(root); assert.deepEqual((await checkPublication(root)).problems, []);
});
test('public rejects arbitrary JSON, media, images and symlinks despite gitignore', async (t) => {
  for (const filename of ['robot.json', 'ego.mp4', 'camera.jpg', 'model.urdf']) {
    const root = await fixture(t); await vendor(root); await put(root, `public/${filename}`, '{}');
    rejects(await checkPublication(root));
  }
  const root = await fixture(t); await vendor(root); await symlink(path.join(root, 'src/app.js'), path.join(root, 'public/private.js'));
  rejects(await checkPublication(root), /symlink/);
});
test('vendor bytes must exactly match pinned dependencies and committed licenses', async (t) => {
  const root = await fixture(t); await vendor(root);
  await put(root, 'public/draco/draco_decoder.js', '// modified or unrelated bytes\n');
  rejects(await checkPublication(root), /vendor bytes differ/);
  await put(root, 'public/licenses/THREE-LICENSE.txt', 'changed notice');
  const result = await checkPublication(root); assert.equal(result.problems.filter((problem) => /vendor bytes differ/.test(problem)).length, 2);
});
test('source allowlist blocks payload files and nested generated-directory names', async (t) => {
  for (const filename of ['src/robot.json', 'src/camera.png', 'model.stl', 'src/public/ego.mp4', 'src/node_modules/robot.json', 'qa/private.txt', 'local-data/recording.json']) {
    const root = await fixture(t); await put(root, filename, 'private payload'); rejects(await checkPublication(root));
  }
});
test('root generated directory symlinks are rejected before any exclusions', async (t) => {
  const root = await fixture(t); await symlink(path.join(root, 'src'), path.join(root, 'node_modules'));
  rejects(await checkPublication(root), /symlink/);
});
test('source secrets and private paths are scanned without logging their values', async (t) => {
  const values = [
    ['/', 'Users', '/someone/file'].join(''),
    ['172', '20', '1', '2'].join('.'),
    ['ghp_', 'a'.repeat(30)].join(''),
    ['https://example.invalid/file?X-Amz-', 'Signature=', 'secret'].join(''),
    ['https://sample.', 'fbcdn.net/data?', 'oh=', 'secret'].join(''),
    ['C:', String.fromCharCode(92), 'Users', String.fromCharCode(92), 'someone'].join(''),
  ];
  for (const value of values) {
    const root = await fixture(t); await put(root, 'src/app.js', `export const value = ${JSON.stringify(value)};`);
    const result = await checkPublication(root); assert.ok(result.problems.length > 0); assert.ok(!result.problems.join('\n').includes(value));
  }
});
test('dist requires a complete built entry and validates only Vite outputs plus exact vendor', async (t) => {
  const root = await fixture(t); await vendor(root, 'dist');
  rejects(await checkPublication(root, { build: true }), /missing build entry/);
  await put(root, 'dist/index.html', '<script type="module" src="./assets/index-abcdefgh.js"></script>');
  await put(root, 'dist/assets/index-abcdefgh.js', 'console.log("independent research")');
  await put(root, 'dist/assets/index-abcdefgh.css', 'body { color: black; }');
  assert.deepEqual((await checkPublication(root, { build: true })).problems, []);
  for (const filename of ['raw.json', 'assets/camera.png', 'assets/ego.mp4', 'assets/model.glb', 'assets/index-abcdefgh.js.map']) {
    await put(root, `dist/${filename}`, '{}'); rejects(await checkPublication(root, { build: true }));
  }
});
test('built JavaScript is scanned for secrets, while verified WASM is permitted', async (t) => {
  const root = await fixture(t); await vendor(root, 'dist');
  await put(root, 'dist/index.html', '<html></html>');
  await put(root, 'dist/assets/index-abcdefgh.js', `const key = "${['github_pat_', 'b'.repeat(30)].join('')}";`);
  rejects(await checkPublication(root, { build: true }), /GitHub credential/);
});
test('bundled dotted hexadecimal lookup table is not a private IP address', async (t) => {
  const root = await fixture(t); await vendor(root, 'dist');
  await put(root, 'dist/index.html', '<html></html>');
  const table = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).join('.');
  await put(root, 'dist/assets/index-abcdefgh.js', `const table = "${table}";`);
  assert.deepEqual((await checkPublication(root, { build: true })).problems, []);
  await put(root, 'dist/assets/index-abcdefgh.js', `const endpoint = "https://${['10', '20', '1', '2'].join('.')}/private";`);
  rejects(await checkPublication(root, { build: true }), /private IP/);
});
test('dist and public symlinks never bypass byte validation', async (t) => {
  const root = await fixture(t); await vendor(root, 'dist');
  await symlink(path.join(root, 'src/app.js'), path.join(root, 'dist/symlink.js'));
  rejects(await checkPublication(root, { build: true }), /symlink/);
  const root2 = await fixture(t); await symlink(path.join(root2, 'src'), path.join(root2, 'public'));
  rejects(await checkPublication(root2), /symlink/);
});

test('only two reviewed numeric Nymeria excerpts pass source and built guards', async (t) => {
  const root = await fixture(t); await vendor(root); await nymeria(root);
  assert.deepEqual((await checkPublication(root)).problems, []);
  await vendor(root, 'dist'); await nymeria(root, 'dist');
  await put(root, 'dist/index.html', '<html></html>'); await put(root, 'dist/assets/index-abcdefgh.js', 'export const ready = true;');
  assert.deepEqual((await checkPublication(root, { build: true })).problems, []);
  await put(root, 'public/data/nymeria/unreviewed.json', '{}'); rejects(await checkPublication(root));
});
test('reviewed numeric paths require pinned bytes, both excerpts and a regular manifest', async (t) => {
  const root = await fixture(t); await vendor(root); await nymeria(root);
  await put(root, 'public/data/nymeria/housework-long.json', '{}'); rejects(await checkPublication(root), /reviewed hash/);
  await rm(path.join(root, 'public/data/nymeria/housework-hands.json')); rejects(await checkPublication(root), /missing reviewed/);
  await rm(path.join(root, 'scripts/nymeria-assets.json'));
  await symlink(path.join(root, 'package.json'), path.join(root, 'scripts/nymeria-assets.json'));
  rejects(await checkPublication(root), /symlink|reviewed manifest/);
});
test('even hash-pinned excerpts reject wrong license, private fields and invalid semantics', async (t) => {
  const mutations = [
    (doc) => { doc.license.id = 'MIT'; },
    (doc) => { doc.source.demographics = { age: 30 }; },
    (doc) => { doc.robot = { joints: [] }; },
    (doc) => { doc.targets.elbow_left.q = [[0, 0, 0, 1], [0, 0, 0, 1]]; },
    (doc) => { doc.targets.left.q[0] = [1, 2, 3, 4]; },
    (doc) => { doc.targets.left.pv[0] = false; },
    (doc) => { doc.skeleton.positions[0][0][0] = 'private'; },
    (doc) => { doc.source_time[0] = 0; },
    (doc) => { doc.extraction.chest = ['/', 'Users', '/someone/data'].join(''); },
  ];
  for (const mutate of mutations) {
    const root = await fixture(t); await vendor(root); await nymeria(root, 'public', mutate);
    const result = await checkPublication(root); assert.ok(result.problems.length > 0, 'modified schema must be rejected');
  }
});
test('Nymeria directories still reject media, extra data and symlink payloads', async (t) => {
  for (const name of ['camera.mp4', 'image.png', 'audio.wav', 'body.glb', 'extra.json']) {
    const root = await fixture(t); await vendor(root); await nymeria(root); await put(root, `public/data/nymeria/${name}`, '{}');
    rejects(await checkPublication(root));
  }
  const root = await fixture(t); await vendor(root); await nymeria(root);
  await rm(path.join(root, 'public/data/nymeria/housework-long.json'));
  await symlink(path.join(root, 'package.json'), path.join(root, 'public/data/nymeria/housework-long.json'));
  rejects(await checkPublication(root), /symlink/);
  await rm(path.join(root, 'public/data/nymeria/housework-long.json'));
  await put(root, 'public/data/nymeria/housework-long.json', Buffer.alloc(12_000_001, 32));
  rejects(await checkPublication(root), /size limit/);
});
test('review manifest is narrow metadata, never an arbitrary JSON escape hatch', async (t) => {
  const root = await fixture(t); await vendor(root); await nymeria(root);
  await put(root, 'scripts/nymeria-assets.json', JSON.stringify({ payload: ['not a review manifest'] }));
  rejects(await checkPublication(root), /reviewed.*manifest/);
});
