import { el, clear, plural, statusMessage } from '../util.js';
import { assetURL } from '../config.js';
import { Transport, SPEEDS, DEFAULT_SPEED } from '../viewer/transport.js';
import { Panel } from '../viewer/panel.js';
import { LoadGate, loadingBar, videoSource } from '../viewer/loader.js';
import { SyncLog, probeRanges } from '../viewer/synclog.js';

const COLUMNS = [
  { id: 'box', name: 'Box prompt', hint: 'Prompted with the tight box around each GT mask' },
  { id: 'point', name: 'Point prompt', hint: 'Prompted with CoTracker point tracks' },
];

/** The v2 visualization page. */
export async function renderViewer(main, dataset, video, pipe) {
  const base = `${dataset.id}/${video.id}/${pipe.id}`;
  statusMessage(main, 'Loading visualizations…');

  const fetchJSON = async (name) => {
    const response = await fetch(assetURL(`${base}/${name}`), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${name} returned ${response.status}`);
    return response.json();
  };

  let spec;
  let manifest = null;
  let boxes = null;
  try {
    spec = await fetchJSON('visualizations.json');
    // The 3D view is a bonus, not a precondition: if its inputs are missing the
    // video tiles should still render.
    [manifest, boxes] = await Promise.all([
      fetchJSON('manifest.json').catch(() => null),
      fetchJSON('boxes.json').catch(() => null),
    ]);
  } catch (error) {
    statusMessage(main, 'No visualizations built for this clip yet.',
      `${error.message}. Run: build_site.py --assets --videos ${video.id}`);
    return;
  }

  const transport = new Transport({ nFrames: spec.n_frames, fps: spec.video_fps });
  const panels = spec.visualizations.map((vis) => new Panel(vis, base, transport));

  let cloud = null;
  let mesh = null;
  if (manifest && boxes) {
    const { CloudPanel } = await import('../viewer/cloudpanel.js');
    cloud = new CloudPanel(assetURL(base), manifest, boxes, transport);
  }
  if (spec.meshes && Object.keys(spec.meshes).length) {
    const { MeshPanel } = await import('../viewer/meshpanel.js');
    mesh = new MeshPanel(base, spec, transport);
  }

  const log = new SyncLog({
    video: video.id, pipeline: pipe.id, assetBase: assetURL(base),
    mode: () => transport.mode,
  });
  window.syncLog = log;
  for (const panel of panels) log.watch(panel);
  if (cloud) log.watchCloud(cloud);
  log.start();
  // Range support is the difference between a seek costing a few KB and
  // refetching the whole clip, so record what the host actually does.
  probeRanges(assetURL(`${base}/${spec.visualizations[0].video}`))
    .then((r) => { log.context.ranges = r; });

  // Nothing plays until everything is loaded: a panel that started as soon as
  // it was individually ready would sit at frame 0 while the others advanced,
  // then jump when it caught up.
  const gate = new LoadGate();
  for (const panel of panels) gate.add(videoSource(panel.video, panel.vis.title));
  if (cloud) gate.add(cloud.loadSource());

  const bar = loadingBar(gate);
  const transportBar = controls(transport);

  clear(main);
  main.append(header(dataset, video, pipe, spec));
  for (const warning of spec.warnings || []) main.append(warningBanner(warning));
  main.append(bar);
  main.append(grid(panels, cloud, mesh, spec.layout));

  wire(transport, panels, cloud, log, mesh);

  const outcome = await gate.wait();
  log.event('gate', outcome, { seconds: +log.elapsed.toFixed(2) });
  bar.replaceWith(transportBar);
  if (outcome === 'timeout') {
    transportBar.prepend(el('span', { class: 'load-warn' },
      'Some panels are still loading — playback may drift until they finish.'));
  }
  // start from a common instant, not wherever each element happens to be
  for (const panel of panels) panel.seekSeconds(0);
  transport.setFrame(0);
  transport.setPlaying(true);
}

function header(dataset, video, pipe, spec) {
  return el('section', { class: 'viewer-head' },
    el('div', {},
      el('p', { class: 'eyebrow', text: `${dataset.name} · ${pipe.name}` }),
      el('h1', { class: 'display mono-display', text: video.id })),
    el('p', { class: 'viewer-meta' },
      `${spec.n_frames} frames`, el('span', { class: 'sep' }, '·'),
      `${Math.round(spec.video_fps)} fps source`, el('span', { class: 'sep' }, '·'),
      plural(spec.visualizations.length, 'visualization')));
}

/**
 * A page-level caveat about the data itself.
 *
 * Deliberately loud and above the transport: the failure this exists for -- a
 * miscalibrated focal length -- renders as perfectly clean geometry, so nothing
 * on screen would give it away.
 */
function warningBanner(warning) {
  return el('section', { class: `banner is-${warning.severity || 'high'}` },
    el('p', { class: 'banner-title' },
      el('span', { class: 'banner-mark', 'aria-hidden': 'true' }, '!'),
      warning.title),
    el('p', { class: 'banner-detail', text: warning.detail }));
}

function controls(transport) {
  const modeButtons = ['autoplay', 'frame'].map((mode) => el('button', {
    class: `seg${mode === transport.mode ? ' is-active' : ''}`,
    type: 'button', 'data-mode': mode,
    onclick: () => transport.setMode(mode),
  }, mode === 'autoplay' ? 'Autoplay' : 'Frame by frame'));

  const play = el('button', {
    class: 'ctl ctl-play', type: 'button',
    onclick: () => transport.togglePlaying(),
  }, 'Pause');

  const speed = el('select', {
    class: 'ctl-select', 'aria-label': 'Playback speed',
    onchange: (event) => transport.setSpeed(Number(event.target.value)),
  }, SPEEDS.map((s) => el('option', {
    value: String(s), selected: s === DEFAULT_SPEED,
  }, `${s}×`)));

  const slider = el('input', {
    class: 'frame-slider', type: 'range', min: '0',
    max: String(transport.nFrames - 1), value: '0', step: '1',
    'aria-label': 'Frame',
    oninput: (event) => transport.setFrame(Number(event.target.value)),
  });

  const readout = el('span', { class: 'frame-readout' });
  const stepper = (delta, label) => el('button', {
    class: 'ctl', type: 'button', onclick: () => transport.stepFrame(delta),
  }, label);

  const diag = el('button', {
    class: 'ctl ctl-diag', type: 'button',
    title: 'Copy a playback diagnostics report to the clipboard',
    onclick: async (event) => {
      const result = await window.syncLog?.copy();
      event.target.textContent = result === 'copied' ? 'Copied' : 'See console';
      if (result !== 'copied') window.syncLog?.dump();
      setTimeout(() => { event.target.textContent = 'Diagnostics'; }, 2000);
    },
  }, 'Diagnostics');

  const bar = el('section', { class: 'transport' },
    el('div', { class: 'seg-group', role: 'group', 'aria-label': 'Mode' },
      ...modeButtons),
    el('div', { class: 'transport-auto' },
      play,
      el('label', { class: 'ctl-label' }, 'Speed', speed),
      el('span', { class: 'ctl-hint', text: 'relative to real time' })),
    el('div', { class: 'transport-frame' },
      stepper(-1, '←'), stepper(1, '→'), slider, readout),
    el('div', { class: 'transport-diag' }, diag));

  const sync = () => {
    bar.classList.toggle('is-frame', transport.mode === 'frame');
    for (const button of modeButtons) {
      button.classList.toggle('is-active', button.dataset.mode === transport.mode);
    }
    play.textContent = transport.playing ? 'Pause' : 'Play';
    slider.value = String(transport.frame);
    const seconds = transport.frame / transport.fps;
    readout.textContent = `frame ${transport.frame} / ${transport.nFrames - 1}`
      + `  ·  ${seconds.toFixed(2)}s`;
  };
  for (const event of ['mode', 'frame', 'playing', 'speed']) {
    transport.addEventListener(event, sync);
  }
  sync();

  // Arrow keys step frames; space toggles playback.
  addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'ArrowLeft') { transport.setMode('frame'); transport.stepFrame(-1); }
    else if (event.key === 'ArrowRight') { transport.setMode('frame'); transport.stepFrame(1); }
    else if (event.key === ' ') { event.preventDefault(); transport.togglePlaying(); }
    else return;
    event.preventDefault?.();
  });

  return bar;
}

/**
 * Lay panels out as full-width shared rows and paired column rows.
 *
 * A row is flushed as soon as a column would receive a second panel, so the two
 * columns stay aligned even when one of them has nothing for that row -- a
 * missing panel becomes a placeholder in place rather than shifting every
 * later card up into the gap.
 */
function grid(panels, cloud, mesh, layout) {
  const wrap = el('div', { class: 'viz-grid' });
  // v1 has no variant split, so every row is full width and there are no
  // column headings to place.
  if (layout === 'single') {
    for (const panel of panels) {
      panel.node.classList.add('is-shared');
      wrap.append(panel.node);
    }
    if (mesh) wrap.append(mesh.node);
    if (cloud) wrap.append(cloud.node);
    return wrap;
  }
  let headsPlaced = false;
  let pending = {};

  const flush = () => {
    if (!Object.keys(pending).length) return;
    if (!headsPlaced) {
      for (const column of COLUMNS) {
        wrap.append(el('div', { class: 'col-head', 'data-col': column.id },
          el('span', { class: 'col-name', text: column.name }),
          el('span', { class: 'col-hint', text: column.hint })));
      }
      headsPlaced = true;
    }
    for (const column of COLUMNS) {
      wrap.append(pending[column.id] || el('div', { class: 'viz-card is-absent' },
        el('p', { class: 'viz-absent-text' },
          `No ${column.name.toLowerCase()} output for this clip.`)));
    }
    pending = {};
  };

  for (const panel of panels) {
    const column = panel.vis.column;
    if (!column) {
      flush();
      wrap.append(panel.node);
      continue;
    }
    if (pending[column]) flush();
    pending[column] = panel.node;
  }
  flush();
  if (mesh) wrap.append(mesh.node);
  if (cloud) wrap.append(cloud.node);
  return wrap;
}

/**
 * Drift between two positions on a looping timeline.
 *
 * These clips loop, so a plain subtraction reports a whole lap (±duration) the
 * instant one panel wraps before another. Treating that as real drift made the
 * supervisor seek a panel across the entire clip -- often to the very end,
 * where it immediately wrapped again, which is how a 3 ms difference turned
 * into seconds of desync at every loop boundary. Wrapping into
 * [-duration/2, +duration/2] makes a lap difference read as the few
 * milliseconds it actually is.
 */
export function wrappedDrift(a, b, duration) {
  const raw = a - b;
  if (!duration || !Number.isFinite(duration)) return raw;
  const wrapped = ((raw % duration) + duration) % duration;
  return wrapped > duration / 2 ? wrapped - duration : wrapped;
}

function wire(transport, panels, cloud, log, mesh) {
  transport.addEventListener('mode', () => panels.forEach((p) => {
    p.applyMode();
    p.applyPlaying();
  }));
  if (cloud) transport.addEventListener('mode', () => cloud.applyMode());
  if (mesh) transport.addEventListener('mode', () => mesh.applyMode());
  transport.addEventListener('speed', () => panels.forEach((p) => p.applyRate()));
  transport.addEventListener('playing', () => panels.forEach((p) => p.applyPlaying()));
  transport.addEventListener('frame', () => panels.forEach((p) => p.update()));
  panels.forEach((p) => { p.applyMode(); p.applyRate(); });

  const [master, ...rest] = panels;
  if (!master) return;

  const TOLERANCE = 0.25;   // seconds of drift before correcting
  const COOLDOWN = 700;     // ms between corrections of the same panel
  const lastFix = new Map();

  /**
   * Keep the panels together, on an animation frame rather than `timeupdate`.
   *
   * `timeupdate` stops firing when an element stalls, which froze the whole
   * page -- including the point cloud, which reads the frame from here. Three
   * rules matter:
   *  - never seek an element that is still buffering (readyState < 3); seeking
   *    mid-buffer is what made panels jitter back and forth a few frames;
   *  - rate-limit corrections per panel, so one slow panel cannot be seeked
   *    every frame;
   *  - restart anything that stalled, since a stall pauses the element and
   *    nothing else would ever resume it.
   */
  const supervise = () => {
    requestAnimationFrame(supervise);
    if (transport.mode !== 'autoplay') return;

    if (transport.playing) {
      for (const panel of panels) {
        if (panel.video.paused && panel.video.readyState >= 3) {
          log?.event(panel.vis.id, 'resume', { t: +panel.video.currentTime.toFixed(3) });
          panel.video.play().catch(() => { /* resumes on the next frame */ });
        }
      }
    }

    const t = master.video.currentTime;
    const now = performance.now();
    const duration = master.video.duration;
    for (const panel of rest) {
      const drift = wrappedDrift(panel.video.currentTime, t, duration);
      if (Math.abs(drift) <= TOLERANCE) continue;
      if (panel.video.readyState < 3) {
        log?.event(panel.vis.id, 'skip-correction',
          { drift: +drift.toFixed(3), rs: panel.video.readyState });
        continue;
      }
      if (now - (lastFix.get(panel) || 0) < COOLDOWN) continue;
      lastFix.set(panel, now);
      log?.event(panel.vis.id, 'correct',
        { drift: +drift.toFixed(3), to: +t.toFixed(3) });
      panel.seekSeconds(t);
    }
    transport.frame = Math.min(Math.round(t * transport.fps), transport.nFrames - 1);
  };
  requestAnimationFrame(supervise);
}
