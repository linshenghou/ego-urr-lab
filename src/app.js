import './styles.css';
import { CATALOG, loadEpisode } from './data.js';
import { createScene } from './scene.js';
import { createErrorChart, episodeStatistics, frameError, ERROR_METRICS, withDerivedOrientation } from './charts.js';

const $ = (id) => document.getElementById(id);
const repository = import.meta.env.VITE_REPOSITORY_URL || 'https://github.com/linshenghou/ego-urr-lab';
for (const link of document.querySelectorAll('.repository-link')) { link.href = repository; link.target = '_blank'; link.rel = 'noreferrer'; }

const video = $('ego-video');
let episode = null, currentTime = 0, playing = false, speed = 1, previousTick = 0;
let activeId = 'box-kitting', activeMode = 'ego', requestId = 0, controller = null, lastPaint = 0;
let scene = null, sceneFailure = '', mediaFailure = false, movingSlider = false;
const sceneNotice = document.createElement('p'); sceneNotice.className = 'scene-status'; sceneNotice.setAttribute('role', 'status');
try { scene = createScene($('scene')); }
catch (error) {
  sceneFailure = `3D preview unavailable: ${error.message}`;
  sceneNotice.textContent = '此浏览器无法初始化 WebGL。视频与数据分析仍可使用。';
}
$('scene').append(sceneNotice);
const charts = {
  position: createErrorChart($('position-chart'), { metric: 'position', onSeek: seek }),
  orientation: createErrorChart($('orientation-chart'), { metric: 'orientation', onSeek: seek }),
};
const extractionCells = new Map();
const REFERENCE_DEFINITIONS = {
  left: { label: 'Left wrist', joint: 'l_wrist', kind: 'Anatomical joint pose', description: '提取骨架 FK 后的解剖手腕位姿；不添加抓取偏移，不使用腕带设备位姿。' },
  right: { label: 'Right wrist', joint: 'r_wrist', kind: 'Anatomical joint pose', description: '提取骨架 FK 后的解剖手腕位姿；不添加抓取偏移，不使用腕带设备位姿。' },
  elbow_left: { label: 'Left elbow', joint: 'l_lowarm', kind: 'Position-only target', description: '取前臂根节点原点作为肘点，只保留 xyz。显示几何可以朝向手腕，但该显示旋转不是 URR 姿态。' },
  elbow_right: { label: 'Right elbow', joint: 'r_lowarm', kind: 'Position-only target', description: '取前臂根节点原点作为肘点，只保留 xyz。显示几何可以朝向手腕，但该显示旋转不是 URR 姿态。' },
  chest: { label: 'Chest proxy', joint: 'l_uparm + r_uparm + root', kind: 'Derived geometric proxy', description: '位置为两肩中点；以左右肩连线与骨盆到肩中点方向正交化，构造 X 向前、Y 向左、Z 向上的胸部参考系。不是测得的胸骨点。' },
  footprint: { label: 'Footprint proxy', joint: 'root → xy plane', kind: 'Derived ground / heading proxy', description: '骨盆水平位置投影到 Aria 世界 z=0；首帧选择固定的有符号骨盆局部轴，之后投影该轴得到 yaw。z=0 不是独立测量的地面。' },
};
const validPosition = (pose) => pose?.valid_position !== false && pose?.p?.length === 3 && pose.p.every(Number.isFinite);
const validRotation = (pose) => pose?.valid_orientation !== false && pose?.q?.length === 4 && pose.q.every(Number.isFinite);
function derivedEnabled() { return episode?.kind === 'ego' && $('derived-orientation').checked; }
function metricEpisode(next) { return { ...next, frames: next.frames.map((frame) => withDerivedOrientation(frame, next.kind === 'ego' && $('derived-orientation').checked)) }; }
function configureMode(mode, previousMode) {
  const human = mode === 'nymeria';
  $('analysis').hidden = human; $('extraction').hidden = !human; $('orientation-policy').hidden = mode !== 'ego';
  $('scene-title').textContent = human ? 'Human skeleton / URR extraction' : 'Taku / URR overlay';
  $('source-panel-title').textContent = human ? 'Extraction / source notes' : 'First-person / source video';
  $('scene-solid-label').textContent = human ? 'Human skeleton' : 'Robot replay';
  document.querySelector('.scene-footer .orbit-hint').textContent = human ? 'z=0 reference · not measured floor' : 'Drag to orbit · Scroll to zoom';
  $('scene').setAttribute('aria-label', human ? 'NymeriaPlus human skeleton and derived six-site URR glyphs. No solved robot trajectory.' : 'Interactive Taku robot and semi-transparent URR targets. Drag to orbit, scroll to zoom.');
  $('readout-label').textContent = human ? '有效 URR 位置目标' : '双手最大位置误差 · target ↔ robot';
  $('readout-unit').textContent = human ? '/ 6' : 'cm';
  $('left-readout-label').textContent = human ? 'Left wrist z' : 'Left wrist'; $('right-readout-label').textContent = human ? 'Right wrist z' : 'Right wrist';
  $('readout-note').textContent = human ? '腕部 z 为相对 Aria 世界参考平面的高度。未运行 Taku IK；这里不显示机器人跟踪误差。' : '仅在目标与机器人参考点同时有效时计算。这不是实机闭环控制性能的独立测评。';
  $('layer-solid').disabled = human; $('layer-errors').disabled = human;
  $('layer-solid').parentElement.title = human ? 'Nymeria mode has no solved Taku robot trajectory' : '';
  $('layer-errors').parentElement.title = human ? 'No robot achieved poses are available to compare' : '';
  if (human) { $('layer-solid').checked = false; $('layer-errors').checked = false; $('layer-skeleton').checked = true; }
  else if (previousMode === 'nymeria') { $('layer-solid').checked = true; $('layer-skeleton').checked = false; }
  const officialLink = $('load-error').querySelector('a');
  officialLink.href = human ? 'https://github.com/facebookresearch/nymeria_dataset' : 'https://www.dyna.co/dyna-2.1';
}

function setLoading(message) { $('load-status').hidden = false; $('load-message').textContent = message; }
function setPlaybackState(next) {
  playing = Boolean(next && episode); previousTick = performance.now();
  $('play-icon').textContent = playing ? 'Ⅱ' : '▶'; $('play-label').textContent = playing ? 'Pause' : 'Play';
  $('play-pause').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
  if (!playing) video.pause();
  else if (episode.videoUrl && !mediaFailure) {
    syncVideo(true);
    const attempt = video.play();
    attempt?.catch(() => { if (playing) { $('video-state').textContent = 'VIDEO PLAYBACK BLOCKED'; showVideoPlaceholder('Video playback unavailable', '浏览器阻止了播放。可打开原始视频单独查看；机器人回放仍可继续。'); } });
  }
}
function showVideoPlaceholder(title, detail) {
  $('video-placeholder').hidden = false; $('video-placeholder-title').textContent = title; $('video-placeholder-detail').textContent = detail;
}
function videoTime(frame) { return typeof frame?.video_time_s === 'number' ? frame.video_time_s : (episode?.start ?? 0) + currentTime; }
function syncVideo(force = false, frame = null) {
  if (!episode?.videoUrl || mediaFailure || video.readyState < 1) return;
  const expected = videoTime(frame ?? episode.sample(currentTime));
  if (force || Math.abs(video.currentTime - expected) > .15) {
    try { video.currentTime = Math.min(expected, Number.isFinite(video.duration) ? video.duration : expected); } catch { /* A metadata event will retry. */ }
  }
  if (video.playbackRate !== speed) video.playbackRate = speed;
}
function formatted(value, digits = 2) { return value === null ? '—' : value.toFixed(digits); }
function update(time, { forceVideo = false } = {}) {
  if (!episode) return;
  currentTime = Math.max(0, Math.min(episode.duration, time));
  const frame = episode.sample(currentTime);
  scene?.update(frame);
  if (!movingSlider) $('timeline').value = currentTime;
  $('timeline').setAttribute('aria-valuetext', `${currentTime.toFixed(1)} of ${episode.duration.toFixed(1)} seconds`);
  $('current-time').textContent = `${currentTime.toFixed(1)} s`;
  $('video-time').textContent = episode.videoUrl ? `${videoTime(frame).toFixed(3)} s` : '—';
  if (episode.kind === 'nymeria') {
    $('current-error').textContent = String(Object.keys(REFERENCE_DEFINITIONS).filter((site) => validPosition(frame.targets?.[site])).length);
    for (const side of ['left', 'right']) $('current-' + side).textContent = validPosition(frame.targets?.[side]) ? `${frame.targets[side].p[2].toFixed(3)} m` : '—';
    renderExtractionFrame(frame);
  } else {
    const left = frameError(frame, 'left'), right = frameError(frame, 'right');
    const available = [left, right].filter((value) => value !== null);
    $('current-error').textContent = formatted(available.length ? Math.max(...available) : null);
    $('current-left').textContent = left === null ? '—' : `${formatted(left)} cm`;
    $('current-right').textContent = right === null ? '—' : `${formatted(right)} cm`;
    for (const chart of Object.values(charts)) chart.update(currentTime, withDerivedOrientation(frame, derivedEnabled()));
  }
  syncVideo(forceVideo, frame);
}
function seek(time) {
  if (!episode) return;
  update(time, { forceVideo: true }); previousTick = performance.now();
}
function resetMeasurements() {
  $('current-error').textContent = '—'; $('current-left').textContent = '—'; $('current-right').textContent = '—';
  $('sample-count').textContent = 'Waiting for a source episode'; $('statistics-body').replaceChildren();
  $('current-time').textContent = '0.0 s'; $('duration-label').textContent = '—'; $('video-time').textContent = '0.000 s';
  for (const chart of Object.values(charts)) chart.setEpisode(null);
}
function renderStatistics(next) {
  const stats = episodeStatistics(metricEpisode(next).frames); $('statistics-body').replaceChildren();
  for (const [metric, definition] of Object.entries(ERROR_METRICS)) for (const side of ['left', 'right']) {
    const row = document.createElement('tr'), stat = stats[side][metric];
    const unavailable = metric === 'orientation' && next.kind === 'ego' ? '缺少实际朝向' : 'Unavailable';
    const label = metric === 'orientation' && derivedEnabled() ? 'FK-derived orientation' : definition.label;
    for (const text of [side === 'left' ? 'Left wrist' : 'Right wrist', `${label} · ${definition.unit}`, stat ? formatted(stat.mean) : '—', stat ? formatted(stat.p95) : '—', stat ? formatted(stat.max) : '—', stat ? `${stat.n} / ${next.frames.length}` : unavailable]) {
      const cell = document.createElement('td'); cell.textContent = text;
      if (!stat) cell.title = metric === 'orientation' && next.kind === 'ego' ? '公开 ach.ee 字段没有实际末端四元数。可选择从 robot link 与固定 EE 变换推导，但这不是直接记录的 achieved quaternion。' : 'No valid comparable observations';
      row.append(cell);
    }
    $('statistics-body').append(row);
  }
  $('sample-count').textContent = `${next.frames.length.toLocaleString()} native frames · ${next.fps} Hz · ${next.duration.toFixed(1)} s`;
}
function refreshMetricProjection() {
  $('orientation-chart-title').textContent = derivedEnabled() ? 'Wrist orientation · FK-derived' : 'Wrist orientation';
  $('derived-orientation-note').hidden = !derivedEnabled();
  if (!episode || episode.kind === 'nymeria') return;
  renderStatistics(episode);
  for (const chart of Object.values(charts)) chart.setEpisode(metricEpisode(episode));
  update(currentTime);
}
function renderExtractionMetadata(next) {
  const info = next.extraction ?? {};
  $('extraction-cadence').textContent = `Source ${info.source_fps ?? '≈240'} Hz → display ${info.display_fps ?? next.fps} Hz · ${next.frames.length.toLocaleString()} exported frames. 原始时间戳保留；显示插值不增加采样信息。`;
  extractionCells.clear(); $('extraction-body').replaceChildren();
  for (const [site, definition] of Object.entries(REFERENCE_DEFINITIONS)) {
    const row = document.createElement('tr'), heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = definition.label; row.append(heading);
    const cells = Array.from({ length: 4 }, () => { const cell = document.createElement('td'); row.append(cell); return cell; });
    extractionCells.set(site, cells); $('extraction-body').append(row);
  }
  $('motion-statistics-body').replaceChildren();
  for (const site of ['left', 'right', 'chest', 'footprint']) {
    const stat = next.motionStats?.[site]; const row = document.createElement('tr');
    for (const text of [REFERENCE_DEFINITIONS[site].label, stat ? stat.mean.toFixed(3) : '—', stat ? stat.p95.toFixed(3) : '—', stat ? stat.max.toFixed(3) : '—', stat ? String(stat.n) : 'Unavailable']) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    $('motion-statistics-body').append(row);
  }
  $('motion-sampling').textContent = next.motionStats?.sampling ?? 'Native motion speed statistics are not available for this excerpt.';
}
function renderExtractionFrame(frame) {
  for (const [site, cells] of extractionCells) {
    const pose = frame.targets?.[site];
    for (let axis = 0; axis < 3; axis++) cells[axis].textContent = validPosition(pose) ? pose.p[axis].toFixed(3) : '—';
    cells[3].textContent = site.startsWith('elbow') ? 'position only' : validRotation(pose) ? 'valid' : '—';
  }
  const site = $('inspect-site').value, definition = REFERENCE_DEFINITIONS[site], pose = frame.targets?.[site];
  const anatomy = episode?.extraction?.anatomy ?? {};
  $('inspect-name').textContent = site === 'footprint' ? `${anatomy.hip ?? 'root'} → xy plane` : site === 'chest' ? `${anatomy.shoulder_left ?? 'l_uparm'} + ${anatomy.shoulder_right ?? 'r_uparm'} + ${anatomy.hip ?? 'root'}` : anatomy[site] ?? definition.joint;
  $('inspect-description').textContent = definition.description; $('inspect-kind').textContent = definition.kind;
  $('inspect-position').textContent = validPosition(pose) ? pose.p.map((v) => v.toFixed(4)).join(' · ') : 'Unavailable';
  $('inspect-quaternion').textContent = site.startsWith('elbow') ? 'Not part of this target' : validRotation(pose) ? pose.q.map((v) => v.toFixed(4)).join(' · ') : 'Unavailable';
}
function renderProvenance(next, additionalWarnings = []) {
  const content = $('provenance-content'); content.replaceChildren();
  const intro = document.createElement('p'); intro.textContent = next.kind === 'ego' ? 'EGO demonstration · recorded RL simulation · the published task crop, at 1× by default.' : next.kind === 'nymeria' ? 'NymeriaPlus · optimized MHR skeleton → our derived six-site URR. No solved robot motion. Non-audio excerpt under CC BY-NC 4.0.' : 'URR Tracking · recorded Taku joints and six-site targets · a separate source without paired EGO video.'; content.append(intro);
  const sources = document.createElement('ul');
  for (const source of next.provenance ?? []) {
    const item = document.createElement('li');
    if (/^https:\/\//.test(source)) { const link = document.createElement('a'); link.href = source; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = source.split('/').slice(-2).join('/'); item.append(link); }
    else item.textContent = source;
    sources.append(item);
  }
  content.append(sources);
  const warnings = document.createElement('ul'); warnings.className = 'warning-list';
  for (const warning of [...new Set([...(next.warnings ?? []), ...additionalWarnings, ...(sceneFailure ? [sceneFailure] : [])])]) { const item = document.createElement('li'); item.textContent = warning; warnings.append(item); }
  content.append(warnings);
  if (next.extraction) {
    const detail = document.createElement('details'), heading = document.createElement('summary'), pre = document.createElement('pre');
    heading.textContent = 'Extraction provenance / exact settings'; pre.className = 'extraction-provenance';
    pre.textContent = JSON.stringify(next.extraction, null, 2); detail.append(heading, pre); content.append(detail);
  }
}
function updateLayers() {
  scene?.setLayers(Object.fromEntries(['solid', 'targets', 'skeleton', 'errors'].map((name) => [name, $(`layer-${name}`).checked])));
}
function renderEpisodeTabs() {
  $('episode-tabs').replaceChildren();
  for (const record of CATALOG.filter((item) => item.kind === activeMode)) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = record.label;
    button.dataset.episode = record.id; button.setAttribute('aria-pressed', String(record.id === activeId));
    button.addEventListener('click', () => chooseEpisode(record.id)); $('episode-tabs').append(button);
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === activeMode; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  }
  $('episode-panel').setAttribute('aria-labelledby', `mode-${activeMode}`);
}
async function chooseEpisode(id) {
  const record = CATALOG.find((item) => item.id === id); if (!record) return;
  const token = ++requestId; controller?.abort(); controller = new AbortController();
  const previousMode = activeMode;
  setPlaybackState(false); episode = null; currentTime = 0; activeId = id; activeMode = record.kind; mediaFailure = false;
  configureMode(record.kind, previousMode);
  delete $('load-status').dataset.warning;
  $('scene').dataset.loading = 'true'; sceneNotice.hidden = false;
  sceneNotice.textContent = sceneFailure ? '此浏览器无法初始化 WebGL。视频与数据分析仍可使用。' : 'Loading source geometry…';
  renderEpisodeTabs(); resetMeasurements();
  $('episode-description').textContent = record.description;
  $('play-pause').disabled = true; $('timeline').disabled = true; $('timeline').value = 0;
  $('load-error').hidden = true; $('provenance-content').replaceChildren();
  video.pause(); video.removeAttribute('src'); video.load(); $('source-video-link').hidden = true;
  $('video-state').textContent = record.kind === 'ego' ? 'SOURCE MEDIA' : record.kind === 'nymeria' ? 'SKELETON → URR · NO ROBOT IK' : 'SEPARATE SOURCE';
  showVideoPlaceholder(record.kind === 'ego' ? 'Loading the original view' : record.kind === 'nymeria' ? 'Real motion. Explicit extraction.' : 'No paired EGO video', record.kind === 'ego' ? '视频直接读取官方源文件，与回放共享时间轴。' : record.kind === 'nymeria' ? '真实优化骨架 + 我们提取的 URR。此公开样本不含视频、音频或 Taku IK 结果。下方可检查每个参考点的来源与数值。' : 'URR Tracking 是独立记录，不能与三个 EGO 任务的视频混配。');
  setLoading('Fetching the official source files…');
  try {
    const next = await loadEpisode(id, { signal: controller.signal, onProgress(message) { if (token === requestId) setLoading(message); } });
    if (token !== requestId) return;
    episode = next; if (next.kind === 'nymeria') renderExtractionMetadata(next); else renderStatistics(next); renderProvenance(next);
    $('timeline').max = next.duration;
    $('duration-label').textContent = next.kind === 'nymeria' ? `${next.duration.toFixed(1)} s / ${next.fps} Hz display · ${next.extraction?.source_fps ?? '≈240'} Hz native` : `${next.duration.toFixed(1)} s / ${next.fps} Hz source`;
    for (const chart of Object.values(charts)) chart.setEpisode(next.kind === 'nymeria' ? null : metricEpisode(next));
    $('orientation-chart-title').textContent = derivedEnabled() ? 'Wrist orientation · FK-derived' : 'Wrist orientation';
    $('derived-orientation-note').hidden = !derivedEnabled();
    if (next.videoUrl) {
      video.src = next.videoUrl; video.load(); $('source-video-link').href = next.videoUrl; $('source-video-link').hidden = false;
    }
    // A failed model must not turn valid numerical observations into fake geometry.
    if (scene) {
      setLoading(next.kind === 'nymeria' ? 'Preparing skeleton and derived reference glyphs…' : 'Loading the official Taku model…');
      try {
        const warnings = await scene.setEpisode(next);
        if (token !== requestId) return;
        delete $('scene').dataset.loading; sceneNotice.hidden = true;
        renderProvenance(next, warnings ?? []);
      } catch (error) {
        if (token !== requestId) return;
        renderProvenance(next, [`3D model failed to load: ${error.message}. Numerical data remains available.`]);
        sceneNotice.textContent = 'The official model could not be loaded. Numerical analysis remains available.';
        setLoading('Taku model unavailable. Video and numerical analysis are still available; see source notes.');
        $('load-status').dataset.warning = 'true';
      }
    }
    if (token !== requestId) return;
    if (!$('load-status').dataset.warning) $('load-status').hidden = true;
    $('play-pause').disabled = false; $('timeline').disabled = false;
    $('layer-skeleton').disabled = !(next.skeleton?.bones?.length);
    $('layer-skeleton').parentElement.title = next.skeleton?.bones?.length ? 'Show published source skeleton, including inferred guide geometry' : 'This source does not contain a published source skeleton';
    updateLayers(); scene?.setOpacity(Number($('target-opacity').value)); update(0, { forceVideo: true });
    const url = new URL(location.href); url.searchParams.set('episode', id); history.replaceState(null, '', url);
  } catch (error) {
    if (token !== requestId || error.name === 'AbortError') return;
    episode = null; $('load-status').hidden = true; $('load-error').hidden = false;
    sceneNotice.textContent = 'No source geometry loaded.';
    $('load-error-message').textContent = error.message || 'The remote source is unavailable.';
    resetMeasurements();
  }
}

$('play-pause').addEventListener('click', () => { if (episode && currentTime >= episode.duration - .001 && !playing) seek(0); setPlaybackState(!playing); });
$('timeline').addEventListener('input', (event) => seek(Number(event.target.value)));
$('timeline').addEventListener('pointerdown', () => { movingSlider = true; });
window.addEventListener('pointerup', () => { movingSlider = false; });
$('playback-speed').addEventListener('change', (event) => { speed = Number(event.target.value); video.playbackRate = speed; previousTick = performance.now(); });
$('reset-camera').addEventListener('click', () => scene?.reset());
$('retry-load').addEventListener('click', () => { delete $('load-status').dataset.warning; chooseEpisode(activeId); });
for (const name of ['solid', 'targets', 'skeleton', 'errors']) $(`layer-${name}`).addEventListener('change', updateLayers);
$('target-opacity').addEventListener('input', (event) => { const value = Number(event.target.value); $('opacity-value').value = `${Math.round(value * 100)}%`; scene?.setOpacity(value); });
$('derived-orientation').addEventListener('change', refreshMetricProjection);
$('inspect-site').addEventListener('change', () => { if (episode?.kind === 'nymeria') renderExtractionFrame(episode.sample(currentTime)); });
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => { if (button.dataset.mode !== activeMode) chooseEpisode(CATALOG.find((item) => item.kind === button.dataset.mode).id); });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const modes = [...document.querySelectorAll('[data-mode]')].map((item) => item.dataset.mode);
      const mode = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1) : modes[(modes.indexOf(activeMode) + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length];
      $(`mode-${mode}`).focus(); if (mode !== activeMode) chooseEpisode(CATALOG.find((item) => item.kind === mode).id);
    }
  });
}
video.addEventListener('loadedmetadata', () => { if (episode?.videoUrl) { syncVideo(true); $('video-state').textContent = 'OFFICIAL SOURCE VIDEO'; } });
video.addEventListener('loadeddata', () => { if (episode?.videoUrl && !mediaFailure) $('video-placeholder').hidden = true; });
video.addEventListener('canplay', () => { if (episode?.videoUrl && !mediaFailure) { $('video-placeholder').hidden = true; if (playing) video.play()?.catch(() => {}); } });
video.addEventListener('error', () => {
  if (!episode?.videoUrl || !video.getAttribute('src')) return;
  mediaFailure = true; $('video-state').textContent = 'VIDEO UNAVAILABLE';
  showVideoPlaceholder('The original video could not be loaded', '轨迹数据仍可查看。源站访问或浏览器解码失败时，请使用右上角链接打开原始视频。');
});
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
chooseEpisode(CATALOG.some((record) => record.id === requestedEpisode) ? requestedEpisode : activeId);
