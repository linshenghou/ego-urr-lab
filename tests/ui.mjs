import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { frameError, summarize, episodeStatistics, errorSegments, withDerivedOrientation } from '../src/charts.js';

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

test('episode statistics do not create orientation samples for EGO data', () => {
  const result = episodeStatistics([frame(0, .01, .03), frame(1, .03, .05)]);
  assert.deepEqual(result.left.position, { n: 2, mean: 2, p95: 2.9, max: 3 });
  assert.equal(result.left.orientation, null);
  assert.equal(result.right.orientation, null);
  assert.equal(result.right.position.mean, 4);
});

test('FK-derived rotation is opt-in and never replaces direct position or mutates source errors', () => {
  const original = frame(0, .02, .03);
  original.derived_errors = { left: { position_m: 999, orientation_rad: Math.PI / 6 }, right: { position_m: 999, orientation_rad: Math.PI / 3 } };
  assert.equal(withDerivedOrientation(original, false), original);
  const derived = withDerivedOrientation(original, true);
  assert.equal(frameError(derived, 'left'), 2);
  assert.equal(frameError(derived, 'right'), 3);
  assert.ok(Math.abs(frameError(derived, 'left', 'orientation') - 30) < 1e-10);
  assert.equal(original.errors.left.orientation_rad, null);
  assert.equal(frameError(withDerivedOrientation(frame(1, .02, .03), true), 'left', 'orientation'), null);
});

test('curves break at missing samples rather than visually interpolating across gaps', () => {
  const frames = [frame(0, .01, .01), frame(1, null, .01), frame(2, .03, .01), frame(3, .04, .01)];
  assert.deepEqual(errorSegments(frames, 'left', 'position'), [[[0, 1]], [[2, 3], [3, 4]]]);
  assert.deepEqual(errorSegments(frames, 'left', 'orientation'), []);
});

test('public interface includes accessible playback, layers, source notes, and precise semantics', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['timeline', 'play-pause', 'playback-speed', 'layer-solid', 'layer-targets', 'layer-skeleton', 'layer-errors', 'target-opacity', 'provenance-content', 'load-error']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-label="Replay time|for="timeline"/);
  assert.match(html, /Unavailable in EGO/);
  assert.match(html, /EGO 没有公开胸部 command/);
  assert.doesNotMatch(html, /autoplay|OUR PROXY|PokeBot/i);
  assert.match(html, /Not affiliated with or endorsed by DYNA/);
});

test('one clock uses explicit source video timestamp and exposes no phantom source', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /frame\?\.video_time_s/);
  assert.match(app, /\(episode\?\.start \?\? 0\) \+ currentTime/);
  assert.match(app, /No paired EGO video/);
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

test('Nymeria UI separates extraction and source speed from robot tracking performance', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="mode-nymeria"/);
  assert.match(html, /id="extraction"/);
  assert.match(html, /No solved Taku trajectory/);
  assert.match(html, /Source motion speed · m\/s/);
  assert.match(html, /CC BY-NC 4\.0/);
  assert.match(app, /\$\('layer-solid'\)\.disabled = human/);
  assert.match(app, /\$\('analysis'\)\.hidden = human/);
  assert.match(app, /anatomy\.hip \?\? 'root'/);
  assert.match(html, /物理速度帽与数值信赖域不同/);
  assert.match(html, /非因果离线估计/);
  assert.match(html, /no_velocity/);
  assert.match(html, /position_only/);
});

test('all direct app element references exist and derived orientation defaults off', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const match of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), `Missing UI element ${match[1]}`);
  assert.match(html, /id="derived-orientation" type="checkbox" \/>/);
  assert.match(html, /位置误差仍保持原始 achieved xyz/);
});
