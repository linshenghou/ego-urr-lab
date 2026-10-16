import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { frameError, summarize, episodeStatistics, errorSegments } from '../src/charts.js';

// Small synthetic fixtures test arithmetic only; they are never bundled as site data.
const frame = (t, leftPosition, rightPosition, leftRotation = null, rightRotation = null) => ({
  t, errors: {
    left: { position_m: leftPosition, orientation_rad: leftRotation },
    right: { position_m: rightPosition, orientation_rad: rightRotation },
  },
});

test('error units are explicit and invalid/missing values are not zero', () => {
  assert.equal(frameError(frame(0, .023, .05), 'left'), 2.3);
  assert.equal(frameError(frame(0, 0, 0, Math.PI / 2), 'left', 'orientation'), 90);
  for (const invalid of [null, undefined, NaN, Infinity, -1, '0']) assert.equal(frameError(frame(0, invalid, 0), 'left'), null);
  assert.equal(frameError(frame(0, 0, 0), 'right', 'orientation'), null);
  assert.equal(frameError(frame(0, 0, 0, 0), 'left', 'orientation'), 0);
});

test('summary uses valid original samples and linear P95', () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 5, null, NaN]), { n: 5, mean: 3, p95: 4.8, max: 5 });
  assert.equal(summarize([null, undefined, NaN]), null);
  assert.deepEqual(summarize([0, 0]), { n: 2, mean: 0, p95: 0, max: 0 });
});

test('episode statistics do not fabricate missing orientation samples', () => {
  const result = episodeStatistics([frame(0, .01, .03), frame(1, .03, .05)]);
  assert.deepEqual(result.left.position, { n: 2, mean: 2, p95: 2.9, max: 3 });
  assert.equal(result.left.orientation, null);
  assert.equal(result.right.orientation, null);
  assert.equal(result.right.position.mean, 4);
});

test('six-site statistics retain solved chest errors and elbow position-only semantics', () => {
  const sample = frame(0, .02, .03, Math.PI / 6, Math.PI / 3);
  sample.errors.chest = { position_m: .04, orientation_rad: Math.PI / 4 };
  sample.errors.elbow_left = { position_m: .05, orientation_rad: null };
  const result = episodeStatistics([sample], ['left', 'right', 'chest', 'elbow_left']);
  assert.equal(result.chest.position.mean, 4);
  assert.equal(result.chest.orientation.mean, 45);
  assert.equal(result.elbow_left.position.mean, 5);
  assert.equal(result.elbow_left.orientation, null);
});

test('curves break at missing samples rather than visually interpolating across gaps', () => {
  const frames = [frame(0, .01, .01), frame(1, null, .01), frame(2, .03, .01), frame(3, .04, .01)];
  assert.deepEqual(errorSegments(frames, 'left', 'position'), [[[0, 1]], [[2, 3], [3, 4]]]);
  assert.deepEqual(errorSegments(frames, 'left', 'orientation'), []);
});

test('Nymeria-only interface retains accessible independent robot and target layers', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['timeline', 'play-pause', 'playback-speed', 'layer-solid', 'layer-targets', 'layer-errors', 'target-opacity', 'raw-skeleton-canvas', 'provenance-content', 'load-error']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-label="Replay time|for="timeline"/);
  assert.match(html, /NymeriaPlus → URR → Taku/);
  assert.doesNotMatch(html, /autoplay|PokeBot|Box Kitting|Wipe Metal Shelves|Restock Shelves|derived-orientation|ego-video|data-mode=/i);
  assert.match(html, /Not affiliated with or endorsed by Meta or DYNA/);
});

test('one clock feeds both views without adding source videos or demonstration modes', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /CATALOG\.filter\(\(item\) => item\.kind === 'nymeria'\)/);
  assert.match(app, /rawContainer: \$\('raw-skeleton-canvas'\)/);
  assert.match(app, /frame\.source_t/);
  assert.doesNotMatch(app, /videoUrl|activeMode|derivedEnabled/);
  assert.match(app, /document\.hidden\) setPlaybackState\(false\)/);
  assert.match(app, /controller\?\.abort\(\)/);
  assert.match(app, /linshenghou\/ego-urr-lab/);
});

test('paper theme supports reduced motion and mobile layout without remote fonts', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /max-width:640px/);
  assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /fonts\.google|@import.*https/);
});

test('source inspection never substitutes mapped targets for original human URR', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="extraction"/);
  assert.match(html, /Human source speed · m\/s/);
  assert.match(html, /CC BY-NC 4\.0/);
  assert.match(app, /const source = frame\.source_targets \?\? \{\}/);
  assert.match(app, /Source-only targets are not displayed as a robot solution/);
  assert.match(app, /anatomy\.hip \?\? 'root'/);
  assert.match(html, /实验边界不能宣称符合 Taku 真机能力/);
  assert.match(html, /Gauss–Newton/);
  assert.match(html, /非因果离线估计/);
  assert.match(html, /Velocity feedforward<\/th><td>未实现/);
  assert.match(html, /Per-frame jump guard/);
  assert.match(html, /限制等效播放速度/);
  assert.match(html, /逐帧边界不按 dt 缩放/);
  assert.match(html, /0\.50 m 时选垂臂/);
  assert.match(app, /Retarget mapping \/ home selection/);
  assert.doesNotMatch(html, /Uncapped is not unchecked|未施加执行速度/);
});

test('all direct app element references exist and source/target/FK inspections stay separate', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const match of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), `Missing UI element ${match[1]}`);
  for (const id of ['inspect-source', 'inspect-target', 'inspect-actual', 'inspect-error']) assert.ok(ids.has(id));
  assert.match(html, /Full original notice/);
});
