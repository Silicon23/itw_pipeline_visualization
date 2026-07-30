import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { FrameCache } from './frames.js';

/**
 * Interactive 4D point cloud with both prompting modes' box trajectories.
 *
 * Depth is unprojected in the vertex shader rather than pre-baked as XYZ: one
 * vertex per depth pixel, position computed from the sampled depth and the
 * frame's intrinsics. Changing frame is then a texture swap, which is what makes
 * scrubbing and playback cheap.
 *
 * Everything is drawn in the CAMERA frame of the current frame, which is where
 * the detector emits boxes -- so no extrinsic is applied and boxes sit on the
 * cloud by construction.
 */

const VERT = `
uniform sampler2D depthMap;
uniform sampler2D colorMap;
uniform vec2 res;
uniform vec4 K;          // fx, fy, cx, cy
uniform float depthMax;
uniform float pointSize;
varying vec3 vColor;
varying float vValid;

void main() {
  vec2 uv = vec2(position.x, position.y);
  vec4 packed = texture2D(depthMap, uv);
  // 16-bit depth split across the red and green channels
  float z = (packed.r * 255.0 * 256.0 + packed.g * 255.0) / 65535.0 * depthMax;
  vValid = z > 0.0001 ? 1.0 : 0.0;

  vec2 px = vec2(uv.x * res.x, uv.y * res.y);
  vec3 cam = vec3((px.x - K.z) / K.x * z, (px.y - K.w) / K.y * z, z);
  // OpenCV (y down, z forward) -> three.js (y up, z back)
  vec3 p = vec3(cam.x, -cam.y, -cam.z);

  vColor = texture2D(colorMap, uv).rgb;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pointSize;
}`;

// The colour texture is tagged sRGB, so sampling decodes it to linear. A custom
// fragment shader gets no automatic output conversion, so without this include
// the linear values reach an sRGB framebuffer unconverted and the cloud renders
// far too dark.
/**
 * Per-variant shade of an object's colour.
 *
 * point_prompt keeps the object colour exactly, so it matches the 2D overlays.
 * box_prompt is the same hue lightened toward white, which reads clearly against
 * the dark cloud without implying a different object.
 */
/**
 * How each box variant presents itself, for both pipelines.
 *
 * `on` is the default toggle state; smoothed layers start off because they sit
 * almost on top of their raw counterpart. `pale` and `dashed` are the two axes
 * that keep four v2 variants apart without spending four colours.
 */
export const VARIANTS = {
  // v2
  point_prompt: { label: 'Point-prompted boxes', on: true },
  box_prompt: { label: 'Box-prompted boxes', on: true, pale: true },
  smoothed_point: { label: 'Smoothed point', on: false, dashed: true },
  smoothed_box: { label: 'Smoothed box', on: false, pale: true, dashed: true },
  // v1
  measured: { label: 'Measured boxes', on: true },
  smoothed: { label: 'Smoothed boxes', on: false, dashed: true },
};

export function variantSpec(variant) {
  return VARIANTS[variant] || { label: variant, on: true };
}

export function variantColor(hex, variant) {
  // Smoothed shares its raw counterpart's colour and is told apart by the dash
  // pattern, so adding it costs no colour space.
  if (!variantSpec(variant).pale) return hex;
  const n = parseInt(hex.replace('#', ''), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.58);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const FRAG = `
varying vec3 vColor;
varying float vValid;
void main() {
  if (vValid < 0.5) discard;
  gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}`;

export class PointCloudViewer {
  constructor(base, manifest, boxes) {
    this.base = base;
    this.manifest = manifest;
    this.boxes = boxes;
    this.frames = manifest.vggt_frame_indices;
    this.cache = new FrameCache(base, manifest);
    this.current = -1;
    // Defaults come from the variant registry, so a pipeline with a different
    // set of variants needs no change here.
    this.visible = { cloud: true, frustum: true };
    for (const variant of Object.keys(boxes.variants || {})) {
      this.visible[variant] = variantSpec(variant).on;
    }
    this.objectsOn = new Map();   // masklet_id -> bool

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pc-canvas';
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070a);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.02, 500);
    this.camera.position.set(0, 0, 0.001);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;

    this.buildCloud();
    this.buildBoxes();
    this.frameView();
  }

  // ---------------------------------------------------------------- geometry

  /**
   * Vertex set for a given fraction of pixels.
   *
   * Selected by a spatial hash rather than a regular stride, so a reduced cloud
   * reads as an evenly thinned surface instead of a visible lattice.
   */
  cloudGeometry(density) {
    const { width, height } = this.manifest.depth;
    const keep = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (density < 1) {
          const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000;
          if (h >= density * 1000) continue;
        }
        keep.push((x + 0.5) / width, (y + 0.5) / height, 0);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(keep), 3));
    // The shader positions every vertex, so CPU-side bounds are meaningless and
    // frustum culling would flicker the whole cloud out of view.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return geometry;
  }

  /** Fraction of pixels drawn. Cheaper to render; does not change bytes fetched. */
  setDensity(density) {
    this.density = density;
    const next = this.cloudGeometry(density);
    this.cloud.geometry.dispose();
    this.cloud.geometry = next;
  }

  /**
   * Frame stride for the cloud -- the knob that actually reduces bytes fetched.
   * `0` means adapt to the link.
   */
  setStride(stride) {
    this.autoStride = !stride;
    if (stride) this.stride = Math.max(1, Math.round(stride));
    this.recent = [];
  }

  /**
   * Match the cloud's frame rate to what the connection can deliver.
   *
   * A full-rate cloud needs ~12 frames/s of depth+colour, which a constrained
   * link cannot supply; the result is a cloud that visibly sticks. Measured on a
   * 1.2 Mbps link: stride 1 starved 163 frames in 30 s, stride 3 starved 2.
   * Raise the stride when starving, lower it when comfortable, with a cooldown
   * so it settles instead of oscillating.
   */
  adapt(missed) {
    if (!this.autoStride) return;
    this.recent.push(missed ? 1 : 0);
    if (this.recent.length > 80) this.recent.shift();
    if (this.recent.length < 40) return;

    const now = performance.now();
    if (now - (this.lastAdapt || 0) < 2500) return;
    const rate = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    if (rate > 0.25 && this.stride < 4) this.stride += 1;
    else if (rate < 0.05 && this.stride > 1) this.stride -= 1;
    else return;
    this.lastAdapt = now;
    this.recent = [];
  }

  buildCloud() {
    const { width, height } = this.manifest.depth;
    this.density = 0.5;
    this.stride = 1;
    this.autoStride = true;
    this.recent = [];
    const geometry = this.cloudGeometry(this.density);

    this.depthTex = new THREE.Texture();
    this.colorTex = new THREE.Texture();
    for (const tex of [this.depthTex, this.colorTex]) {
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    }
    this.colorTex.colorSpace = THREE.SRGBColorSpace;

    this.uniforms = {
      depthMap: { value: this.depthTex },
      colorMap: { value: this.colorTex },
      res: { value: new THREE.Vector2(width, height) },
      K: { value: new THREE.Vector4(1, 1, 0, 0) },
      depthMax: { value: this.manifest.depth.depth_max_m },
      pointSize: { value: 2.5 },
    };
    this.cloud = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
    }));
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);
    this.buildFrustum();
  }

  /**
   * Camera frustum at the origin.
   *
   * Everything is drawn in the current frame's camera frame, so the camera is
   * always at the origin looking down -z; the frustum marks where the detector
   * was standing when it produced these boxes.
   */
  buildFrustum() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(8 * 3 * 2), 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.frustum = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: 0x8d99a8, transparent: true, opacity: 0.75,
    }));
    this.frustum.frustumCulled = false;
    this.scene.add(this.frustum);
    this.updateFrustum();
  }

  updateFrustum(depth = 0.45) {
    const { width, height } = this.manifest.depth;
    const [fx, fy, cx, cy] = this.uniforms.K.value.toArray();
    if (!fx || !fy) return;
    // image corners unprojected to `depth`, then OpenCV -> three.js
    const corner = (px, py) => [
      ((px - cx) / fx) * depth, -(((py - cy) / fy) * depth), -depth,
    ];
    const c = [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)];
    const segments = [];
    for (let i = 0; i < 4; i += 1) {
      segments.push([0, 0, 0], c[i]);              // apex to each corner
      segments.push(c[i], c[(i + 1) % 4]);         // image rectangle
    }
    const array = this.frustum.geometry.attributes.position.array;
    segments.flat().forEach((v, i) => { array[i] = v; });
    this.frustum.geometry.attributes.position.needsUpdate = true;
  }

  buildBoxes() {
    const edges = this.boxes.edges;
    this.tracks = [];       // {variant, masklet_id, label, color, byFrame, line}
    for (const [variant, payload] of Object.entries(this.boxes.variants || {})) {
      for (const obj of payload.objects) {
        const positions = new Float32Array(edges.length * 2 * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
        // The two variants must be separable at a glance, since they overlap
        // almost exactly. Keeping the hue preserves which object a box belongs
        // to (and matches the 2D overlays); the pale tint says which prompting
        // mode produced it.
        const shade = variantColor(obj.color, variant);
        const smoothed = Boolean(variantSpec(variant).dashed);
        const material = smoothed
          // dashed, so a smoothed track reads as the same object's smoothed
          // version rather than as a second object
          ? new THREE.LineDashedMaterial({
            color: new THREE.Color(shade), dashSize: 0.05, gapSize: 0.035,
            transparent: true, opacity: 0.95,
          })
          : new THREE.LineBasicMaterial({
            color: new THREE.Color(shade),
            transparent: true, opacity: variantSpec(variant).pale ? 0.9 : 1.0,
          });
        const line = new THREE.LineSegments(geometry, material);
        line.frustumCulled = false;
        line.visible = false;
        this.scene.add(line);

        const byFrame = new Map();
        obj.frames.forEach((f, i) => byFrame.set(f, i));
        // Smallest gap between consecutive frames is this variant's cadence:
        // 1 for a dense track, 4 for a 6 Hz one on 24 fps footage.
        let cadence = 1;
        for (let i = 1; i < obj.frames.length; i += 1) {
          const gap = obj.frames[i] - obj.frames[i - 1];
          if (i === 1 || gap < cadence) cadence = gap;
        }
        this.tracks.push({
          variant, masklet_id: obj.masklet_id, label: obj.label,
          color: obj.color, obj, byFrame, line, geometry, smoothed,
          cadence: Math.max(cadence, 1),
        });
        if (!this.objectsOn.has(obj.masklet_id)) {
          this.objectsOn.set(obj.masklet_id, true);
        }
      }
    }
  }

  /** Distinct objects across both variants, for the toggle list. */
  objectList() {
    const seen = new Map();
    for (const t of this.tracks) {
      if (!seen.has(t.masklet_id)) {
        seen.set(t.masklet_id, { masklet_id: t.masklet_id, label: t.label, color: t.color });
      }
    }
    return [...seen.values()].sort((a, b) => a.masklet_id - b.masklet_id);
  }

  // ------------------------------------------------------------------ state

  setVisible(key, on) {
    this.visible[key] = on;
    if (key === 'cloud') this.cloud.visible = on;
    if (key === 'frustum' && this.frustum) this.frustum.visible = on;
    this.refreshBoxes();
  }

  setObject(masklet, on) {
    this.objectsOn.set(masklet, on);
    this.refreshBoxes();
  }

  /**
   * A track draws only when its variant AND its object are both on, and it has
   * geometry for the frame under the rules of the current mode.
   */
  refreshBoxes() {
    for (const track of this.tracks) {
      const gated = this.visible[track.variant] && this.objectsOn.get(track.masklet_id);
      track.line.visible = Boolean(gated && this.applyTrack(track, this.current));
    }
  }

  /** Inverse of a rigid 4x4, as nested arrays. */
  static invertRigid(m) {
    const r = [[m[0][0], m[1][0], m[2][0]],
               [m[0][1], m[1][1], m[2][1]],
               [m[0][2], m[1][2], m[2][2]]];
    const t = [m[0][3], m[1][3], m[2][3]];
    return {
      r,
      t: [-(r[0][0] * t[0] + r[0][1] * t[1] + r[0][2] * t[2]),
        -(r[1][0] * t[0] + r[1][1] * t[1] + r[1][2] * t[2]),
        -(r[2][0] * t[0] + r[2][1] * t[1] + r[2][2] * t[2])],
    };
  }

  /**
   * Re-express a box from `fromFrame` in the camera frame of `atFrame`.
   *
   * Boxes are stored per frame in that frame's camera coordinates. Holding one
   * across frames without re-referencing draws old camera coordinates into a
   * newer camera's scene, so the stale box appears pinned to the screen and
   * follows the camera around -- on sav_002845 the camera moves 1.52 m between
   * a held box's own frame and where it was still being drawn.
   */
  reference(corners, fromFrame, atFrame) {
    if (fromFrame === atFrame) return corners;
    const c2w = this.manifest.camera.c2w;
    const from = c2w[fromFrame];
    const at = c2w[atFrame];
    if (!from || !at) return corners;
    const inv = PointCloudViewer.invertRigid(at);
    return corners.map((p) => {
      // camera(from) -> world
      const w = [
        from[0][0] * p[0] + from[0][1] * p[1] + from[0][2] * p[2] + from[0][3],
        from[1][0] * p[0] + from[1][1] * p[1] + from[1][2] * p[2] + from[1][3],
        from[2][0] * p[0] + from[2][1] * p[1] + from[2][2] * p[2] + from[2][3],
      ];
      // world -> camera(at)
      return [
        inv.r[0][0] * w[0] + inv.r[0][1] * w[1] + inv.r[0][2] * w[2] + inv.t[0],
        inv.r[1][0] * w[0] + inv.r[1][1] * w[1] + inv.r[1][2] * w[2] + inv.t[1],
        inv.r[2][0] * w[0] + inv.r[2][1] * w[1] + inv.r[2][2] * w[2] + inv.t[2],
      ];
    });
  }

  /**
   * Does this box project anywhere onto the image at `frame`?
   *
   * The 2D overlays show nothing once an object leaves the view, so the 3D view
   * must not keep drawing it either. Corners behind the camera are dropped
   * rather than projected, since a negative z mirrors them across the frame.
   */
  onCamera(corners, frame) {
    const K = this.manifest.camera.intrinsics[frame];
    if (!K) return true;
    const { width, height } = this.manifest.depth;
    const [fx, fy, cx, cy] = [K[0][0], K[1][1], K[0][2], K[1][2]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anyFront = false;
    for (const p of corners) {
      if (p[2] <= 1e-3) continue;
      anyFront = true;
      const u = (p[0] / p[2]) * fx + cx;
      const v = (p[1] / p[2]) * fy + cy;
      if (u < minX) minX = u;
      if (u > maxX) maxX = u;
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
    if (!anyFront) return false;
    return maxX >= 0 && minX <= width && maxY >= 0 && minY <= height;
  }

  /**
   * Write a track's corners for `frame` into its geometry.
   *
   * autoplay -> hold the last box at or before the frame, so a 6 fps trajectory
   *             stays on screen between updates and both variants animate
   *             continuously alongside the 24 fps cloud.
   * frame    -> exact frames only, so a still never implies a measurement that
   *             was not made.
   */
  applyTrack(track, frame) {
    if (frame < 0) return false;
    let index = track.byFrame.get(frame);
    if (index === undefined) {
      if (this.mode === 'frame') return false;
      const frames = track.obj.frames;
      let lo = 0, hi = frames.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid] <= frame) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (found < 0) return false;
      // Hold only across this variant's own cadence gap. Past that the track has
      // ended, and the 2D overlays draw nothing there -- a box that lingered
      // would be showing a measurement the videos have already dropped.
      if (frame - track.obj.frames[found] >= track.cadence) return false;
      index = found;
    }
    const raw = track.obj.corners[index];
    const corners = this.reference(raw, track.obj.frames[index], frame);
    // Once the object is fully out of view, draw nothing -- matching the 2D
    // overlays, where an off-frame box simply is not there.
    if (!this.onCamera(corners, frame)) return false;
    const position = track.geometry.attributes.position;
    const array = position.array;
    this.boxes.edges.forEach(([a, b], e) => {
      // OpenCV camera frame -> three.js, matching the cloud's shader
      array[e * 6 + 0] = corners[a][0];
      array[e * 6 + 1] = -corners[a][1];
      array[e * 6 + 2] = -corners[a][2];
      array[e * 6 + 3] = corners[b][0];
      array[e * 6 + 4] = -corners[b][1];
      array[e * 6 + 5] = -corners[b][2];
    });
    position.needsUpdate = true;
    // Dash spacing is computed from vertex distances, so it has to be redone
    // whenever the corners move or the dashes stretch as the box changes size.
    if (track.smoothed) track.line.computeLineDistances();
    return true;
  }

  setMode(mode) {
    this.mode = mode;
    this.refreshBoxes();
  }

  async setFrame(frame) {
    const clamped = Math.min(Math.max(frame, 0), this.frames.length - 1);
    this.current = clamped;
    this.cache.prefetch(clamped, this.stride);

    // In frame mode the user picked a specific frame, so fetch it. During
    // autoplay, take what prefetch already has: an extra uncapped request per
    // frame change piles up connections and starves the video streams.
    let entry = this.cache.get(clamped);
    let shown = clamped;
    if (!entry) {
      if (this.mode === 'frame') {
        entry = await this.cache.load(clamped).catch(() => null);
      } else {
        // Fall back to the newest frame we do have, so the cloud keeps moving
        // when prefetch falls behind instead of appearing frozen.
        const near = this.cache.nearest(clamped);
        if (near) {
          entry = near.entry;
          shown = near.frame;
        } else {
          // nothing usable: the texture stays as it was, so report that frame
          // rather than the one we asked for -- otherwise `lag` reads 0 while
          // the display is actually stale.
          shown = this.shown ?? clamped;
        }
        this.starved = (this.starved || 0) + 1;
        this.adapt(true);
      }
    } else {
      this.adapt(false);
    }
    this.shown = shown;
    if (entry && this.current === clamped) {
      this.depthTex.image = entry.depth;
      this.colorTex.image = entry.rgb;
      this.depthTex.needsUpdate = true;
      this.colorTex.needsUpdate = true;
      const K = this.manifest.camera.intrinsics[shown];
      this.uniforms.K.value.set(K[0][0], K[1][1], K[0][2], K[1][2]);
      this.updateFrustum();
    }
    this.refreshBoxes();
  }

  setPointSize(value) {
    this.uniforms.pointSize.value = value;
  }

  /**
   * Default to an offset three-quarter view rather than the camera's own axis.
   * Sitting exactly at the origin reproduces the source frame with no parallax,
   * which looks like a flat image and hides the thing worth seeing -- that the
   * boxes have depth and sit in the scene.
   */
  frameView() {
    this.camera.position.set(1.6, 1.1, 1.4);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(0, -0.1, -2.6);
    this.controls.update();
  }

  /** The detector's own viewpoint, for checking alignment against the frame. */
  cameraView() {
    this.camera.position.set(0, 0, 0.001);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(0, 0, -2.5);
    this.controls.update();
  }

  resize(width, height) {
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.cache.dispose();
    this.renderer.dispose();
  }
}
