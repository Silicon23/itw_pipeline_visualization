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
      el('div', { class: 'viz-actions' },
        el('span', { class: 'viz-rate', text: `${formatRate(vis.content_fps)} fps` }),
        ...this.downloadButtons())),
    this.stage,
    vis.note ? el('p', { class: 'viz-note', text: vis.note }) : null);
  }

  /**
   * Download this overlay: the full clip, full resolution, at its real frame
   * rate. The mp4 on disk already is exactly that -- the 0.5x is a playbackRate
   * applied in the browser, never baked into the file -- so this hands over the
   * existing asset rather than re-encoding anything.
   *
   * A GIF is offered too, but only when the build produced one (`--gifs`):
   * GIF runs ~15x the mp4 for identical pixels.
   */
  downloadButtons() {
    const [, videoId, pipelineId] = this.base.split('/');
    const stem = `${videoId}_${pipelineId}_${this.vis.id}`;
    const buttons = [this.downloadButton('MP4', `${this.base}/${this.vis.video}`,
      `${stem}.mp4`)];
    if (this.vis.gif) {
      buttons.push(this.downloadButton('GIF', `${this.base}/${this.vis.gif}`,
        `${stem}.gif`, this.vis.gif_bytes));
    }
    return buttons;
  }

  downloadButton(label, path, filename, bytes = 0) {
    const url = assetURL(path);
    const button = el('a', {
      class: 'viz-dl',
      href: url,
      download: filename,
      title: `Download ${filename}${bytes ? ` (${(bytes / 1048576).toFixed(0)} MB)` : ''}`
        + ' — full length, full resolution, real-time frame rate',
    }, label);

    button.addEventListener('click', async (event) => {
      // The `download` attribute is ignored for cross-origin URLs, so on the
      // hosted site a plain link would open the video in the tab instead of
      // saving it. Fetching to a blob keeps the filename correct everywhere;
      // if that fails for any reason the default navigation still runs.
      if (button.dataset.busy) { event.preventDefault(); return; }
      event.preventDefault();
      button.dataset.busy = '1';
      const original = button.textContent;
      button.textContent = '…';
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status}`);
        const blob = await response.blob();
        const objectURL = URL.createObjectURL(blob);
        const link = el('a', { href: objectURL, download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        // Revoke on the next tick; revoking immediately can cancel the save.
        setTimeout(() => URL.revokeObjectURL(objectURL), 10_000);
        button.textContent = '✓';
      } catch {
        window.open(url, '_blank', 'noopener');
        button.textContent = original;
      } finally {
        delete button.dataset.busy;
        setTimeout(() => { button.textContent = original; }, 1500);
      }
    });
    return button;
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
