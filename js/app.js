import { dataURL } from './config.js';
import { href, parseHash, startRouter } from './router.js';
import { clear, el, statusMessage } from './util.js';
import { renderLanding } from './pages/landing.js';
import { renderGallery } from './pages/gallery.js';
import { renderPipelinePicker } from './pages/pipeline.js';
import { renderViewer } from './pages/viewer.js';

const main = document.getElementById('main');
const crumbs = document.getElementById('crumbs');

let index = null;

async function boot() {
  statusMessage(main, 'Loading…');
  try {
    const response = await fetch(dataURL('index.json'), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`index.json returned ${response.status}`);
    index = await response.json();
  } catch (error) {
    statusMessage(main, 'Could not load the clip index.',
      `${error.message}. Run builder/build_site.py, then serve visualization/site.`);
    return;
  }
  startRouter(route);
}

function route({ dataset: dsId, video: videoId, pipeline: pipeId }) {
  const dataset = index.datasets.find((d) => d.id === dsId);
  const video = dataset?.videos.find((v) => v.id === videoId);
  const pipe = dataset?.pipelines.find((p) => p.id === pipeId);

  if (!dsId) {
    renderLanding(main, index);
  } else if (!dataset) {
    notFound(`No dataset named "${dsId}".`);
  } else if (!videoId) {
    renderGallery(main, dataset);
  } else if (!video) {
    notFound(`No clip named "${videoId}" in ${dataset.name}.`);
  } else if (!pipeId) {
    renderPipelinePicker(main, dataset, video);
  } else if (!pipe) {
    notFound(`No pipeline named "${pipeId}".`);
  } else if (!video.pipelines?.[pipe.id]?.available) {
    notFound(`${pipe.name} has no output for ${video.id} yet.`);
  } else {
    renderViewer(main, dataset, video, pipe);
  }

  renderCrumbs({ dataset, video, pipe });
  main.focus({ preventScroll: true });
  scrollTo({ top: 0 });
}

function notFound(detail) {
  statusMessage(main, 'Nothing here.', detail);
}

function renderCrumbs({ dataset, video, pipe }) {
  clear(crumbs);
  // The path really is a sequence -- dataset, then clip, then pipeline -- so the
  // trail doubles as a progress indicator.
  const trail = [
    { label: 'Datasets', to: href({}) },
    dataset && { label: dataset.name, to: href({ dataset: dataset.id }) },
    video && {
      label: video.id, mono: true,
      to: href({ dataset: dataset.id, video: video.id }),
    },
    pipe && {
      label: pipe.name,
      to: href({ dataset: dataset.id, video: video.id, pipeline: pipe.id }),
    },
  ].filter(Boolean);

  trail.forEach((step, i) => {
    const last = i === trail.length - 1;
    if (i > 0) crumbs.append(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    crumbs.append(last
      ? el('span', { class: `crumb is-current${step.mono ? ' mono' : ''}`, 'aria-current': 'page', text: step.label })
      : el('a', { class: `crumb${step.mono ? ' mono' : ''}`, href: step.to, text: step.label }));
  });
}

// A stale hash from a previous session should not land on a blank page.
if (!location.hash) location.replace(`${location.pathname}${location.search}#/`);
boot();

export { parseHash };
