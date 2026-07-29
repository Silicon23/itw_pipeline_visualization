import { el, clear, plural, statusMessage } from '../util.js';
import { assetURL } from '../config.js';
import { Transport, SPEEDS, DEFAULT_SPEED } from '../viewer/transport.js';
import { Panel } from '../viewer/panel.js';

const COLUMNS = [
  { id: 'box', name: 'Box prompt', hint: 'Prompted with the tight box around each GT mask' },
  { id: 'point', name: 'Point prompt', hint: 'Prompted with CoTracker point tracks' },
];

/** The v2 visualization page. */
export async function renderViewer(main, dataset, video, pipe) {
  const base = `${dataset.id}/${video.id}/${pipe.id}`;
  statusMessage(main, 'Loading visualizations…');

  let spec;
  try {
    const response = await fetch(assetURL(`${base}/visualizations.json`),
      { cache: 'no-cache' });
    if (!response.ok) throw new Error(`visualizations.json returned ${response.status}`);
    spec = await response.json();
  } catch (error) {
    statusMessage(main, 'No visualizations built for this clip yet.',
      `${error.message}. Run: build_site.py --assets --videos ${video.id}`);
    return;
  }

  const transport = new Transport({ nFrames: spec.n_frames, fps: spec.video_fps });
  const panels = spec.visualizations.map((vis) => new Panel(vis, base, transport));

  clear(main);
  main.append(header(dataset, video, pipe, spec));
  main.append(controls(transport));
  main.append(grid(panels));

  wire(transport, panels);
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

  const bar = el('section', { class: 'transport' },
    el('div', { class: 'seg-group', role: 'group', 'aria-label': 'Mode' },
      ...modeButtons),
    el('div', { class: 'transport-auto' },
      play,
      el('label', { class: 'ctl-label' }, 'Speed', speed),
      el('span', { class: 'ctl-hint', text: 'relative to real time' })),
    el('div', { class: 'transport-frame' },
      stepper(-1, '←'), stepper(1, '→'), slider, readout));

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

function grid(panels) {
  const wrap = el('div', { class: 'viz-grid' });
  const heads = COLUMNS.map((c) => el('div', {
    class: 'col-head', 'data-col': c.id,
  },
  el('span', { class: 'col-name', text: c.name }),
  el('span', { class: 'col-hint', text: c.hint })));

  let headsPlaced = false;
  for (const panel of panels) {
    if (panel.vis.column && !headsPlaced) {
      wrap.append(...heads);
      headsPlaced = true;
    }
    wrap.append(panel.node);
  }
  // A column with no visualization still needs its slot filled, or the grid
  // pulls the next row's card up into the gap.
  for (const column of COLUMNS) {
    if (!panels.some((p) => p.vis.column === column.id)) {
      wrap.append(el('div', { class: 'viz-card is-absent' },
        el('p', { class: 'viz-absent-text' },
          `No ${column.name.toLowerCase()} output for this clip.`)));
    }
  }
  return wrap;
}

function wire(transport, panels) {
  transport.addEventListener('mode', () => panels.forEach((p) => {
    p.applyMode();
    p.applyPlaying();
  }));
  transport.addEventListener('speed', () => panels.forEach((p) => p.applyRate()));
  transport.addEventListener('playing', () => panels.forEach((p) => p.applyPlaying()));
  transport.addEventListener('frame', () => panels.forEach((p) => p.update()));
  panels.forEach((p) => { p.applyMode(); p.applyRate(); });

  // Keep the panels together. Every overlay is encoded to the same duration, so
  // any drift is decoder jitter -- nudge rather than hard-seek, which would
  // stutter.
  const [master, ...rest] = panels;
  if (!master) return;
  master.video.addEventListener('timeupdate', () => {
    if (transport.mode !== 'autoplay') return;
    const t = master.video.currentTime;
    for (const panel of rest) {
      if (Math.abs(panel.video.currentTime - t) > 0.15) panel.seekSeconds(t);
    }
    transport.frame = Math.min(Math.round(t * transport.fps), transport.nFrames - 1);
  });
  // Looping the master must restart the others, or they drift apart each loop.
  master.video.addEventListener('seeked', () => {
    if (transport.mode === 'autoplay') {
      rest.forEach((p) => p.seekSeconds(master.video.currentTime));
    }
  });
}
