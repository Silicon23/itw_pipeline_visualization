import { el, clear, plural, uniqueLabels } from '../util.js';
import { href } from '../router.js';
import { assetURL } from '../config.js';

/** What each pipeline is, in the reviewer's terms rather than the code's. */
const BLURB = {
  foundationpose: {
    tagline: 'v1 · mesh-and-pose',
    what: 'Tracks a 2D mask with SAM3, reconstructs a per-frame mesh with SAM 3D '
        + 'Objects, then fits a 6-DoF pose with FoundationPose.',
    depth: 'Depth and camera from RADIO-ViPE',
  },
  wilddet3d: {
    tagline: 'v2 · prompt-and-detect',
    what: 'Tracks 2D points with CoTracker, then prompts a pretrained WildDet3D '
        + 'with those points, the category label, metric depth and intrinsics.',
    depth: 'Depth and camera from VGGT-Omega',
  },
};

/** Pipeline picker: choose what to look at for one clip. */
export function renderPipelinePicker(main, dataset, video) {
  clear(main);

  const objects = video.pipelines?.wilddet3d?.objects || [];
  const labels = uniqueLabels(objects).map((o) => o.label);

  main.append(
    el('section', { class: 'lede lede-split' },
      el('div', {},
        el('p', { class: 'eyebrow', text: dataset.name }),
        el('h1', { class: 'display mono-display', text: video.id }),
        el('p', { class: 'lede-text' },
          `${video.n_frames} frames at ${Math.round(video.fps)} fps`,
          el('span', { class: 'sep' }, '·'),
          `${video.width}×${video.height}`,
          labels.length ? el('span', { class: 'sep' }, '·') : null,
          labels.length ? plural(objects.length, 'tracked object') : null),
        video.note ? el('p', { class: 'note', text: video.note }) : null),
      el('figure', { class: 'lede-figure' },
        el('img', {
          src: assetURL(video.media.poster), alt: `First frame of ${video.id}`,
          loading: 'lazy',
        }))),
  );

  main.append(el('h2', { class: 'section-title' }, 'Choose a pipeline'));

  const grid = el('div', { class: 'pipeline-grid' });
  for (const pipe of dataset.pipelines) {
    grid.append(pipelineCard(dataset, video, pipe));
  }
  main.append(grid);
}

function pipelineCard(dataset, video, pipe) {
  const state = video.pipelines?.[pipe.id] || {};
  const blurb = BLURB[pipe.id] || { tagline: pipe.version, what: '', depth: '' };
  const ready = Boolean(state.available);

  const body = [
    el('p', { class: 'pipeline-tagline', text: blurb.tagline }),
    el('h3', { class: 'pipeline-name', text: pipe.name }),
    el('p', { class: 'pipeline-what', text: blurb.what }),
    el('p', { class: 'pipeline-depth', text: blurb.depth }),
  ];

  if (ready) {
    const objects = state.objects || [];
    body.push(
      el('ul', { class: 'chips chips-tight' },
        objects.map((obj) => el('li', { class: 'chip' },
          el('span', { class: 'chip-dot', style: { background: obj.color } }),
          obj.label,
          el('span', { class: 'chip-count', text: `${obj.n_frames}f` })))),
      el('p', { class: 'pipeline-variants' },
        (state.variants || []).length
          ? `Variants: ${state.variants.join(', ')}`
          : 'Single run'),
      el('span', { class: 'cta' }, 'Open visualization',
        el('span', { class: 'cta-arrow', 'aria-hidden': 'true' }, '→')),
    );
    return el('a', {
      class: 'pipeline-card is-ready',
      href: href({ dataset: dataset.id, video: video.id, pipeline: pipe.id }),
    }, ...body);
  }

  body.push(
    el('p', { class: 'pipeline-blocked' },
      el('span', { class: 'dot-pending', 'aria-hidden': 'true' }),
      state.reason || 'No output for this clip yet'),
    el('p', { class: 'fineprint' },
      'This pipeline has not been run on this dataset. Nothing to show until it is.'),
  );
  return el('div', {
    class: 'pipeline-card is-pending', 'aria-disabled': 'true',
  }, ...body);
}
