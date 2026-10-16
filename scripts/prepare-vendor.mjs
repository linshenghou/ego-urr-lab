import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const three = path.join(root, 'node_modules/three');
const destination = path.join(root, 'public/draco');
await mkdir(destination, { recursive: true });
await mkdir(path.join(root, 'public/licenses'), { recursive: true });
for (const name of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
  await copyFile(path.join(three, 'examples/jsm/libs/draco/gltf', name), path.join(destination, name));
}
await copyFile(path.join(three, 'LICENSE'), path.join(root, 'public/licenses/THREE-LICENSE.txt'));
// Include the distributed decoder's own notice in addition to the Three license.
const decoder = await readFile(path.join(three, 'examples/jsm/libs/meshopt_decoder.module.js'), 'utf8');
const notice = decoder.split('\n').filter((line, i) => i < 2 && line.startsWith('//')).join('\n');
if (!notice.includes('Copyright')) throw new Error('Meshopt license notice missing');
await writeFile(path.join(root, 'public/licenses/MESHOPT-NOTICE.txt'), notice + '\n');
for (const name of ['DRACO-LICENSE.txt', 'MESHOPT-LICENSE.txt']) {
  await copyFile(path.join(root, 'licenses', name), path.join(root, 'public/licenses', name));
}
console.log('Prepared pinned renderer decoders only; no dataset or robot assets copied.');
