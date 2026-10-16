/** Geometry-only errors. Missing observations are never converted to zero. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const PLOT = { width: 640, height: 230, left: 39, right: 10, top: 16, bottom: 28 };
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export const ERROR_METRICS = Object.freeze({
  position: { key: 'position_m', scale: 100, unit: 'cm', label: 'Position' },
  orientation: { key: 'orientation_rad', scale: 180 / Math.PI, unit: 'deg', label: 'Orientation' },
});

export function frameError(frame, side, metric = 'position') {
  const definition = ERROR_METRICS[metric];
  if (!definition) throw new Error(`Unknown error metric: ${metric}`);
  const value = frame?.errors?.[side]?.[definition.key];
  return isNumber(value) && value >= 0 ? value * definition.scale : null;
}

export function summarize(values) {
  const valid = values.filter((value) => isNumber(value) && value >= 0).sort((a, b) => a - b);
  if (!valid.length) return null;
  const p95Index = (valid.length - 1) * .95;
  const lower = Math.floor(p95Index), upper = Math.ceil(p95Index);
  return {
    n: valid.length,
    mean: valid.reduce((sum, value) => sum + value, 0) / valid.length,
    p95: valid[lower] + (valid[upper] - valid[lower]) * (p95Index - lower),
    max: valid.at(-1),
  };
}

export function episodeStatistics(frames = []) {
  return Object.fromEntries(['left', 'right'].map((side) => [side,
    Object.fromEntries(Object.keys(ERROR_METRICS).map((metric) => [metric,
      summarize(frames.map((frame) => frameError(frame, side, metric))),
    ])),
  ]));
}

/** Returning a new segment after every absent sample prevents misleading bridges. */
export function errorSegments(frames, side, metric) {
  const segments = []; let current = [];
  for (const frame of frames) {
    const value = frameError(frame, side, metric);
    if (value === null || !isNumber(frame.t)) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push([frame.t, value]);
  }
  if (current.length) segments.push(current);
  return segments;
}

function axisLimit(maximum) {
  if (!(maximum > 0)) return 1;
  const step = maximum / 4, power = 10 ** Math.floor(Math.log10(step)), fraction = step / power;
  const roundedStep = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  return Math.ceil(maximum / roundedStep) * roundedStep;
}
function element(name, attributes = {}, text = '') {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
}

export function createErrorChart(container, { metric = 'position', onSeek = () => {} } = {}) {
  const definition = ERROR_METRICS[metric];
  let episode = null, yMax = 1, cursor = null, circles = {};
  const svg = element('svg', { viewBox: `0 0 ${PLOT.width} ${PLOT.height}`, role: 'img', 'aria-label': `${definition.label} errors over replay time, measured in ${definition.unit}` });
  const empty = document.createElement('p'); empty.className = 'chart-empty';
  const x = (t) => PLOT.left + (t / Math.max(episode?.duration ?? 1, 1e-9)) * (PLOT.width - PLOT.left - PLOT.right);
  const y = (v) => PLOT.height - PLOT.bottom - v / yMax * (PLOT.height - PLOT.top - PLOT.bottom);
  const formatAxis = (value) => value === 0 ? '0' : value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  container.replaceChildren(svg, empty);

  const setEpisode = (next) => {
    episode = next; svg.replaceChildren(); cursor = null; circles = {};
    const series = Object.fromEntries(['left', 'right'].map((side) => [side, errorSegments(next?.frames ?? [], side, metric)]));
    let maximum = 0, count = 0;
    for (const side of Object.values(series)) for (const segment of side) for (const [, value] of segment) { maximum = Math.max(maximum, value); count++; }
    yMax = axisLimit(maximum * 1.03);
    const hasData = count > 0;
    empty.hidden = hasData;
    empty.textContent = !next ? 'Select a source episode to inspect its errors.' : metric === 'orientation' ? '源文件缺少可比较的末端姿态；姿态误差不可用。' : 'No comparable reference points are available.';
    svg.setAttribute('aria-label', hasData ? `${definition.label} errors over ${next.duration.toFixed(1)} seconds. Statistics are available in the table below.` : empty.textContent);
    for (let i = 0; i <= 4; i++) {
      const value = yMax * i / 4, yy = y(value);
      svg.append(element('line', { x1: PLOT.left, x2: PLOT.width - PLOT.right, y1: yy, y2: yy, class: 'chart-grid' }));
      if (hasData) svg.append(element('text', { x: PLOT.left - 10, y: yy + 3, 'text-anchor': 'end', class: 'chart-axis-label' }, formatAxis(value)));
    }
    if (!next) return;
    for (let i = 0; i <= 4; i++) {
      const t = next.duration * i / 4;
      svg.append(element('text', { x: x(t), y: PLOT.height - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'chart-axis-label' }, `${Number(t.toFixed(1))}${i === 4 ? ' s' : ''}`));
    }
    for (const [side, segments] of Object.entries(series)) {
      for (const segment of segments) {
        if (segment.length === 1) svg.append(element('circle', { cx: x(segment[0][0]), cy: y(segment[0][1]), r: 2, class: `chart-cursor-${side}` }));
        else svg.append(element('path', { d: segment.map(([t, value], index) => `${index ? 'L' : 'M'}${x(t).toFixed(2)},${y(value).toFixed(2)}`).join(' '), class: `chart-path chart-path-${side}` }));
      }
    }
    if (hasData) {
      cursor = element('line', { x1: x(0), x2: x(0), y1: PLOT.top, y2: PLOT.height - PLOT.bottom, class: 'chart-cursor' });
      svg.append(cursor);
      for (const side of ['left', 'right']) { circles[side] = element('circle', { r: 3.5, class: `chart-cursor-${side}`, visibility: 'hidden' }); svg.append(circles[side]); }
    }
    const hit = element('rect', { x: PLOT.left, y: PLOT.top, width: PLOT.width - PLOT.left - PLOT.right, height: PLOT.height - PLOT.top - PLOT.bottom, class: 'chart-hit-area' });
    hit.addEventListener('click', (event) => {
      const bounds = svg.getBoundingClientRect(), point = (event.clientX - bounds.left) / bounds.width * PLOT.width;
      onSeek(Math.max(0, Math.min(next.duration, (point - PLOT.left) / (PLOT.width - PLOT.left - PLOT.right) * next.duration)));
    });
    svg.append(hit);
  };
  const update = (time, frame) => {
    if (!episode || !cursor) return;
    cursor.setAttribute('x1', x(time)); cursor.setAttribute('x2', x(time));
    for (const side of ['left', 'right']) {
      const value = frameError(frame, side, metric), circle = circles[side];
      circle.setAttribute('visibility', value === null ? 'hidden' : 'visible');
      if (value !== null) { circle.setAttribute('cx', x(time)); circle.setAttribute('cy', y(value)); }
    }
  };
  setEpisode(null);
  return { setEpisode, update, dispose() { container.replaceChildren(); } };
}
