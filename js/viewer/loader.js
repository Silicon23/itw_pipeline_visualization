import { el } from '../util.js';

/**
 * Hold playback until every visualization is loaded.
 *
 * Panels used to start as soon as they individually became playable, so a tile
 * that was still fetching sat at frame 0 while the others advanced, then jumped
 * when it caught up. Nothing starts until all sources report ready.
 *
 * A source that errors counts as ready: one missing overlay should not strand
 * the whole page.
 */

const GRACE_MS = 90_000;   // start anyway rather than hang forever

const FULL = 0.995;        // treat this much buffered as "the whole clip"
const SETTLE_MS = 8000;    // how long to keep waiting for a full buffer

function buffered(video) {
  const { duration, buffered: ranges } = video;
  if (!duration || !Number.isFinite(duration) || !ranges.length) return 0;
  let covered = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    covered += ranges.end(i) - ranges.start(i);
  }
  return Math.min(covered / duration, 1);
}

/**
 * Ready when the clip is *fully buffered*, not merely playable.
 *
 * `canplaythrough` is the browser's optimistic guess that it can keep ahead of
 * playback. On a slow link that guess is wrong, the element stalls mid-play, and
 * the sync correction then thrashes it back and forth. Waiting for the bytes
 * removes the stall entirely. If the browser decides to stop short of a full
 * buffer, fall back to canplaythrough after a settle period rather than hanging.
 */
export function videoSource(video, label) {
  video.preload = 'auto';
  const ready = new Promise((resolve) => {
    const check = () => {
      if (buffered(video) >= FULL) { cleanup(); resolve(); }
    };
    const settle = () => setTimeout(() => { cleanup(); resolve(); }, SETTLE_MS);
    const cleanup = () => {
      video.removeEventListener('progress', check);
      video.removeEventListener('canplaythrough', onPlayable);
    };
    const onPlayable = () => { check(); settle(); };

    video.addEventListener('progress', check);
    video.addEventListener('canplaythrough', onPlayable);
    video.addEventListener('error', () => { cleanup(); resolve(); }, { once: true });
    check();
    if (video.readyState >= 4) onPlayable();
  });

  const progress = () => Math.min(buffered(video) / FULL, 1);
  // Kick off buffering only if nothing has started; calling load() on an
  // in-flight fetch restarts it from scratch.
  if (video.readyState === 0) video.load();
  return { label, ready, progress };
}

export class LoadGate extends EventTarget {
  constructor() {
    super();
    this.sources = [];
    this.settled = 0;
  }

  add(source) {
    this.sources.push(source);
    source.ready.then(() => {
      this.settled += 1;
      this.dispatchEvent(new CustomEvent('progress'));
    });
    return source;
  }

  get fraction() {
    if (!this.sources.length) return 1;
    const total = this.sources.reduce((sum, s) => sum + Math.min(s.progress(), 1), 0);
    return total / this.sources.length;
  }

  get ready() { return this.settled; }

  get total() { return this.sources.length; }

  /** Resolves when everything is loaded, or when the grace period expires. */
  async wait() {
    const tick = setInterval(
      () => this.dispatchEvent(new CustomEvent('progress')), 120);
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), GRACE_MS));
    const outcome = await Promise.race([
      Promise.all(this.sources.map((s) => s.ready)).then(() => 'complete'),
      timeout,
    ]);
    clearInterval(tick);
    this.dispatchEvent(new CustomEvent('progress'));
    return outcome;
  }
}

/** The loading panel shown in place of the transport until everything is in. */
export function loadingBar(gate) {
  const fill = el('span', { class: 'load-fill' });
  const pct = el('span', { class: 'load-pct', text: '0%' });
  const count = el('span', { class: 'load-count' });

  const node = el('section', { class: 'loading' },
    el('div', { class: 'load-head' },
      el('span', { class: 'load-label', text: 'Loading visualizations' }),
      count, pct),
    el('div', { class: 'load-track' }, fill),
    el('p', { class: 'load-hint' },
      'Playback starts once every panel is loaded, so they stay in sync.'));

  const sync = () => {
    const f = Math.max(0, Math.min(gate.fraction, 1));
    fill.style.transform = `scaleX(${f})`;
    pct.textContent = `${Math.round(f * 100)}%`;
    count.textContent = `${gate.ready} of ${gate.total} ready`;
  };
  gate.addEventListener('progress', sync);
  sync();
  return node;
}
