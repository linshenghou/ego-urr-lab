/** Licensed, reduced NymeriaPlus skeleton excerpts. No robot IK is executed. */
import { Quaternion } from 'three';

export const NYMERIA_CATALOG = Object.freeze([
  { id: 'nymeria-housework-long', label: 'Housework · continuous 2 min', kind: 'nymeria', file: 'housework-long.json', description: 'NymeriaPlus · source 30–150 s · skeleton → derived URR only' },
  { id: 'nymeria-housework-hands', label: 'Housework · hand movement', kind: 'nymeria', file: 'housework-hands.json', description: 'NymeriaPlus · source 562.5–577.5 s · skeleton → derived URR only' },
]);
const SITES = ['left', 'right', 'elbow_left', 'elbow_right', 'chest', 'footprint'];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => finite(x) || x === null);
const quaternion = (q) => vec(q, 4) && q.every(finite) && Math.hypot(...q) > 1e-9;
const unavailableErrors = () => Object.fromEntries(SITES.map((site) => [site, { position_m: null, orientation_rad: null }]));

export function validateNymeria(document) {
  const allowed = new Set(['schema', 'time', 'source_time', 'skeleton', 'targets', 'motionStats', 'extraction', 'source', 'license']);
  if (!document || Object.keys(document).some((key) => !allowed.has(key)) || document.schema !== 'ego-urr-lab.nymeria.v1') throw new Error('Unsupported Nymeria excerpt schema');
  const times = document.time, n = times?.length;
  if (!Array.isArray(times) || n < 2 || n > 20000 || times[0] !== 0 || times.some((t, i) => !finite(t) || (i > 0 && t <= times[i - 1]))) throw new Error('Invalid Nymeria replay clock');
  if (!Array.isArray(document.source_time) || document.source_time.length !== n || document.source_time.some((t, i) => !finite(t) || Math.abs(t - document.source_time[0] - times[i]) > 3e-6)) throw new Error('Nymeria source clock mismatch');
  const skeleton = document.skeleton;
  if (!Array.isArray(skeleton?.joints) || !skeleton.joints.length || skeleton.joints.length > 100 || new Set(skeleton.joints).size !== skeleton.joints.length || skeleton.joints.some((name) => typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name))) throw new Error('Invalid skeleton joint names');
  const names = new Set(skeleton.joints);
  if (!Array.isArray(skeleton.edges) || skeleton.edges.some((edge) => !Array.isArray(edge) || edge.length !== 2 || edge.some((name) => !names.has(name)))) throw new Error('Invalid skeleton edges');
  if (!Array.isArray(skeleton.positions) || skeleton.positions.length !== n || skeleton.positions.some((frame) => !Array.isArray(frame) || frame.length !== names.size || frame.some((p) => !vec(p, 3)))) throw new Error('Invalid skeleton positions');
  if (!document.targets || Object.keys(document.targets).sort().join() !== [...SITES].sort().join()) throw new Error('Expected six derived URR sites');
  for (const site of SITES) {
    const data = document.targets[site];
    if (!Array.isArray(data.p) || data.p.length !== n || data.p.some((p) => !vec(p, 3))) throw new Error(`Invalid ${site} positions`);
    if (site.startsWith('elbow') ? data.q !== null : !Array.isArray(data.q) || data.q.length !== n || data.q.some((q) => !vec(q, 4))) throw new Error(`Invalid ${site} orientations`);
    for (const [name, count] of [['pv', n], ['ov', n], ['interval_pv', n - 1], ['interval_ov', n - 1]]) if (!Array.isArray(data[name]) || data[name].length !== count || data[name].some((value) => typeof value !== 'boolean')) throw new Error(`Invalid ${site} validity masks`);
    if (site.startsWith('elbow') && data.ov.some(Boolean)) throw new Error('Elbows have no URR orientation labels');
  }
  if (document.license?.id !== 'CC-BY-NC-4.0' || !document.license.attribution || !document.source?.sequence_id || !document.extraction?.source_sha256?.match(/^[a-f0-9]{64}$/)) throw new Error('Missing Nymeria license or source provenance');
  return document;
}

export function createNymeriaEpisode(record, document) {
  validateNymeria(document);
  const { time: times, source_time: sourceTimes, skeleton, targets, extraction } = document;
  function sample(value) {
    if (!finite(value)) throw new Error('Replay time must be finite');
    const t = Math.max(0, Math.min(times.at(-1), value));
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= t + 1e-10) lo = mid + 1; else hi = mid; }
    const i = Math.max(0, lo - 1), j = Math.min(i + 1, times.length - 1), a = i === j ? 0 : Math.max(0, (t - times[i]) / (times[j] - times[i]));
    const exact = a < 1e-8;
    const position = (p0, p1) => p0.map((x, k) => finite(x) && (exact || finite(p1[k])) ? exact ? x : x * (1 - a) + p1[k] * a : null);
    const raw = {}, poses = {};
    for (const [k, name] of skeleton.joints.entries()) { const p = position(skeleton.positions[i][k], skeleton.positions[j][k]); raw[name] = { p, q: null, valid_position: p.every(finite) && (exact || times[j] - times[i] <= .1), valid_orientation: false }; }
    for (const site of SITES) {
      const data = targets[site], p = position(data.p[i], data.p[j]);
      const pv = p.every(finite) && data.pv[i] && (exact || (data.pv[j] && data.interval_pv[i]));
      let ov = data.ov[i] && (exact || (data.ov[j] && data.interval_ov[i])), q = null;
      if (ov && quaternion(data.q?.[i]) && (exact || quaternion(data.q?.[j]))) q = new Quaternion(...data.q[i]).normalize().slerp(new Quaternion(...data.q[exact ? i : j]).normalize(), a).toArray();
      else ov = false;
      poses[site] = { p, q, valid_position: Boolean(pv), valid_orientation: Boolean(ov), confidence: null };
    }
    return { t, source_t: sourceTimes[0] + t, targets: poses, raw, actual: {}, taku_links: {}, errors: unavailableErrors() };
  }
  const frames = times.map(sample);
  return { ...record, kind: 'nymeria', duration: times.at(-1), fps: extraction.display_fps, start: sourceTimes[0], videoUrl: null, model: null,
    frames, sample, skeleton: { joints: skeleton.joints, bones: skeleton.edges, inferred: [], stanceBone: [] }, extraction, motionStats: document.motionStats,
    stats: Object.fromEntries(SITES.map((site) => [site, { position: null, orientation: null }])),
    source: document.source, license: document.license,
    provenance: [document.source.url, document.license.url, 'docs/nymeriaplus-provenance.md'],
    warnings: ['NymeriaPlus optimized MHR body estimate → derived URR targets. No Taku retargeting, robot state or tracking-error result exists for these excerpts.',
      'Chest is a shoulder-midpoint geometric proxy. Footprint projects pelvis onto Aria world z=0, which is not an independently measured floor.',
      'Wrist poses use anatomical MHR joints; elbow targets use position only. The selected pelvis-local heading axis is fixed once, not recalibrated every frame.',
      'Original nonuniform native timestamps are retained after display decimation. Source velocity statistics use native valid intervals before decimation, not interpolated display samples.',
      'Validity thresholds flag discontinuities and are independent from robot actuator velocity/acceleration limits. Confidence is not supplied.',
      'CC BY-NC 4.0 non-audio numerical derivative. Attribution to Meta Platforms, Inc. and affiliates; noncommercial use only.'],
  };
}

export async function loadNymeriaEpisode(id, { signal, onProgress = () => {} } = {}) {
  const record = NYMERIA_CATALOG.find((entry) => entry.id === id); if (!record) throw new Error('Unknown Nymeria episode');
  onProgress('Loading the licensed NymeriaPlus skeleton excerpt…');
  const url = `${import.meta.env?.BASE_URL ?? './'}data/nymeria/${record.file}`;
  const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`Nymeria excerpt HTTP ${response.status}`);
  const document = await response.json(); onProgress('Checking source clock, anatomical mapping and validity masks…');
  return createNymeriaEpisode(record, document);
}
