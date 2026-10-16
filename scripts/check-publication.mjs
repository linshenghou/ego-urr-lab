import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles = new Set([
  '.gitignore', '.github/workflows/pages.yml', 'LICENSE', 'README.md',
  'THIRD_PARTY_NOTICES.md', 'index.html', 'package.json', 'package-lock.json',
  'vite.config.js', 'licenses/DRACO-LICENSE.txt', 'licenses/MESHOPT-LICENSE.txt',
  'scripts/check-publication.mjs', 'scripts/prepare-vendor.mjs',
]);
const sourceDirectories = new Set(['.github', '.github/workflows', 'docs', 'licenses', 'scripts', 'src', 'tests']);
// Exclusions apply ONLY at the repository root, never to a matching basename.
const generatedRoots = new Set(['.git', 'node_modules', 'dist']);
const vendorInputs = new Map([
  ['draco/draco_decoder.js', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.js'],
  ['draco/draco_decoder.wasm', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm'],
  ['draco/draco_wasm_wrapper.js', 'node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js'],
  ['licenses/THREE-LICENSE.txt', 'node_modules/three/LICENSE'],
  ['licenses/DRACO-LICENSE.txt', 'licenses/DRACO-LICENSE.txt'],
  ['licenses/MESHOPT-LICENSE.txt', 'licenses/MESHOPT-LICENSE.txt'],
  ['licenses/MESHOPT-NOTICE.txt', 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'],
]);
const vendorDirectories = new Set(['draco', 'licenses']);
const patterns = [
  ['private absolute path', /\/(?:Users|home)\/[\w.-]+\//],
  ['private Windows path', /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+/i],
  // Dotted hex lookup tables in Three.js are not address tokens.
  ['private IP', /(?<![\w.])(?:10\.(?:25[0-5]|2[0-4]\d|1?\d?\d)|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9_]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/],
  ['signed download URL', /[?&](?:X-Amz-Signature|X-Goog-Signature|signature|access_token|token)=/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
function allowedSource(relative) {
  return sourceFiles.has(relative) || /^src\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(relative)
    || /^tests\/[A-Za-z0-9_.-]+\.mjs$/.test(relative) || /^docs\/[A-Za-z0-9_.-]+\.md$/.test(relative);
}
function scanText(bytes, relative, problems) {
  if (bytes.includes(0)) { problems.push(`${relative}: binary source/build file`); return; }
  const text = bytes.toString('utf8');
  for (const [reason, pattern] of patterns) if (pattern.test(text)) problems.push(`${relative}: ${reason}`);
}
async function optionalStat(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function expectedVendorBytes(root, relative) {
  const filename = path.join(root, vendorInputs.get(relative)), stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('vendor input must be a regular file');
  const bytes = await readFile(filename);
  if (relative !== 'licenses/MESHOPT-NOTICE.txt') return bytes;
  const notice = bytes.toString('utf8').split('\n').filter((line, i) => i < 2 && line.startsWith('//')).join('\n');
  if (!notice.includes('Copyright')) throw new Error('meshopt notice missing');
  return Buffer.from(notice + '\n');
}

/** Audit Vite public or final output directories without following symlinks. */
async function checkAssetTree(root, directory, { built = false } = {}) {
  const problems = [], found = new Set(); let count = 0, totalBytes = 0;
  const stat = await optionalStat(directory);
  if (!stat) return { problems: [`${path.basename(directory)}: missing directory`], count };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { problems: [`${path.basename(directory)}: must be a real directory, not a symlink`], count };
  async function walk(current, prefix = '') {
    for (const name of await readdir(current)) {
      const relative = prefix ? `${prefix}/${name}` : name, filename = path.join(current, name), info = await lstat(filename);
      const label = `${path.basename(directory)}/${relative}`;
      if (info.isSymbolicLink()) { problems.push(`${label}: symlinks are not publishable`); continue; }
      if (info.isDirectory()) {
        if (!vendorDirectories.has(relative) && !(built && relative === 'assets')) problems.push(`${label}: unexpected asset directory`);
        await walk(filename, relative); continue;
      }
      count++; totalBytes += info.size;
      if (!info.isFile()) { problems.push(`${label}: not a regular file`); continue; }
      if (vendorInputs.has(relative)) {
        found.add(relative);
        try { if (!(await readFile(filename)).equals(await expectedVendorBytes(root, relative))) problems.push(`${label}: generated vendor bytes differ from pinned input`); }
        catch (error) { problems.push(`${label}: cannot verify vendor input (${error.code ?? error.message})`); }
        continue;
      }
      const allowedBuild = built && (relative === 'index.html' || /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(relative));
      if (!allowedBuild) { problems.push(`${label}: file is outside the publication allowlist`); continue; }
      found.add(relative);
      if (info.size > 5_000_000) { problems.push(`${label}: unexpected large build file`); continue; }
      scanText(await readFile(filename), label, problems);
    }
  }
  await walk(directory);
  for (const name of vendorInputs.keys()) if (!found.has(name)) problems.push(`${path.basename(directory)}/${name}: missing generated vendor file`);
  if (built && !found.has('index.html')) problems.push('dist/index.html: missing build entry');
  if (built && ![...found].some((name) => /^assets\/.+\.js$/.test(name))) problems.push('dist/assets: missing application JavaScript');
  if (totalBytes > 20_000_000) problems.push(`${path.basename(directory)}: unexpected total asset size`);
  return { problems, count };
}

export async function checkPublication(root = projectRoot, { build = false } = {}) {
  root = path.resolve(root);
  if (build) return checkAssetTree(root, path.join(root, 'dist'), { built: true });
  const problems = []; let count = 0;
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name, filename = path.join(directory, name), stat = await lstat(filename);
      if (stat.isSymbolicLink()) { problems.push(`${relative}: symlinks are not publishable`); continue; }
      if (!prefix && generatedRoots.has(name)) {
        if (!stat.isDirectory()) problems.push(`${relative}: generated root must be a directory`);
        continue;
      }
      if (relative === 'public') {
        const result = await checkAssetTree(root, filename); problems.push(...result.problems); count += result.count; continue;
      }
      if (stat.isDirectory()) {
        if (!sourceDirectories.has(relative)) problems.push(`${relative}: unexpected source directory`);
        await walk(filename, relative); continue;
      }
      count++;
      if (!stat.isFile()) { problems.push(`${relative}: not a regular file`); continue; }
      if (!allowedSource(relative)) { problems.push(`${relative}: file is outside the publication allowlist`); continue; }
      if (stat.size > 2_000_000) { problems.push(`${relative}: unexpected large source file`); continue; }
      scanText(await readFile(filename), relative, problems);
    }
  }
  await walk(root);
  return { problems, count };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((value) => value !== '--dist')) throw new Error('Usage: node scripts/check-publication.mjs [--dist]');
  const result = await checkPublication(projectRoot, { build: args.includes('--dist') });
  if (result.problems.length) { console.error(result.problems.join('\n')); process.exitCode = 1; }
  else console.log(`Publication ${args.includes('--dist') ? 'build' : 'source'} check passed: ${result.count} files; exact path allowlist, verified vendor bytes, no detected credentials or private paths.`);
}
