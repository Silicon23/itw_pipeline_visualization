import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { el } from '../util.js';
import { assetURL } from '../config.js';

/**
 * Per-frame SAM 3D Objects mesh, in its own interactive viewer.
 *
 * The meshes are already in the camera frame, metric metres, OpenCV axes -- the
 * canonical Step-3 artifact that Step 4 consumes. So they are shown at their
 * own pose with only the OpenCV->three.js axis flip applied; `sam3d_pose`
 * belongs to `meshes_raw/` and applying it here would double-transform.
 *
 * Follows the master clock like every other tile: advances per frame in
 * autoplay, static in frame mode.
 */

const CACHE_LIMIT = 24;

export class MeshPanel {
  constructor(base, spec, transport) {
    this.base = base;
    this.transport = transport;
    this.sets = spec.meshes || {};
    this.ids = Object.keys(this.sets);
    this.current = this.ids[0] || null;
    this.cache = new Map();
    this.pending = new Map();
    this.lastFrame = -1;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pc-canvas';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070a);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.005, 100);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.loader = new GLTFLoader();

    // Vertex colours carry the appearance, but a little light keeps the shape
    // readable where the reconstruction is untextured.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1, 1);
    this.scene.add(key);

    this.holder = new THREE.Group();
    this.scene.add(this.holder);

    this.badge = el('span', { class: 'viz-badge' });
    this.stage = el('div', { class: 'pc-stage' }, this.canvas, this.badge);
    this.node = el('article', { class: 'viz-card is-shared pc-card' },
      el('header', { class: 'viz-head' },
        el('div', {},
          el('h3', { class: 'viz-title', text: 'Per-frame mesh' }),
          el('p', { class: 'viz-sub' },
            'The SAM 3D Objects reconstruction this frame’s box was fitted '
            + 'to. Drag to orbit, scroll to zoom.')),
        el('span', { class: 'viz-rate', text: `${this.rate()} fps` })),
      el('div', { class: 'pc-body' }, this.stage, this.buildControls()),
      el('p', { class: 'viz-note' },
        'Meshes exist only on measured frames, at the 6 Hz cadence, and are '
        + 'decimated for the browser. Shown at their own camera-frame pose.'));

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.stage);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  rate() {
    const set = this.sets[this.current];
    if (!set || set.frames.length < 2) return 6;
    return Math.round(24 / (set.frames[1] - set.frames[0])) || 6;
  }

  buildControls() {
    const rows = this.ids.map((id) => {
      const set = this.sets[id];
      return el('label', { class: 'pc-row' },
        el('input', {
          type: 'radio', name: 'meshobj', class: 'pc-check',
          checked: id === this.current,
          onchange: () => { this.current = id; this.lastFrame = -1; },
        }),
        el('span', { class: 'pc-row-label', text: `object #${id}` }),
        el('span', { class: 'pc-value', text: `${set.frames.length} frames` }));
    });
    return el('aside', { class: 'pc-controls' },
      el('p', { class: 'pc-group-title', text: 'Object' }),
      ...(rows.length ? rows : [el('p', { class: 'pc-empty', text: 'No meshes.' })]),
      el('p', { class: 'pc-hint' },
        `Decimated to ~${this.sets[this.current]?.target_faces ?? 6000} faces `
        + `(~${this.sets[this.current]?.median_kb ?? 0} KB) from `
        + `${(this.sets[this.current]?.source_median_vertices ?? 0).toLocaleString()} `
        + 'source vertices.'),
      el('div', { class: 'pc-buttons' },
        el('button', {
          class: 'ctl', type: 'button', onclick: () => this.frameView(),
        }, 'Reset view')));
  }

  /** Nearest mesh frame at or before `frame`, since meshes are 6 Hz. */
  resolve(frame) {
    const set = this.sets[this.current];
    if (!set) return null;
    let lo = 0;
    let hi = set.frames.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (set.frames[mid] <= frame) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found < 0 ? null : set.frames[found];
  }

  url(frame) {
    const set = this.sets[this.current];
    return assetURL(`${this.base}/${set.path.replace('%06d', String(frame).padStart(6, '0'))}`);
  }

  async show(frame) {
    const key = `${this.current}:${frame}`;
    let mesh = this.cache.get(key);
    if (!mesh && !this.pending.has(key)) {
      const job = new Promise((resolve) => {
        this.loader.load(this.url(frame), (gltf) => resolve(gltf.scene),
          undefined, () => resolve(null));
      }).then((scene) => {
        if (scene) {
          // The reconstruction's own vertex colours are the signal here, and a
          // PBR material renders them almost black under any sane light rig.
          // Lambert keeps the colours readable while still shading the form.
          scene.traverse((node) => {
            if (!node.isMesh) return;
            const previous = node.material;
            node.material = new THREE.MeshLambertMaterial({
              vertexColors: true,
              color: 0xffffff,
              side: THREE.DoubleSide,
            });
            previous?.dispose?.();
          });
          // OpenCV (y down, z forward) -> three.js, matching the point cloud
          scene.scale.set(1, -1, -1);
          this.cache.set(key, scene);
          if (this.cache.size > CACHE_LIMIT) {
            this.cache.delete(this.cache.keys().next().value);
          }
        }
        this.pending.delete(key);
        return scene;
      });
      this.pending.set(key, job);
      mesh = await job;
    } else if (!mesh) {
      mesh = await this.pending.get(key);
    }
    if (!mesh || this.shownKey === key) return;
    this.shownKey = key;
    this.holder.clear();
    this.holder.add(mesh);
    if (!this.framed) { this.frameView(); this.framed = true; }
  }

  frameView() {
    const box = new THREE.Box3().setFromObject(this.holder);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 0.5;
    this.controls.target.copy(centre);
    this.camera.position.set(centre.x + radius * 1.1,
      centre.y + radius * 0.8, centre.z + radius * 1.4);
    this.camera.near = Math.max(radius / 500, 0.002);
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  applyMode() { this.lastFrame = -1; }

  loop() {
    requestAnimationFrame(this.loop);
    const frame = this.transport.frame;
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      const at = this.resolve(frame);
      if (at === null) {
        this.badge.textContent = 'no mesh yet';
      } else {
        this.badge.textContent = at === frame
          ? `frame ${at}` : `held from frame ${at}`;
        this.show(at);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
