import { el } from '../util.js';
import { assetURL } from '../config.js';
import { resolveFrame, stillURL } from './transport.js';

/**
 * One visualization tile: a video in autoplay mode, a still in frame mode.
 *
 * Both elements stay in the DOM and swap visibility, so switching modes does
 * not re-download anything.
 */
export class Panel {
  constructor(vis, base, transport) {
    this.vis = vis;
    this.base = base;
    this.transport = transport;

    this.video = el('video', {
      class: 'viz-video', loop: true, playsinline: true, preload: 'auto',
      muted: true, src: assetURL(`${base}/${vis.video}`),
    });
    this.video.muted = true;

    this.still = el('img', { class: 'viz-still', alt: '', decoding: 'async' });
    this.fallback = el('div', { class: 'viz-fallback' });
    this.badge = el('span', { class: 'viz-badge' });

    this.stage = el('div', { class: 'viz-stage' },
      this.video, this.still, this.fallback, this.badge);

    // Size the stage to the render's own aspect. Without this a portrait clip
    // is letterboxed into a wide card and most of the tile is black. The shared
    // card is given more height because it spans both columns and is the
    // reference everything else is compared against.
    if (vis.width && vis.height) {
      const aspect = vis.width / vis.height;
      const maxHeightVh = vis.column ? 62 : 80;
      this.stage.style.aspectRatio = `${vis.width} / ${vis.height}`;
      this.stage.style.maxWidth = `${(aspect * maxHeightVh).toFixed(1)}vh`;
    }

    this.node = el('article', {
      class: `viz-card${vis.column ? '' : ' is-shared'}`,
      'data-viz': vis.id,
    },
    el('header', { class: 'viz-head' },
      el('div', {},
        el('h3', { class: 'viz-title', text: vis.title }),
        el('p', { class: 'viz-sub', text: vis.subtitle })),
      el('span', { class: 'viz-rate', text: `${formatRate(vis.content_fps)} fps` })),
    this.stage,
    vis.note ? el('p', { class: 'viz-note', text: vis.note }) : null);
  }

  applyMode() {
    const frameMode = this.transport.mode === 'frame';
    this.stage.classList.toggle('is-frame', frameMode);
    if (frameMode) {
      this.video.pause();
      this.update();
    } else {
      this.fallback.textContent = '';
      this.badge.textContent = '';
      this.applyRate();
    }
  }

  applyRate() {
    this.video.playbackRate = this.transport.speed;
  }

  applyPlaying() {
    if (this.transport.mode !== 'autoplay') return;
    if (this.transport.playing) {
      this.video.play().catch(() => { /* autoplay blocked until interaction */ });
    } else {
      this.video.pause();
    }
  }

  /** Seek all panels to the same wall-clock instant. */
  seekSeconds(seconds) {
    if (Number.isFinite(seconds)) this.video.currentTime = seconds;
  }

  /** Frame mode: show the right still, and say plainly if it is not exact. */
  update() {
    if (this.transport.mode !== 'frame') return;
    const r = resolveFrame(this.vis, this.transport.frame);

    if (r.state === 'missing' || r.state === 'before') {
      this.still.removeAttribute('src');
      this.stage.classList.add('is-empty');
      this.badge.textContent = '';
      this.fallback.textContent = r.state === 'before'
        ? `Nothing here yet — this visualization starts at frame ${r.firstFrame}.`
        : 'This visualization has no frames.';
      return;
    }

    this.stage.classList.remove('is-empty');
    this.fallback.textContent = '';
    const url = assetURL(`${this.base}/${stillURL(this.vis, r.frame)}`);
    if (this.still.getAttribute('src') !== url) this.still.src = url;

    if (r.state === 'empty') {
      this.badge.textContent = `frame ${r.frame} · nothing detected`;
    } else if (r.state === 'held') {
      this.badge.textContent = `held from frame ${r.heldFrom}`;
    } else {
      this.badge.textContent = `frame ${r.frame}`;
    }
  }
}

function formatRate(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
