/**
 * The shared clock every visualization on the page follows.
 *
 * Two modes:
 *   autoplay   -- videos play together at `speed`. 0.5x means each overlay runs
 *                 at half its native rate: a 24 fps overlay shows 12 frames per
 *                 second, a 6 fps overlay shows 3. Because every overlay is
 *                 encoded at the source fps with content held between updates,
 *                 one playbackRate keeps them all on the same wall-clock.
 *   frame      -- one chosen frame, shown as a still everywhere.
 *
 * Frame indices are always NATIVE source-video frames. Each visualization maps
 * that index onto its own cadence.
 */

export const SPEEDS = [0.25, 0.5, 1, 2];
export const DEFAULT_SPEED = 0.5;

export class Transport extends EventTarget {
  constructor({ nFrames, fps }) {
    super();
    this.nFrames = Math.max(nFrames, 1);
    this.fps = fps || 24;
    this.mode = 'autoplay';
    this.speed = DEFAULT_SPEED;
    this.frame = 0;
    this.playing = false;
  }

  get duration() { return this.nFrames / this.fps; }

  emit(type) { this.dispatchEvent(new CustomEvent(type, { detail: this })); }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // Entering frame mode pauses; the chosen frame is what you are inspecting.
    if (mode === 'frame') this.playing = false;
    this.emit('mode');
  }

  setSpeed(speed) {
    this.speed = speed;
    this.emit('speed');
  }

  setFrame(frame) {
    const next = Math.min(Math.max(Math.round(frame), 0), this.nFrames - 1);
    if (next === this.frame) return;
    this.frame = next;
    this.emit('frame');
  }

  stepFrame(delta) { this.setFrame(this.frame + delta); }

  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.emit('playing');
  }

  togglePlaying() { this.setPlaying(!this.playing); }
}

/**
 * Resolve a native frame against one visualization's cadence.
 *
 * Returns the still to show and how it relates to the request, so the panel can
 * say "held from frame 40" rather than implying the content is exact.
 */
export function resolveFrame(vis, frame) {
  const frames = vis.frames || [];
  if (!frames.length) return { state: 'missing' };

  // largest available frame <= requested
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= frame) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (found < 0) {
    return { state: 'before', firstFrame: frames[0] };
  }
  const at = frames[found];
  const content = vis.frames_with_content || frames;
  const hasContent = content.includes(at);
  return {
    state: hasContent ? (at === frame ? 'exact' : 'held') : 'empty',
    frame: at,
    heldFrom: at === frame ? null : at,
  };
}

export function stillURL(vis, frame) {
  return vis.stills.replace('%06d', String(frame).padStart(6, '0'));
}
