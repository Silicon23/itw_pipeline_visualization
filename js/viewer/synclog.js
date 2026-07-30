/**
 * Playback diagnostics.
 *
 * Records what each panel actually did -- stalls, seeks, drift, buffering --
 * so a sync problem can be read off a log instead of guessed at. Always on;
 * the cost is a bounded ring buffer and one sample every 500 ms.
 *
 * From the console:
 *   syncLog.dump()    formatted report
 *   syncLog.copy()    same, onto the clipboard
 *   syncLog.json()    raw records
 */

const MAX_EVENTS = 3000;
const SAMPLE_MS = 500;

const MEDIA_EVENTS = [
  'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'play', 'playing',
  'pause', 'ratechange', 'ended', 'error', 'canplaythrough', 'emptied',
];

function bufferedEnd(video) {
  const { buffered } = video;
  return buffered.length ? buffered.end(buffered.length - 1) : 0;
}

function coverage(video) {
  const { duration, buffered } = video;
  if (!duration || !Number.isFinite(duration) || !buffered.length) return 0;
  let total = 0;
  for (let i = 0; i < buffered.length; i += 1) total += buffered.end(i) - buffered.start(i);
  return total / duration;
}

export class SyncLog {
  constructor(context = {}) {
    this.t0 = performance.now();
    this.context = context;
    this.events = [];
    this.samples = [];
    this.panels = [];
    this.cloud = null;
    this.counts = new Map();      // "panel|kind" -> n
  }

  get elapsed() { return (performance.now() - this.t0) / 1000; }

  event(panel, kind, detail) {
    const key = `${panel}|${kind}`;
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.events.push({ t: +this.elapsed.toFixed(3), panel, kind, detail });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, 500);
  }

  /** Attach to a panel's media element and record everything it reports. */
  watch(panel) {
    const name = panel.vis.id;
    this.panels.push(panel);
    for (const kind of MEDIA_EVENTS) {
      panel.video.addEventListener(kind, () => {
        this.event(name, kind, {
          t: +panel.video.currentTime.toFixed(3),
          rs: panel.video.readyState,
        });
      });
    }
  }

  watchCloud(cloud) { this.cloud = cloud; }

  start() {
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  stop() { clearInterval(this.timer); }

  sample() {
    if (!this.panels.length) return;
    const master = this.panels[0].video;
    const span = master.duration;
    // Wrapped, for the same reason the supervisor wraps: on a looping clip a
    // plain difference reports a whole lap the moment one panel wraps first.
    const drift = (t) => {
      const raw = t - master.currentTime;
      if (!span || !Number.isFinite(span)) return raw;
      const w = ((raw % span) + span) % span;
      return w > span / 2 ? w - span : w;
    };
    const row = {
      t: +this.elapsed.toFixed(2),
      master: +master.currentTime.toFixed(3),
      panels: this.panels.map((p) => ({
        id: p.vis.id,
        t: +p.video.currentTime.toFixed(3),
        d: +drift(p.video.currentTime).toFixed(3),
        rs: p.video.readyState,
        paused: p.video.paused,
        buf: +bufferedEnd(p.video).toFixed(2),
        cov: +coverage(p.video).toFixed(3),
        rate: p.video.playbackRate,
      })),
    };
    if (this.cloud) {
      const v = this.cloud.viewer;
      row.cloud = {
        frame: v.current,
        shown: v.shown,            // lags `frame` when prefetch falls behind
        lag: (v.current ?? 0) - (v.shown ?? 0),
        starved: v.starved || 0,   // cumulative frames wanted but not cached
        cached: v.cache.cache.size,
        pending: v.cache.pending.size,
        density: v.density,
        stride: v.stride,
      };
    }
    this.samples.push(row);
    if (this.samples.length > 600) this.samples.splice(0, 100);
  }

  /** Worst absolute drift each panel reached, and when. */
  worstDrift() {
    const worst = new Map();
    for (const row of this.samples) {
      for (const p of row.panels) {
        const prev = worst.get(p.id);
        if (!prev || Math.abs(p.d) > Math.abs(prev.d)) worst.set(p.id, { ...p, t: row.t });
      }
    }
    return worst;
  }

  report() {
    const lines = [];
    const ctx = this.context;
    lines.push('=== playback diagnostics ===');
    lines.push(`clip        : ${ctx.video || '?'} / ${ctx.pipeline || '?'}`);
    lines.push(`assets      : ${ctx.assetBase || '?'}`);
    lines.push(`ranges      : ${ctx.ranges === undefined ? 'unknown' : ctx.ranges}`);
    lines.push(`elapsed     : ${this.elapsed.toFixed(1)}s, ${this.samples.length} samples`);
    lines.push(`ua          : ${navigator.userAgent}`);
    if (this.samples.length) {
      const last = this.samples[this.samples.length - 1];
      lines.push(`mode/speed  : ${ctx.mode?.() || '?'} @ ${last.panels[0]?.rate}x`);
      if (last.cloud) {
        const c = last.cloud;
        lines.push(`cloud       : frame ${c.frame} (showing ${c.shown}, lag ${c.lag}), `
          + `${c.cached} cached, ${c.pending} in flight`);
        lines.push(`cloud cfg   : density ${Math.round((c.density ?? 1) * 100)}%, `
          + `stride 1/${c.stride ?? 1}, starved ${c.starved} frames`);
      }
    }

    lines.push('');
    lines.push('panel               drift   worst@  rs  paused  buffered  cov   stalls seeks waits');
    const worst = this.worstDrift();
    const last = this.samples[this.samples.length - 1];
    for (const p of (last?.panels || [])) {
      const w = worst.get(p.id) || { d: 0, t: 0 };
      const n = (k) => this.counts.get(`${p.id}|${k}`) || 0;
      lines.push(
        `${p.id.padEnd(18)} ${String(p.d).padStart(6)} `
        + `${String(w.d).padStart(6)}@${String(w.t).padStart(5)} `
        + `${String(p.rs).padStart(2)} ${String(p.paused).padStart(6)} `
        + `${String(p.buf).padStart(8)} ${String(p.cov).padStart(5)} `
        + `${String(n('stalled')).padStart(6)} ${String(n('seeking')).padStart(5)} `
        + `${String(n('waiting')).padStart(5)}`);
    }

    lines.push('');
    lines.push('--- notable events (stalls, waits, seeks, corrections) ---');
    const notable = this.events.filter((e) => e.kind !== 'progress'
      && e.kind !== 'suspend' && e.kind !== 'timeupdate');
    for (const e of notable.slice(-90)) {
      lines.push(`${String(e.t).padStart(8)}s ${e.panel.padEnd(18)} ${e.kind}`
        + (e.detail ? ` ${JSON.stringify(e.detail)}` : ''));
    }

    lines.push('');
    lines.push('--- drift over time (s) ---');
    const ids = (last?.panels || []).map((p) => p.id);
    lines.push(`t        ${ids.map((i) => i.slice(0, 9).padStart(10)).join('')}`);
    const step = Math.max(1, Math.ceil(this.samples.length / 40));
    for (let i = 0; i < this.samples.length; i += step) {
      const row = this.samples[i];
      lines.push(`${String(row.t).padStart(7)}s `
        + row.panels.map((p) => String(p.d).padStart(10)).join(''));
    }
    return lines.join('\n');
  }

  dump() {
    const text = this.report();
    // eslint-disable-next-line no-console
    console.log(text);
    return text;
  }

  async copy() {
    const text = this.report();
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return text;
    }
  }

  json() {
    return { context: this.context, events: this.events, samples: this.samples };
  }
}

/** One-shot probe: does the asset host answer byte ranges? */
export async function probeRanges(url) {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    return `${response.status}${response.status === 206 ? ' (ok)' : ' (NOT honoured)'}`;
  } catch (error) {
    return `probe failed: ${error.message}`;
  }
}
