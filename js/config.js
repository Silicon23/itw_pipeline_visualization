/**
 * Where the heavy assets live.
 *
 * Small files (index.json, manifests, boxes) ship with the site. Frame images
 * and overlay videos are large, so they can be served from elsewhere -- set
 * ASSET_BASE to a Hugging Face dataset `resolve` URL for the published site,
 * or leave it relative to serve everything locally.
 *
 * HF works as a browser CDN: the resolve endpoint echoes the requesting origin
 * in access-control-allow-origin, answers CORS preflight with
 * access-control-allow-headers: range, and its CDN redirect returns 206 with
 * access-control-allow-origin: *.
 */

const HOSTED = location.hostname.endsWith('github.io');

export const HF_DATASET = 'Silicon23/itw_pipeline_visualization';

export const ASSET_BASE = HOSTED
  ? `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/assets/`
  // served through site/assets -> ../hf_dataset/assets when running locally
  : 'assets/';

export const DATA_BASE = 'data/';

export function assetURL(path) {
  return ASSET_BASE + String(path).replace(/^\/+/, '');
}

export function dataURL(path) {
  return DATA_BASE + String(path).replace(/^\/+/, '');
}
