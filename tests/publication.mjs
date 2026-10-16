import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
