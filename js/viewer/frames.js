/**
 * Bounded, prefetching cache of decoded depth + colour frames.
 *
 * Holding every frame as an ImageBitmap would cost well over a hundred MB of
 * GPU-backed memory for a 240-frame clip, so decoded frames are kept in a small
 * LRU around the playhead and the rest are fetched on demand. Decode of a
 * 344x192 image is ~1 ms, so a modest lookahead keeps playback smooth.
 */

const CAPACITY = 56;
const LOOKAHEAD = 20;
// The cloud shares the connection with five video streams. Unbounded prefetch
// piles up dozens of concurrent requests and starves them, which shows up as
// video stalls rather than as a slow point cloud.
const MAX_INFLIGHT = 6;

export class FrameCache {
  constructor(base, manifest) {
    this.base = base;
    this.frames = manifest.vggt_frame_indices;
    this.cache = new Map();       // frame -> {depth, rgb}
    this.pending = new Map();     // frame -> Promise
  }

  url(kind, frame) {
    const name = String(frame).padStart(6, '0');
    return `${this.base}/${kind}/${name}.${kind === 'depth' ? 'webp' : 'jpg'}`;
  }

  async load(frame) {
    if (this.cache.has(frame)) return this.cache.get(frame);
    if (this.pending.has(frame)) return this.pending.get(frame);

    const job = (async () => {
      const [depth, rgb] = await Promise.all(
        ['depth', 'rgb'].map(async (kind) => {
          const response = await fetch(this.url(kind, frame));
          if (!response.ok) throw new Error(`${kind} ${frame}: ${response.status}`);
          return createImageBitmap(await response.blob());
        }),
      );
      const entry = { depth, rgb };
      this.cache.set(frame, entry);
      this.pending.delete(frame);
      this.evict();
      return entry;
    })();

    this.pending.set(frame, job);
    return job;
  }

  /** Drop the frames furthest from the playhead once over capacity. */
  evict() {
    if (this.cache.size <= CAPACITY) return;
    const here = this.playhead ?? 0;
    const ordered = [...this.cache.keys()].sort(
      (a, b) => Math.abs(b - here) - Math.abs(a - here));
    for (const frame of ordered.slice(0, this.cache.size - CAPACITY)) {
      const entry = this.cache.get(frame);
      entry.depth.close?.();
      entry.rgb.close?.();
      this.cache.delete(frame);
    }
  }

  get(frame) {
    return this.cache.get(frame) || null;
  }

  /**
   * The closest cached frame at or before `frame`, within `window`.
   *
   * When prefetch cannot keep up, showing a slightly older frame keeps the
   * cloud moving. Holding the last successfully-loaded frame instead makes it
   * look frozen -- which is exactly what it did.
   */
  nearest(frame, window = 48) {
    for (let i = 0; i <= window; i += 1) {
      const entry = this.cache.get(frame - i);
      if (entry) return { entry, frame: frame - i };
    }
    return null;
  }

  /** Warm the frames just ahead of the playhead, in order, within the cap. */
  prefetch(frame, stride = 1) {
    this.playhead = frame;
    const last = this.frames[this.frames.length - 1];
    for (let i = 0; i < LOOKAHEAD; i += 1) {
      if (this.pending.size >= MAX_INFLIGHT) break;
      const next = frame + i * stride;
      if (next > last) break;
      if (!this.cache.has(next) && !this.pending.has(next)) {
        this.load(next).catch(() => { /* a gap is survivable; keep the old frame */ });
      }
    }
  }

  /**
   * Warm the opening frames so the cloud can start in step with the videos.
   *
   * Capped at the cache size: warming more than fits would evict the very
   * frames we are about to play.
   */
  warm(count) {
    const wanted = this.frames.slice(0, Math.min(count, CAPACITY));
    let done = 0;
    const jobs = wanted.map((frame) => this.load(frame)
      .catch(() => null)
      .then(() => { done += 1; }));
    return {
      label: 'point cloud',
      ready: Promise.all(jobs),
      progress: () => (wanted.length ? done / wanted.length : 1),
    };
  }

  dispose() {
    for (const entry of this.cache.values()) {
      entry.depth.close?.();
      entry.rgb.close?.();
    }
    this.cache.clear();
    this.pending.clear();
  }
}
