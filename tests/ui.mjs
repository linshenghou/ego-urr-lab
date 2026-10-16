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

test('episode statistics do not create orientation samples for EGO data', () => {
  const result = episodeStatistics([frame(0, .01, .03), frame(1, .03, .05)]);
  assert.deepEqual(result.left.position, { n: 2, mean: 2, p95: 2.9, max: 3 });
  assert.equal(result.left.orientation, null);
  assert.equal(result.right.orientation, null);
  assert.equal(result.right.position.mean, 4);
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
