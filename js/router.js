/**
 * Hash routing.
 *
 * Hash routes rather than real paths so deep links survive on GitHub Pages,
 * which has no rewrite rules and would 404 on a refreshed sub-path.
 *
 *   #/                        datasets
 *   #/sav                     videos in a dataset
 *   #/sav/sav_002845          pipelines for a video
 *   #/sav/sav_002845/wilddet3d   the visualization
 */

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const [dataset, video, pipeline] = segments;
  return { segments, dataset, video, pipeline, query };
}

export function href({ dataset, video, pipeline, query } = {}) {
  const parts = [dataset, video, pipeline].filter(Boolean).map(encodeURIComponent);
  const qs = query ? new URLSearchParams(query).toString() : '';
  return `#/${parts.join('/')}${qs ? `?${qs}` : ''}`;
}

export function navigate(target) {
  location.hash = typeof target === 'string' ? target : href(target);
}

export function startRouter(onRoute) {
  const run = () => onRoute(parseHash());
  addEventListener('hashchange', run);
  run();
}
