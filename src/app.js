import './styles.css';
import { CATALOG, loadEpisode } from './data.js';
import { createScene } from './scene.js';
import { createErrorChart, episodeStatistics, frameError, ERROR_METRICS } from './charts.js';

const $ = (id) => document.getElementById(id);
const EXCERPTS = CATALOG.filter((item) => item.kind === 'nymeria');
const repository = import.meta.env.VITE_REPOSITORY_URL || 'https://github.com/linshenghou/ego-urr-lab';
for (const link of document.querySelectorAll('.repository-link')) { link.href = repository; link.target = '_blank'; link.rel = 'noreferrer'; }
const REFERENCES = {
  left: { label: 'Left wrist / EE', joint: 'l_wrist', description: '人体源为解剖手腕位姿；映射目标对应机器人末端参考系，不是直接复制人体腕点的绝对坐标。' },
  right: { label: 'Right wrist / EE', joint: 'r_wrist', description: '人体源为解剖手腕位姿；映射目标对应机器人末端参考系，不是直接复制人体腕点的绝对坐标。' },
  elbow_left: { label: 'Left elbow', joint: 'l_lowarm', description: '人体前臂根节点原点，只作为位置目标。半透明肘 mesh 的显示朝向由肘到腕方向推算，不是肘部姿态标签。' },
  elbow_right: { label: 'Right elbow', joint: 'r_lowarm', description: '人体前臂根节点原点，只作为位置目标。半透明肘 mesh 的显示朝向由肘到腕方向推算，不是肘部姿态标签。' },
  chest: { label: 'Chest', joint: 'l_uparm + r_uparm + root', description: '人体胸部代理是两肩中点，机器人胸部参考是 torso_body_link。相对首帧映射改变初始高度；比较 mapped target 与 FK 才是跟踪误差。' },
  footprint: { label: 'Footprint', joint: 'root → xy plane', description: '人体源为骨盆投影与水平朝向代理，再映射到机器人底盘。右图 Aria 世界 z=0 不是独立测得的地面。' },
};
const SITES = Object.keys(REFERENCES);
const validPosition = (pose) => pose?.valid_position !== false && pose?.p?.length === 3 && pose.p.every(Number.isFinite);
const validRotation = (pose) => pose?.valid_orientation !== false && pose?.q?.length === 4 && pose.q.every(Number.isFinite);
const formatted = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const xyz = (pose) => validPosition(pose) ? pose.p.map((value) => value.toFixed(4)).join(' · ') : 'Unavailable';
const extractionCells = new Map();
let episode = null, currentTime = 0, playing = false, speed = 1, previousTick = 0, lastPaint = 0;
let activeId = EXCERPTS[0]?.id, requestId = 0, controller = null, movingSlider = false;
let scene = null, sceneFailure = '';
const sceneNotice = document.createElement('p'); sceneNotice.className = 'scene-status'; sceneNotice.setAttribute('role', 'status');
try { scene = createScene($('scene'), { rawContainer: $('raw-skeleton-canvas') }); }
catch (error) { sceneFailure = `3D preview unavailable: ${error.message}`; }
$('scene').append(sceneNotice);
const charts = {
  position: createErrorChart($('position-chart'), { metric: 'position', onSeek: seek }),
  orientation: createErrorChart($('orientation-chart'), { metric: 'orientation', onSeek: seek }),
};

function setLoading(message) { $('load-status').hidden = false; $('load-message').textContent = message; }
function setPlaybackState(next) {
  playing = Boolean(next && episode); previousTick = performance.now();
  $('play-icon').textContent = playing ? 'Ⅱ' : '▶'; $('play-label').textContent = playing ? 'Pause' : 'Play';
  $('play-pause').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
}
function update(time) {
  if (!episode) return;
  currentTime = Math.max(0, Math.min(episode.duration, time));
  const frame = episode.sample(currentTime); scene?.update(frame);
  if (!movingSlider) $('timeline').value = currentTime;
  $('timeline').setAttribute('aria-valuetext', `${currentTime.toFixed(1)} of ${episode.duration.toFixed(1)} seconds`);
  $('current-time').textContent = `${currentTime.toFixed(1)} s`;
  $('source-time').textContent = `${formatted(frame.source_t ?? episode.start + currentTime, 3)} s`;
  const left = frameError(frame, 'left'), right = frameError(frame, 'right'), available = [left, right].filter((value) => value !== null);
  $('current-error').textContent = formatted(available.length ? Math.max(...available) : null);
  $('current-left').textContent = left === null ? '—' : `${formatted(left)} cm`;
  $('current-right').textContent = right === null ? '—' : `${formatted(right)} cm`;
  for (const chart of Object.values(charts)) chart.update(currentTime, frame);
  renderInspection(frame);
}
function seek(time) { if (episode) { update(time); previousTick = performance.now(); } }
function resetMeasurements() {
  for (const id of ['current-error', 'current-left', 'current-right', 'inspect-source', 'inspect-target', 'inspect-actual', 'inspect-quaternion', 'inspect-error']) $(id).textContent = '—';
  $('sample-count').textContent = 'Waiting for an IK result'; $('statistics-body').replaceChildren();
  $('extraction-body').replaceChildren(); extractionCells.clear(); $('motion-statistics-body').replaceChildren();
  $('current-time').textContent = '0.0 s'; $('duration-label').textContent = '—'; $('source-time').textContent = '—';
  for (const chart of Object.values(charts)) chart.setEpisode(null);
}
function renderStatistics(next) {
  const stats = episodeStatistics(next.frames, SITES); $('statistics-body').replaceChildren();
  for (const [metric, definition] of Object.entries(ERROR_METRICS)) for (const site of SITES) {
    if (metric === 'orientation' && site.startsWith('elbow')) continue;
    const row = document.createElement('tr'), stat = stats[site][metric];
    for (const text of [REFERENCES[site].label, `${definition.label} · ${definition.unit}`, formatted(stat?.mean), formatted(stat?.p95), formatted(stat?.max), stat ? `${stat.n} / ${next.frames.length}` : 'Unavailable']) {
      const cell = document.createElement('td'); cell.textContent = text;
      if (!stat) cell.title = 'No valid comparable mapped target / solved FK observations';
      row.append(cell);
    }
    $('statistics-body').append(row);
  }
  $('sample-count').textContent = `${next.frames.length.toLocaleString()} exported IK frames · ${next.fps} Hz display · ${next.duration.toFixed(1)} s`;
}
function renderExtractionMetadata(next) {
  const info = next.extraction ?? {};
  $('extraction-cadence').textContent = `Source ${info.source_fps ?? '≈240'} Hz → display ${info.display_fps ?? next.fps} Hz. 原始非均匀时间戳保留；左图的机器人关节是独立离线求解结果，不是人体节点。`;
  extractionCells.clear(); $('extraction-body').replaceChildren();
  for (const [site, definition] of Object.entries(REFERENCES)) {
    const row = document.createElement('tr'), heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = definition.label; row.append(heading);
    const cells = Array.from({ length: 4 }, () => { const cell = document.createElement('td'); row.append(cell); return cell; });
    extractionCells.set(site, cells); $('extraction-body').append(row);
  }
  $('motion-statistics-body').replaceChildren();
  for (const site of ['left', 'right', 'chest', 'footprint']) {
    const stat = next.motionStats?.[site], row = document.createElement('tr');
    for (const text of [REFERENCES[site].label, formatted(stat?.mean, 3), formatted(stat?.p95, 3), formatted(stat?.max, 3), stat ? String(stat.n) : 'Unavailable']) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    $('motion-statistics-body').append(row);
  }
  $('motion-sampling').textContent = next.motionStats?.sampling ?? 'Native source speed statistics are unavailable.';
}
function renderInspection(frame) {
  // Intentionally no fallback to frame.targets: mapped targets are NOT source URR.
  const source = frame.source_targets ?? {};
  for (const [site, cells] of extractionCells) {
    const pose = source[site];
    for (let axis = 0; axis < 3; axis++) cells[axis].textContent = validPosition(pose) ? pose.p[axis].toFixed(3) : '—';
    cells[3].textContent = site.startsWith('elbow') ? 'position only' : validRotation(pose) ? 'valid' : '—';
  }
  const site = $('inspect-site').value, definition = REFERENCES[site], target = frame.targets?.[site], anatomy = episode?.extraction?.anatomy ?? {};
  $('inspect-name').textContent = site === 'footprint' ? `${anatomy.hip ?? 'root'} → xy plane` : site === 'chest' ? `${anatomy.shoulder_left ?? 'l_uparm'} + ${anatomy.shoulder_right ?? 'r_uparm'} + ${anatomy.hip ?? 'root'}` : anatomy[site] ?? definition.joint;
  $('inspect-description').textContent = definition.description;
  $('inspect-source').textContent = xyz(source[site]); $('inspect-target').textContent = xyz(target); $('inspect-actual').textContent = xyz(frame.actual?.[site]);
  $('inspect-quaternion').textContent = site.startsWith('elbow') ? 'Not part of this target' : validRotation(target) ? target.q.map((value) => value.toFixed(4)).join(' · ') : 'Unavailable';
  const position = frameError(frame, site), orientation = frameError(frame, site, 'orientation');
  $('inspect-error').textContent = `${formatted(position)} cm / ${site.startsWith('elbow') ? 'position only' : formatted(orientation) + ' deg'}`;
}
function renderProvenance(next, additionalWarnings = []) {
  const content = $('provenance-content'); content.replaceChildren();
  const intro = document.createElement('p'); intro.textContent = 'NymeriaPlus optimized MHR → source URR → per-site relative Taku targets → our offline kinematic solve. No physical robot measurements.'; content.append(intro);
  const sources = document.createElement('ul');
  for (const source of next.provenance ?? []) {
    const item = document.createElement('li');
    if (typeof source === 'string' && /^https:\/\//.test(source)) { const link = document.createElement('a'); link.href = source; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = source.split('/').slice(-2).join('/'); item.append(link); }
    else item.textContent = typeof source === 'string' ? source : JSON.stringify(source);
    sources.append(item);
  }
  content.append(sources);
  const warnings = document.createElement('ul'); warnings.className = 'warning-list';
  for (const warning of [...new Set([...(next.warnings ?? []), ...additionalWarnings, ...(sceneFailure ? [sceneFailure] : [])])]) { const item = document.createElement('li'); item.textContent = warning; warnings.append(item); }
  content.append(warnings);
  for (const [label, value] of [['Extraction / source definitions', next.extraction], ['Retarget mapping / home selection', next.mapping], ['Offline solve / exact settings', next.ik ?? next.solver]]) {
    if (!value) continue;
    const detail = document.createElement('details'), heading = document.createElement('summary'), pre = document.createElement('pre');
    heading.textContent = label; pre.className = 'extraction-provenance'; pre.textContent = JSON.stringify(value, null, 2); detail.append(heading, pre); content.append(detail);
  }
}
function updateLayers() { scene?.setLayers({ solid: $('layer-solid').checked, targets: $('layer-targets').checked, errors: $('layer-errors').checked, skeleton: false }); }
function renderExcerptTabs() {
  $('episode-tabs').replaceChildren();
  for (const record of EXCERPTS) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = record.label; button.dataset.episode = record.id;
    button.setAttribute('aria-pressed', String(record.id === activeId)); button.addEventListener('click', () => chooseEpisode(record.id)); $('episode-tabs').append(button);
  }
}
async function chooseEpisode(id) {
  const record = EXCERPTS.find((item) => item.id === id); if (!record) return;
  const token = ++requestId; controller?.abort(); controller = new AbortController(); setPlaybackState(false);
  episode = null; currentTime = 0; activeId = id; delete $('load-status').dataset.warning;
  for (const container of [$('scene'), $('raw-skeleton-canvas')]) container.dataset.loading = 'true';
  sceneNotice.hidden = false; sceneNotice.textContent = sceneFailure ? 'WebGL unavailable. Numerical analysis can still be inspected.' : 'Loading Nymeria motion and Taku kinematics…';
  renderExcerptTabs(); resetMeasurements(); $('episode-description').textContent = record.description;
  $('play-pause').disabled = true; $('timeline').disabled = true; $('timeline').value = 0; $('load-error').hidden = true; $('provenance-content').replaceChildren();
  setLoading('Loading source motion and the precomputed Taku solution…');
  try {
    const next = await loadEpisode(id, { signal: controller.signal, onProgress(message) { if (token === requestId) setLoading(message); } });
    if (token !== requestId) return;
    if (!next.frames?.length || !next.frames.some((frame) => validPosition(frame.actual?.left))) throw new Error('This excerpt has no solved Taku FK result. Source-only targets are not displayed as a robot solution.');
    episode = next; renderStatistics(next); renderExtractionMetadata(next); renderProvenance(next);
    $('timeline').max = next.duration; $('duration-label').textContent = `${next.duration.toFixed(1)} s / ${next.fps} Hz display · ${next.extraction?.source_fps ?? '≈240'} Hz human source`;
    for (const chart of Object.values(charts)) chart.setEpisode(next);
    if (scene) {
      setLoading('Loading the official Taku model and independent target meshes…');
      try {
        const warnings = await scene.setEpisode(next); if (token !== requestId) return;
        for (const container of [$('scene'), $('raw-skeleton-canvas')]) delete container.dataset.loading;
        sceneNotice.hidden = true; renderProvenance(next, warnings ?? []);
      } catch (error) {
        if (token !== requestId) return;
        renderProvenance(next, [`Taku geometry could not be loaded: ${error.message}. Numerical results remain available.`]);
        sceneNotice.textContent = 'The Taku model could not be loaded. Numerical analysis remains available.';
        setLoading('Geometry unavailable. Source notes and numerical results remain available.'); $('load-status').dataset.warning = 'true';
      }
    }
    if (token !== requestId) return;
    if (!$('load-status').dataset.warning) $('load-status').hidden = true;
    $('play-pause').disabled = false; $('timeline').disabled = false; updateLayers(); scene?.setOpacity(Number($('target-opacity').value)); update(0);
    const url = new URL(location.href); url.searchParams.set('episode', id); history.replaceState(null, '', url);
  } catch (error) {
    if (token !== requestId || error.name === 'AbortError') return;
    episode = null; $('load-status').hidden = true; $('load-error').hidden = false; sceneNotice.textContent = 'No solved robot replay loaded.';
    $('load-error-message').textContent = error.message || 'The replay data is unavailable.'; resetMeasurements();
  }
}

$('play-pause').addEventListener('click', () => { if (episode && currentTime >= episode.duration - .001 && !playing) seek(0); setPlaybackState(!playing); });
$('timeline').addEventListener('input', (event) => seek(Number(event.target.value)));
$('timeline').addEventListener('pointerdown', () => { movingSlider = true; }); window.addEventListener('pointerup', () => { movingSlider = false; });
$('playback-speed').addEventListener('change', (event) => { speed = Number(event.target.value); previousTick = performance.now(); });
$('reset-camera').addEventListener('click', () => scene?.reset()); $('reset-source-camera').addEventListener('click', () => scene?.resetRaw?.());
$('retry-load').addEventListener('click', () => chooseEpisode(activeId));
for (const name of ['solid', 'targets', 'errors']) $(`layer-${name}`).addEventListener('change', updateLayers);
$('target-opacity').addEventListener('input', (event) => { const value = Number(event.target.value); $('opacity-value').value = `${Math.round(value * 100)}%`; scene?.setOpacity(value); });
$('inspect-site').addEventListener('change', () => { if (episode) renderInspection(episode.sample(currentTime)); });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaybackState(false); });
$('scene').addEventListener('keydown', (event) => {
  if (event.code === 'Space') { event.preventDefault(); setPlaybackState(!playing); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(currentTime + (event.key === 'ArrowRight' ? 1 : -1)); }
});
function tick(now) {
  if (playing && episode) {
    currentTime = Math.min(episode.duration, currentTime + Math.max(0, now - previousTick) / 1000 * speed); previousTick = now;
    if (now - lastPaint >= 1000 / 45 || currentTime >= episode.duration) { update(currentTime); lastPaint = now; }
    if (currentTime >= episode.duration) setPlaybackState(false);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
const requestedEpisode = new URLSearchParams(location.search).get('episode');
if (EXCERPTS.length) chooseEpisode(EXCERPTS.some((record) => record.id === requestedEpisode) ? requestedEpisode : activeId);
else { $('load-status').hidden = true; $('load-error').hidden = false; $('load-error-message').textContent = 'No NymeriaPlus excerpts are configured.'; }
