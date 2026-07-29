import { el, clear, plural, seconds } from '../util.js';
import { href } from '../router.js';
import { assetURL } from '../config.js';

/** Landing page: choose a dataset. */
export function renderLanding(main, index) {
  clear(main);

  main.append(
    el('section', { class: 'lede' },
      el('p', { class: 'eyebrow', text: 'Review' }),
      el('h1', { class: 'display' }, 'Tracking output, ', el('em', {}, 'clip by clip')),
      el('p', { class: 'lede-text' },
        'Every clip here has been through the tracker: an RGB video and a text ',
        'label go in, a per-frame 3D box trajectory comes out. Pick a dataset to ',
        'see its examples, then compare what each pipeline made of them.')),
  );

  const grid = el('div', { class: 'dataset-grid' });
  for (const ds of index.datasets) {
    grid.append(datasetCard(ds));
  }
  main.append(grid);
}

function datasetCard(ds) {
  const videos = ds.videos || [];
  const objects = videos.reduce((sum, v) => {
    const wd = v.pipelines?.wilddet3d;
    return sum + (wd?.n_objects || 0);
  }, 0);
  const duration = videos.reduce((sum, v) => sum + (v.duration_s || 0), 0);

  // A mosaic of the actual clips reads faster than any icon would.
  const mosaic = el('div', { class: 'mosaic', 'aria-hidden': 'true' },
    videos.slice(0, 6).map((v) => el('span', {
      class: 'mosaic-cell',
      style: { backgroundImage: `url("${assetURL(v.media.poster)}")` },
    })));

  return el('a', { class: 'dataset-card', href: href({ dataset: ds.id }) },
    mosaic,
    el('div', { class: 'dataset-body' },
      el('h2', { class: 'dataset-name', text: ds.name }),
      el('p', { class: 'dataset-desc' },
        'In-the-wild video with mask tracklets and persistent object identities. ',
        `${plural(videos.length, 'clip')} selected for review.`),
      el('dl', { class: 'stats' },
        stat('Clips', videos.length),
        stat('Pipelines', (ds.pipelines || []).length),
        stat('Objects', objects),
        stat('Runtime', seconds(duration))),
      ds.license ? el('p', { class: 'fineprint', text: ds.license }) : null,
      el('span', { class: 'cta' }, 'Browse clips',
        el('span', { class: 'cta-arrow', 'aria-hidden': 'true' }, '→'))));
}

function stat(label, value) {
  return el('div', { class: 'stat' },
    el('dt', { class: 'stat-label', text: label }),
    el('dd', { class: 'stat-value', text: String(value) }));
}
