import { el, clear, plural, seconds, uniqueLabels } from '../util.js';
import { href } from '../router.js';
import { assetURL } from '../config.js';

/** Video gallery: choose a clip. Each card previews the raw video. */
export function renderGallery(main, dataset) {
  clear(main);

  main.append(
    el('section', { class: 'lede' },
      el('p', { class: 'eyebrow', text: dataset.name }),
      el('h1', { class: 'display' }, 'Choose a clip'),
      el('p', { class: 'lede-text' },
        'Hover a card to play the source video; drag across it to scrub. ',
        'Labels are the categories the tracker was prompted with.')),
  );

  const grid = el('div', { class: 'clip-grid' });
  for (const video of dataset.videos) grid.append(clipCard(dataset, video));
  main.append(grid);
}

function clipCard(dataset, video) {
  const media = previewMedia(video);
  const objects = video.pipelines?.wilddet3d?.objects || [];
  const labels = uniqueLabels(objects);

  const chips = el('ul', { class: 'chips' },
    (labels.length ? labels : video.labels.map((l) => ({ label: l, color: null })))
      .map((obj) => el('li', { class: 'chip' },
        obj.color
          ? el('span', { class: 'chip-dot', style: { background: obj.color } })
          : null,
        obj.label)));

  const pills = el('ul', { class: 'pills' },
    dataset.pipelines.map((p) => {
      const state = video.pipelines?.[p.id] || {};
      return el('li', {
        class: `pill ${state.available ? 'is-ready' : 'is-pending'}`,
        title: state.available
          ? `${p.name} output is ready`
          : `${p.name}: ${state.reason || 'not available'}`,
      }, p.name);
    }));

  return el('a', {
    class: 'clip-card',
    href: href({ dataset: dataset.id, video: video.id }),
    'aria-label': `${video.id}, ${plural(objects.length, 'object')}`,
  },
  media,
  el('div', { class: 'clip-body' },
    el('div', { class: 'clip-head' },
      el('span', { class: 'clip-id', text: video.id }),
      el('span', { class: 'clip-dur', text: seconds(video.duration_s) })),
    chips,
    el('p', { class: 'clip-meta' },
      `${video.n_frames} frames`, el('span', { class: 'sep' }, '·'),
      `${video.width}×${video.height}`, el('span', { class: 'sep' }, '·'),
      `${Math.round(video.fps)} fps`),
    pills));
}

/**
 * Poster at rest; the source video plays on hover and seeks under the pointer.
 *
 * Seeking the real video rather than a sprite sheet keeps the preview honest --
 * what you scrub is the footage the tracker actually ran on.
 */
function previewMedia(video) {
  const { preview, poster } = video.media;

  const videoEl = el('video', {
    class: 'clip-video', loop: true, playsinline: true,
    preload: 'none', poster: assetURL(poster), tabindex: '-1',
  });
  videoEl.muted = true;

  const bar = el('span', { class: 'clip-bar' });
  const wrap = el('div', { class: 'clip-media' }, videoEl,
    el('div', { class: 'clip-track' }, bar));

  let loaded = false;
  let scrubbing = false;

  wrap.addEventListener('pointerenter', () => {
    if (!loaded) {
      loaded = true;
      videoEl.preload = 'auto';
      videoEl.src = assetURL(preview);
    }
    if (!scrubbing) videoEl.play().catch(() => { /* autoplay refused */ });
  });

  wrap.addEventListener('pointermove', (event) => {
    if (!videoEl.duration) return;
    // Take over only once the pointer has actually travelled, so merely
    // crossing a card leaves it playing.
    if (!scrubbing && Math.abs(event.movementX) < 3) return;
    scrubbing = true;
    videoEl.pause();
    const rect = wrap.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    videoEl.currentTime = fraction * videoEl.duration;
    bar.style.transform = `scaleX(${fraction})`;
  });

  const reset = () => {
    scrubbing = false;
    bar.style.transform = 'scaleX(0)';
    videoEl.pause();
    if (loaded) videoEl.currentTime = 0;
  };
  wrap.addEventListener('pointerleave', reset);
  wrap.addEventListener('pointercancel', reset);

  videoEl.addEventListener('timeupdate', () => {
    if (scrubbing || !videoEl.duration) return;
    bar.style.transform = `scaleX(${videoEl.currentTime / videoEl.duration})`;
  });

  return wrap;
}
