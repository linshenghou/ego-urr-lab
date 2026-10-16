import { readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles = new Set([
  '.gitignore', '.github/workflows/pages.yml', 'LICENSE', 'README.md',
  'THIRD_PARTY_NOTICES.md', 'index.html', 'package.json', 'package-lock.json',
  'vite.config.js', 'licenses/DRACO-LICENSE.txt', 'licenses/MESHOPT-LICENSE.txt',
  'licenses/NYMERIAPLUS-DATA-LICENSE.txt', 'scripts/nymeria-assets.json',
  'scripts/check-publication.mjs', 'scripts/prepare-vendor.mjs',
  'scripts/export-nymeria.py',
  'tests/nymeria-export.py',
  'requirements-export.txt',
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
  ['licenses/NYMERIAPLUS-DATA-LICENSE.txt', 'licenses/NYMERIAPLUS-DATA-LICENSE.txt'],
  ['licenses/MESHOPT-NOTICE.txt', 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'],
]);
const vendorDirectories = new Set(['draco', 'licenses']);
const nymeriaFiles = new Map([
  ['data/nymeria/housework-long.json', [30, 150]],
  ['data/nymeria/housework-hands.json', [562.5, 577.5]],
]);
const nymeriaDirectories = new Set(['data', 'data/nymeria']);
const nymeriaSites = ['left', 'right', 'elbow_left', 'elbow_right', 'chest', 'footprint'];
const nymeriaJoints = ['root', 'c_spine0', 'c_spine1', 'c_spine2', 'c_spine3', 'c_neck', 'c_head',
  ...['l', 'r'].flatMap((side) => ['clavicle', 'uparm', 'lowarm', 'wrist', 'upleg', 'lowleg', 'foot', 'ball'].map((name) => `${side}_${name}`))];
const nymeriaSequence = '20231222_s1_kenneth_fischer_act6_kbpn0q';
const nymeriaSourceHash = '08d7caad28d066969d023d6f1424a5b0e1daa850cd85601a49f51189a0fea653';
const nymeriaMaxFileBytes = 12_000_000, nymeriaMaxTotalBytes = 15_000_000;
const patterns = [
  ['private absolute path', /\/(?:Users|home)\/[\w.-]+\//],
  ['private Windows path', /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+/i],
  // Dotted hex lookup tables in Three.js are not address tokens.
  ['private IP', /(?<![\w.])(?:10\.(?:25[0-5]|2[0-4]\d|1?\d?\d)|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9_]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/],
  ['signed download URL', /[?&](?:X-Amz-Signature|X-Goog-Signature|signature|access_token|token)=/i],
  ['signed dataset CDN URL', /https?:\/\/[^\s"'<>]*(?:fbcdn\.net|fbsbx\.com)[^\s"'<>]*[?&](?:oh|oe|_nc_ohc)=/i],
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

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const vector = (value, size) => Array.isArray(value) && value.length === size && value.every(finite);
const bools = (value, size) => Array.isArray(value) && value.length === size && value.every((v) => typeof v === 'boolean');
const quaternion = (value) => vector(value, 4) && Math.abs(Math.hypot(...value) - 1) < 1e-4;

async function reviewedNymeriaFiles(root) {
  const filename = path.join(root, 'scripts/nymeria-assets.json'), stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid reviewed manifest file');
  const review = JSON.parse(await readFile(filename, 'utf8'));
  if (!exactKeys(review, ['schema', 'source_sha256', 'files']) || review.schema !== 'ego-urr-lab.nymeria-publication.v1'
    || review.source_sha256 !== nymeriaSourceHash || !exactKeys(review.files, [...nymeriaFiles.keys()])) throw new Error('invalid reviewed manifest schema');
  let total = 0;
  for (const entry of Object.values(review.files)) {
    if (!exactKeys(entry, ['sha256', 'bytes']) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isInteger(entry.bytes)
      || entry.bytes <= 0 || entry.bytes > nymeriaMaxFileBytes) throw new Error('invalid reviewed manifest digest/size');
    total += entry.bytes;
  }
  if (total > nymeriaMaxTotalBytes) throw new Error('reviewed numeric excerpts exceed total size limit');
  return review.files;
}

/** Narrow structural check in addition to independent, committed byte hashes. */
function validateNymeriaPayload(document, relative) {
  if (!exactKeys(document, ['schema', 'time', 'source_time', 'skeleton', 'targets', 'motionStats', 'extraction', 'source', 'license'])
    || document.schema !== 'ego-urr-lab.nymeria.v1') return 'unexpected numeric excerpt schema';
  const { source, license, extraction, skeleton, targets, time, source_time: sourceTime, motionStats } = document;
  if (!exactKeys(source, ['dataset', 'release', 'sequence_id', 'sequence_url', 'kind', 'url', 'requested_start_s', 'requested_duration_s'])
    || source.dataset !== 'NymeriaPlus' || source.sequence_id !== nymeriaSequence
    || source.release !== 'v1.0' || source.sequence_url !== `https://explorer.projectaria.com/nymeria_plus/${nymeriaSequence}`
    || source.url !== 'https://github.com/facebookresearch/nymeria_dataset') return 'unreviewed source metadata';
  if (!exactKeys(license, ['id', 'url', 'source_url', 'attribution', 'copyright', 'notice', 'changes']) || license.id !== 'CC-BY-NC-4.0'
    || license.url !== 'https://creativecommons.org/licenses/by-nc/4.0/'
    || license.source_url !== 'https://github.com/facebookresearch/nymeria_dataset/blob/main/NYMERIAPLUS_DATASET_LICENSE'
    || license.attribution !== 'NymeriaPlus Dataset, Meta Platforms, Inc. and affiliates'
    || license.copyright !== 'Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.'
    || !license.notice?.includes('AS-IS') || !license.changes?.includes('FK')) return 'missing required data license/attribution/change notice';
  const [start, end] = nymeriaFiles.get(relative);
  if (source.requested_start_s !== start || source.requested_duration_s !== end - start) return 'unreviewed source interval';
  const n = time?.length;
  if (!Array.isArray(time) || n < 2 || n > 5000 || time[0] !== 0 || !time.every(finite)
    || !Array.isArray(sourceTime) || sourceTime.length !== n || !sourceTime.every(finite)
    || sourceTime[0] < start - 1e-6 || sourceTime[n - 1] > end + 1e-6
    || time.some((t, i) => (i > 0 && t <= time[i - 1]) || Math.abs(t - sourceTime[i] + sourceTime[0]) > 3e-6)) return 'invalid numeric excerpt timeline';
  if (!exactKeys(skeleton, ['joints', 'edges', 'positions']) || JSON.stringify(skeleton.joints) !== JSON.stringify(nymeriaJoints)
    || !Array.isArray(skeleton.edges) || skeleton.edges.length !== nymeriaJoints.length - 1
    || !skeleton.edges.every((edge) => Array.isArray(edge) && edge.length === 2 && edge[0] !== edge[1] && edge.every((name) => nymeriaJoints.includes(name)))
    || !Array.isArray(skeleton.positions) || skeleton.positions.length !== n
    || !skeleton.positions.every((row) => Array.isArray(row) && row.length === nymeriaJoints.length && row.every((p) => vector(p, 3)))) return 'invalid reduced numeric skeleton';
  if (!exactKeys(targets, nymeriaSites)) return 'unexpected target fields';
  for (const site of nymeriaSites) {
    const target = targets[site], elbow = site.startsWith('elbow');
    if (!exactKeys(target, ['p', 'q', 'pv', 'ov', 'interval_pv', 'interval_ov']) || !Array.isArray(target.p) || target.p.length !== n
      || !target.p.every((p) => vector(p, 3)) || !bools(target.pv, n) || !bools(target.ov, n)
      || !bools(target.interval_pv, n - 1) || !bools(target.interval_ov, n - 1)) return 'invalid numeric target/validity arrays';
    if (elbow ? target.q !== null || target.ov.some(Boolean) || target.interval_ov.some(Boolean)
      : !Array.isArray(target.q) || target.q.length !== n || !target.q.every(quaternion)) return 'invalid target orientation semantics';
    if (target.ov.some((v, i) => v && !target.pv[i])
      || target.interval_pv.some((v, i) => v && (!target.pv[i] || !target.pv[i + 1]))
      || target.interval_ov.some((v, i) => v && (!target.ov[i] || !target.ov[i + 1]))) return 'inconsistent target validity';
  }
  if (!exactKeys(extraction, ['anatomy', 'chest', 'footprint', 'coordinate_frame', 'alignment', 'source_fps', 'display_fps', 'native_frame_count',
    'exported_frame_count', 'source_frame_start', 'source_frame_end', 'actual_start_s', 'actual_end_s', 'native_dt_min_s', 'native_dt_max_s',
    'display_selection', 'continuity_filter', 'confidence', 'robot_retarget', 'raw_rotation', 'source_sha256'])
    || extraction.source_sha256 !== nymeriaSourceHash || extraction.exported_frame_count !== n
    || !exactKeys(extraction.anatomy, ['left', 'right', 'elbow_left', 'elbow_right', 'shoulder_left', 'shoulder_right', 'hip'])
    || !Object.values(extraction.anatomy).every((name) => nymeriaJoints.includes(name))
    || !exactKeys(extraction.footprint, ['position', 'heading', 'axis', 'sign', 'calibration_source_frame'])
    || ![0, 1, 2].includes(extraction.footprint.axis) || ![-1, 1].includes(extraction.footprint.sign)
    || !Array.isArray(extraction.alignment) || extraction.alignment.length !== 4 || !extraction.alignment.every((row) => vector(row, 4))
    || !exactKeys(extraction.continuity_filter, nymeriaSites)) return 'invalid extraction provenance';
  for (const site of nymeriaSites) {
    const filter = extraction.continuity_filter[site];
    if (!exactKeys(filter, ['position_threshold_m_s', 'angular_threshold_rad_s', 'position_flagged_frames', 'orientation_flagged_frames'])
      || !Object.values(filter).every(finite)) return 'invalid continuity filter metadata';
  }
  if (!exactKeys(motionStats, ['sampling', 'units', 'left', 'right', 'chest', 'footprint']) || motionStats.units !== 'm/s') return 'invalid motion statistics metadata';
  for (const site of ['left', 'right', 'chest', 'footprint']) {
    const stats = motionStats[site];
    if (stats !== null && (!exactKeys(stats, ['n', 'mean', 'p95', 'max']) || !Object.values(stats).every(finite))) return 'invalid native motion statistics';
  }
  return null;
}

/** Audit Vite public or final output directories without following symlinks. */
async function checkAssetTree(root, directory, { built = false } = {}) {
  const problems = [], found = new Set(); let count = 0, totalBytes = 0, nymeriaBytes = 0, review;
  const stat = await optionalStat(directory);
  if (!stat) return { problems: [`${path.basename(directory)}: missing directory`], count };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { problems: [`${path.basename(directory)}: must be a real directory, not a symlink`], count };
  async function walk(current, prefix = '') {
    for (const name of await readdir(current)) {
      const relative = prefix ? `${prefix}/${name}` : name, filename = path.join(current, name), info = await lstat(filename);
      const label = `${path.basename(directory)}/${relative}`;
      if (info.isSymbolicLink()) { problems.push(`${label}: symlinks are not publishable`); continue; }
      if (info.isDirectory()) {
        if (!vendorDirectories.has(relative) && !nymeriaDirectories.has(relative) && !(built && relative === 'assets')) problems.push(`${label}: unexpected asset directory`);
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
      if (nymeriaFiles.has(relative)) {
        found.add(relative); nymeriaBytes += info.size;
        if (info.size > nymeriaMaxFileBytes) { problems.push(`${label}: numeric excerpt exceeds size limit`); continue; }
        const bytes = await readFile(filename); scanText(bytes, label, problems);
        try {
          review ??= await reviewedNymeriaFiles(root);
          const expected = review[relative];
          if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) problems.push(`${label}: numeric excerpt differs from reviewed hash/size`);
          const reason = validateNymeriaPayload(JSON.parse(bytes.toString('utf8')), relative);
          if (reason) problems.push(`${label}: ${reason}`);
        } catch (error) { problems.push(`${label}: cannot verify numeric excerpt (${error instanceof SyntaxError ? 'invalid JSON' : error.code ?? error.message})`); }
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
  if ([...nymeriaFiles.keys()].some((name) => found.has(name)) || await optionalStat(path.join(root, 'scripts/nymeria-assets.json'))) {
    for (const name of nymeriaFiles.keys()) if (!found.has(name)) problems.push(`${path.basename(directory)}/${name}: missing reviewed numeric excerpt`);
  }
  if (nymeriaBytes > nymeriaMaxTotalBytes) problems.push(`${path.basename(directory)}: numeric excerpts exceed total size limit`);
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
      if (relative === 'scripts/nymeria-assets.json') {
        try { await reviewedNymeriaFiles(root); }
        catch (error) { problems.push(`${relative}: invalid reviewed numeric manifest (${error instanceof SyntaxError ? 'invalid JSON' : error.code ?? error.message})`); }
      }
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
