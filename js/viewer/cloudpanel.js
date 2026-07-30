import { el } from '../util.js';
import { PointCloudViewer, variantColor, variantSpec } from './pointcloud.js';

/** Layer rows: the scene layers, then whichever box variants this clip has. */
function layersFor(boxes) {
  const rows = [
    { key: 'cloud', label: 'Point cloud', on: true },
    { key: 'frustum', label: 'Camera frustum', on: true },
  ];
  for (const variant of Object.keys(boxes.variants || {})) {
    const spec = variantSpec(variant);
    rows.push({ key: variant, label: spec.label, variant, on: spec.on });
  }
  return rows;
}

/**
 * The shared 4D point-cloud card.
 *
 * Follows the same transport as the video tiles, but reads the playhead in its
 * own animation frame rather than waiting on events: during autoplay the frame
 * advances from the master video's timeupdate, which does not emit one.
 */
export class CloudPanel {
  constructor(base, manifest, boxes, transport) {
    this.transport = transport;
    this.viewer = new PointCloudViewer(base, manifest, boxes);
    this.viewer.setMode(transport.mode);
    this.lastFrame = -1;

    this.stage = el('div', { class: 'pc-stage' }, this.viewer.canvas);
    this.node = el('article', { class: 'viz-card is-shared pc-card' },
      el('header', { class: 'viz-head' },
        el('div', {},
          el('h3', { class: 'viz-title', text: '4D point cloud' }),
          el('p', { class: 'viz-sub', text: this.subtitle() })),
        el('span', { class: 'viz-rate', text: `${Math.round(manifest.fps)} fps` })),
      el('div', { class: 'pc-body' }, this.stage, this.buildControls()),
      el('p', { class: 'viz-note', text: this.note() }));

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.stage);
    if (location.search.includes('debug')) window.__cloud = this.viewer;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** True when this clip carries the v2 prompting split. */
  hasPromptSplit() {
    return Boolean(this.viewer.boxes.variants?.point_prompt);
  }

  subtitle() {
    const what = this.hasPromptSplit()
      ? 'with both prompting modes\u2019 trajectories'
      : 'with the measured and smoothed trajectories';
    return `Metric depth unprojected per frame, ${what} in the camera frame. `
      + 'Drag to orbit, scroll to zoom.';
  }

  note() {
    const cadence = this.hasPromptSplit()
      ? 'Box-prompted boxes update at 6 fps and point-prompted at their own rate'
      : 'Measured boxes update at the 6 Hz annotation cadence and smoothed at the full rate';
    return `The cloud runs at the full frame rate. ${cadence}; in autoplay each `
      + 'holds between updates, and in frame-by-frame only exact frames are drawn.';
  }

  /** Readiness source for the load gate: the opening frames of the cloud. */
  loadSource(frames = 32) {
    return this.viewer.cache.warm(frames);
  }

  buildControls() {
    const objects = this.viewer.objectList();
    // Show each mode's swatch on its own row, using the first object's colour,
    // so the pale/saturated distinction is legible before you look at the scene.
    const sample = objects[0]?.color || '#00d7ff';

    const layerRows = layersFor(this.viewer.boxes).map((layer) => toggleRow({
      label: layer.label,
      color: layer.variant ? variantColor(sample, layer.variant) : null,
      dashed: layer.variant ? Boolean(variantSpec(layer.variant).dashed) : false,
      checked: layer.on,
      onChange: (on) => this.viewer.setVisible(layer.key, on),
    }));

    const objectRows = objects.map((obj) => toggleRow({
      label: `${obj.label} #${obj.masklet_id}`,
      color: obj.color,
      checked: true,
      onChange: (on) => this.viewer.setObject(obj.masklet_id, on),
    }));

    const size = el('input', {
      type: 'range', min: '1', max: '6', step: '0.5', value: '2.5',
      class: 'pc-size', 'aria-label': 'Point size',
      oninput: (e) => this.viewer.setPointSize(Number(e.target.value)),
    });

    const densityValue = el('span', { class: 'pc-value', text: '50%' });
    const density = el('input', {
      type: 'range', min: '5', max: '100', step: '5', value: '50',
      class: 'pc-size', 'aria-label': 'Point density',
      oninput: (e) => {
        const f = Number(e.target.value) / 100;
        densityValue.textContent = `${e.target.value}%`;
        this.viewer.setDensity(f);
      },
    });

    const rateValue = el('span', { class: 'pc-value', text: 'auto' });
    const rate = el('input', {
      type: 'range', min: '0', max: '4', step: '1', value: '0',
      class: 'pc-size', 'aria-label': 'Cloud frame rate',
      oninput: (e) => {
        const stride = Number(e.target.value);
        rateValue.textContent = stride === 0 ? 'auto'
          : (stride === 1 ? 'full' : `1/${stride}`);
        this.viewer.setStride(stride);
      },
    });
    // reflect what auto settles on, so the reading is never stale
    setInterval(() => {
      if (this.viewer.autoStride && rate.value === '0') {
        const s = this.viewer.stride;
        rateValue.textContent = s === 1 ? 'auto (full)' : `auto (1/${s})`;
      }
    }, 1000);

    return el('aside', { class: 'pc-controls' },
      el('p', { class: 'pc-group-title', text: 'Layers' }),
      ...layerRows,
      el('p', { class: 'pc-group-title', text: 'Objects' }),
      ...(objectRows.length ? objectRows
        : [el('p', { class: 'pc-empty', text: 'No tracked objects.' })]),
      el('p', { class: 'pc-hint', text:
        'Object colour says which object; '
        + (this.hasPromptSplit()
          ? 'pale means box-prompted, saturated means point-prompted, '
          : '')
        + 'dashed means smoothed. A trajectory shows only when its layer and '
        + 'its object are both on.' }),
      el('p', { class: 'pc-group-title', text: 'Rendering' }),
      el('label', { class: 'pc-size-row' }, 'Point size', size),
      el('label', { class: 'pc-size-row' }, 'Density', density, densityValue),
      el('label', { class: 'pc-size-row' }, 'Frame rate', rate, rateValue),
      el('p', { class: 'pc-hint' },
        'Density thins the points drawn — cheaper to render, same data '
        + 'fetched. Frame rate is what reduces loading: at 1/2 the cloud '
        + 'fetches every other frame.'),
      el('div', { class: 'pc-buttons' },
        el('button', {
          class: 'ctl', type: 'button', onclick: () => this.viewer.frameView(),
        }, 'Reset view'),
        el('button', {
          class: 'ctl', type: 'button',
          title: 'Look from where the camera was, to check box alignment',
          onclick: () => this.viewer.cameraView(),
        }, 'Camera view')));
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    this.viewer.resize(rect.width, rect.height);
  }

  applyMode() {
    this.viewer.setMode(this.transport.mode);
    this.lastFrame = -1;   // force a refresh under the new rules
  }

  loop() {
    requestAnimationFrame(this.loop);
    // Quantise to the chosen stride so a reduced frame rate actually skips
    // fetches rather than requesting every frame and discarding most of them.
    const stride = this.viewer.stride || 1;
    const target = Math.floor(this.transport.frame / stride) * stride;
    if (target !== this.lastFrame) {
      this.lastFrame = target;
      this.viewer.setFrame(target);
    }
    this.viewer.render();
  }
}

function toggleRow({ label, color, checked, dashed, onChange }) {
  const input = el('input', {
    type: 'checkbox', checked, class: 'pc-check',
    onchange: (e) => onChange(e.target.checked),
  });
  if (color) input.style.accentColor = color;
  // The swatch mirrors how the layer draws: solid for raw, dashed for smoothed.
  const swatch = color
    ? el('span', {
      class: dashed ? 'pc-swatch is-dashed' : 'chip-dot',
      style: dashed
        ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)` }
        : { background: color },
    })
    : null;
  return el('label', { class: 'pc-row' }, input, swatch,
    el('span', { class: 'pc-row-label', text: label }));
}
