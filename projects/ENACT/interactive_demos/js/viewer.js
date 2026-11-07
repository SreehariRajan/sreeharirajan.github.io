/*
 * ENACT interactive demo viewer
 * ─────────────────────────────
 * Plays a quantised SMPL-X vertex animation inside the MoGe scene point cloud.
 * Bundles are produced by tools/export_demo.py; see README.md for the format.
 *
 * No build step: this is a plain ES module that imports the vendored three.js.
 */

import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { fetchJSON, loadSample, dequantizeFrame } from './codec.js';

const DATA_ROOT = 'data';

/** Pause on the final pose before restarting, so the contact is readable. */
const LOOP_HOLD_MS = 1000;

/** Radius of the planned-path tube, in metres. */
const TRAJECTORY_RADIUS = 0.022;

/**
 * `color` fills the timeline bar, `ink` is the label printed on it, and `text`
 * is the same phase named on the page background — a bar colour bright enough
 * to read against dark blue is not readable as text on white.
 * Interaction uses the paper's keyframe yellow.
 */
const PHASE_STYLE = {
  walk:        { label: 'walk',        color: '#4c8dff', ink: '#ffffff', text: '#7fb0ff' },
  interaction: { label: 'interaction', color: '#ffd919', ink: '#4a3b00', text: '#ffd919' },
  transition:  { label: 'transition',  color: '#9aa4b2', ink: '#ffffff', text: '#9aa4b2' },
  all:         { label: 'motion',      color: '#4c8dff', ink: '#ffffff', text: '#7fb0ff' },
};

/* ── the viewer ─────────────────────────────────────────────────────────── */

class DemoViewer {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('#stage');
    this.bundles = new Map();
    this.current = null;
    this.frame = 0;
    this.holdUntil = 0;
    this.playing = true;
    this.loading = false;
    this.speed = 1;
    this.layers = { scene: true, human: true, keyframe: true, trajectory: true,
                    affordance: false, grid: false };
    this.initThree();
    this.initUI();
  }

  /* three.js plumbing */
  initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x0d1117, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene3 = new THREE.Scene();
    this.baseFov = 50;                       // replaced per sample by meta.camera.fov
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.01, 500);
    this.camera.position.set(0, 1.6, 4);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.98;

    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x2a3240, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2.5, 5, 3);
    this.scene3.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    fill.position.set(-3, 2, -2.5);
    this.scene3.add(fill);

    this.group = new THREE.Group();          // everything sample-specific
    this.scene3.add(this.group);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas.parentElement);
    this.resize();

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /**
   * Splat size in device pixels. The viewer reproduces the capture camera's
   * vertical field of view, so one image row maps to canvasHeight/imageHeight
   * device pixels — scaling the export's image-space point spacing by that
   * keeps the cloud gap-free at any canvas size or devicePixelRatio.
   */
  splatSize() {
    const mult = Number(this.el?.pointSize?.value) || 1;
    const h = this.renderer.domElement.height || 600;
    const stats = this.sceneStats;
    if (stats?.spacingImagePx && stats?.imageSize?.[1]) {
      return Math.max(1, 1.35 * stats.spacingImagePx * (h / stats.imageSize[1])) * mult;
    }
    return 2.2 * Math.min(window.devicePixelRatio || 1, 2) * mult;
  }

  applySplatSize() {
    const size = this.splatSize();
    if (this.scenePoints) this.scenePoints.material.size = size;
    for (const p of this.affordPoints || []) p.material.size = size * 0.7;
  }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const h = Math.max(1, Math.floor(box.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.applySplatSize();
    this.fitPhaseLabels();
  }

  /* DOM wiring */
  initUI() {
    this.el = {
      tabs: this.root.querySelector('#tabs'),
      prompt: this.root.querySelector('#prompt'),
      title: this.root.querySelector('#sample-title'),
      slider: this.root.querySelector('#timeline'),
      phases: this.root.querySelector('#phases'),
      frameLabel: this.root.querySelector('#frame-label'),
      phaseLabel: this.root.querySelector('#phase-label'),
      play: this.root.querySelector('#play'),
      status: this.root.querySelector('#status'),
      photo: this.root.querySelector('#photo'),
      photoImg: this.root.querySelector('#photo img'),
      pointSize: this.root.querySelector('#point-size'),
      speed: this.root.querySelector('#speed'),
    };

    this.el.play.addEventListener('click', () => this.setPlaying(!this.playing));
    this.el.slider.addEventListener('input', () => {
      this.setPlaying(false);
      this.holdUntil = 0;
      this.setFrame(Number(this.el.slider.value));
    });
    this.root.querySelector('#reset-view').addEventListener('click', () => this.resetView());

    this.root.querySelectorAll('[data-layer]').forEach((input) => {
      input.addEventListener('change', () => {
        this.layers[input.dataset.layer] = input.checked;
        this.applyLayers();
      });
    });

    this.el.pointSize.addEventListener('input', () => this.applySplatSize());
    this.el.speed.addEventListener('change', () => { this.speed = Number(this.el.speed.value); });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') { e.preventDefault(); this.setPlaying(!this.playing); }
      else if (e.code === 'ArrowRight') { this.setPlaying(false); this.step(1); }
      else if (e.code === 'ArrowLeft') { this.setPlaying(false); this.step(-1); }
    });
  }

  /**
   * Anything that has to fetch or decode marks itself loading. While that flag
   * is up nothing animates: playback is paused and the render loop stops
   * advancing frames, so whatever is on screen holds still until the work is
   * done, whichever code path started it.
   */
  setLoading(on, message = '') {
    this.loading = on;
    if (on) {
      this.setPlaying(false);
      this.status(message);
    } else {
      this.status('');
    }
  }

  status(text, kind = 'info') {
    this.el.status.textContent = text || '';
    this.el.status.dataset.kind = kind;
    this.el.status.classList.toggle('is-hidden', !text);
  }

  /* sample list */
  setSamples(samples) {
    this.samples = samples;
    this.el.tabs.innerHTML = '';
    samples.forEach((entry, i) => {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.textContent = entry.title || entry.slug;
      btn.addEventListener('click', () => this.select(i));
      this.el.tabs.appendChild(btn);
    });
  }

  async select(index) {
    if (!this.samples?.length) return;
    this.setLoading(true);
    this.index = (index + this.samples.length) % this.samples.length;
    const entry = this.samples[this.index];
    [...this.el.tabs.children].forEach((b, i) =>
      b.classList.toggle('is-active', i === this.index));

    this.el.title.textContent = entry.title || entry.slug;
    this.setPrompt(entry.prompt || '', null);

    if (!this.bundles.has(entry.slug)) {
      this.status(`Loading ${entry.title || entry.slug} …`);
      try {
        this.bundles.set(entry.slug,
          await loadSample(entry, DATA_ROOT, (msg) => this.status(`${entry.title}: ${msg} …`)));
      } catch (err) {
        this.bundles.delete(entry.slug);
        this.loading = false;
        this.status(describeError(err), 'error');
        console.error(err);
        return;
      }
    }
    if (this.samples[this.index] !== entry) return;   // a later pick owns the flag now
    this.setLoading(false);
    this.show(this.bundles.get(entry.slug));
  }

  /**
   * Render the instruction, split into one span per keyframe when the exporter
   * found a clean sentence-per-keyframe split, so playback can light the clause
   * that is happening right now.
   */
  setPrompt(text, segments) {
    this.promptSpans = [];
    this.keyframeRanges = this.keyframeRanges || new Map();
    this.el.prompt.textContent = '';
    this.el.prompt.classList.toggle('is-segmented', Boolean(segments?.length));
    if (!segments?.length) {
      this.el.prompt.textContent = text || '';
      return;
    }
    segments.forEach((seg, i) => {
      const span = document.createElement('span');
      span.className = 'seg';
      span.textContent = seg.text;
      span.dataset.keyframeId = String(seg.keyframeId ?? i + 1);
      if (Number.isFinite(seg.start)) span.dataset.start = String(seg.start);
      if (Number.isFinite(seg.end)) span.dataset.end = String(seg.end);
      if (seg.phase) span.dataset.phase = seg.phase;
      this.el.prompt.appendChild(span);
      if (i < segments.length - 1) this.el.prompt.appendChild(document.createTextNode(' '));
      this.promptSpans.push(span);
    });
  }

  /**
   * Fill each clause left to right by how far playback has moved through the
   * frames it describes: the locomotion clause fills over the walk, the
   * interaction clause only starts filling when the interaction frames do,
   * finished clauses stay filled and later ones stay empty.
   */
  updatePromptProgress(frame) {
    for (const span of this.promptSpans || []) {
      // each clause carries the frame range of the phases it describes; older
      // bundles only name a keyframe, so fall back to that keyframe's span
      const range = span.dataset.start !== undefined
        ? { start: Number(span.dataset.start), end: Number(span.dataset.end) }
        : this.keyframeRanges?.get(Number(span.dataset.keyframeId));
      let pct = 0;
      if (range) {
        const length = Math.max(range.end - range.start, 1);
        pct = Math.max(0, Math.min(1, (frame - range.start) / length)) * 100;
      }
      span.style.backgroundSize = `${pct.toFixed(1)}% 100%`;
      span.classList.toggle('is-started', pct > 0);
    }
  }

  /* build the three.js objects for one bundle */
  show(bundle) {
    this.current = bundle;
    const { meta } = bundle;

    this.group.clear();
    disposeTree(this.group);
    this.baseFov = meta.camera?.fov || 50;
    this.sceneStats = meta.scene || null;
    this.basePointSize = meta.scene?.pointSize || 0.015;
    this.resize();

    // human mesh
    const geo = new THREE.BufferGeometry();
    this.humanPositions = new Float32Array(meta.human.verts * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.humanPositions, 3));
    geo.setIndex(new THREE.BufferAttribute(bundle.faces, 1));
    this.humanGeometry = geo;
    this.humanMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x6ea8fe, roughness: 0.55, metalness: 0.05,
    }));
    this.humanMesh.frustumCulled = false;
    this.group.add(this.humanMesh);

    // Stage-3 contact poses: the targets the motion has to hit, drawn as
    // translucent ghosts in the same decimated topology as the animation.
    this.keyframeMeshes = [];
    if (bundle.keyframePoses && meta.keyframePoses) {
      const kp = meta.keyframePoses;
      for (let i = 0; i < kp.frames; i++) {
        const positions = new Float32Array(kp.verts * 3);
        dequantizeFrame(bundle.keyframePoses, kp.verts, kp.origin, kp.step, i, i, 0, positions);
        const kg = new THREE.BufferGeometry();
        kg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        kg.setIndex(new THREE.BufferAttribute(bundle.faces, 1));
        kg.computeVertexNormals();
        const mesh = new THREE.Mesh(kg, new THREE.MeshStandardMaterial({
          // (255, 217, 25) — the keyframe-pose yellow used in the paper figures
          // and in contactplan/scripts/run_visualize_interactive.py
          color: 0xffd919, roughness: 0.65, metalness: 0.0,
          emissive: 0x5a4200, emissiveIntensity: 0.25,
          transparent: true, opacity: 0.6, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
        }));
        mesh.renderOrder = 2;
        mesh.frustumCulled = false;
        mesh.userData.label = kp.items?.[i]?.label || `keyframe ${i + 1}`;
        this.keyframeMeshes.push(mesh);
        this.group.add(mesh);
      }
    }

    // scene point cloud
    this.scenePoints = null;
    if (bundle.scene) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(bundle.scene.positions, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(bundle.scene.colors, 3, true));
      this.scenePoints = new THREE.Points(pg, new THREE.PointsMaterial({
        size: this.splatSize(), vertexColors: true, sizeAttenuation: false,
      }));
      this.group.add(this.scenePoints);
    }

    // affordance maps
    this.affordPoints = bundle.affordance.map((layer) => {
      const ag = new THREE.BufferGeometry();
      ag.setAttribute('position', new THREE.BufferAttribute(layer.positions, 3));
      ag.setAttribute('color', new THREE.BufferAttribute(layer.colors, 3, true));
      const pts = new THREE.Points(ag, new THREE.PointsMaterial({
        size: this.splatSize() * 0.7, vertexColors: true, sizeAttenuation: false,
      }));
      this.group.add(pts);
      return pts;
    });

    // Root trajectory, as a tube rather than a THREE.Line: WebGL ignores
    // linewidth, so a line is always one pixel wide and vanishes in the cloud.
    this.trajLine = null;
    if (bundle.trajectory && bundle.trajectory.length >= 6) {
      const pts = [];
      for (let i = 0; i < bundle.trajectory.length; i += 3) {
        const p = new THREE.Vector3(bundle.trajectory[i], bundle.trajectory[i + 1],
          bundle.trajectory[i + 2]);
        // CatmullRomCurve3 produces NaNs on repeated control points
        if (!pts.length || p.distanceToSquared(pts[pts.length - 1]) > 1e-8) pts.push(p);
      }
      if (pts.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        const tube = new THREE.TubeGeometry(
          curve, Math.min(Math.max(pts.length, 32), 1200), TRAJECTORY_RADIUS, 8, false);
        this.trajLine = new THREE.Mesh(tube, new THREE.MeshStandardMaterial({
          color: 0x2fd98f, roughness: 0.5, metalness: 0.0,
          emissive: 0x0e4531, emissiveIntensity: 0.45,
        }));
        this.trajLine.frustumCulled = false;
        this.group.add(this.trajLine);
      }
    }

    // floor grid
    const grid = new THREE.GridHelper(12, 24, 0x3b4a63, 0x222c3c);
    grid.position.y = meta.floorY ?? 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.grid = grid;
    this.group.add(grid);

    // photo inset
    if (meta.image) {
      this.el.photoImg.src = `${bundle.dir}/${meta.image}`;
      this.el.photo.classList.remove('is-hidden');
    } else {
      this.el.photo.classList.add('is-hidden');
    }

    this.setPrompt(meta.prompt || '', meta.promptSegments);
    this.el.slider.max = String(Math.max(0, meta.human.frames - 1));
    this.buildKeyframeRanges(meta);
    this.buildPhaseRibbon(meta);
    this.applyLayers();
    this.resetView();
    this.holdUntil = 0;
    this.setFrame(0);
    this.setPlaying(true);
  }

  /** Frame span of each keyframe = its transition + walk + interaction segments. */
  buildKeyframeRanges(meta) {
    const ranges = new Map();
    for (const seg of meta.phases || []) {
      const id = seg.keyframeId ?? 1;
      const r = ranges.get(id) || { start: Infinity, end: -Infinity };
      r.start = Math.min(r.start, seg.start);
      r.end = Math.max(r.end, seg.end);
      ranges.set(id, r);
    }
    this.keyframeRanges = ranges;
  }

  buildPhaseRibbon(meta) {
    const total = Math.max(1, meta.human.frames);
    this.el.phases.innerHTML = '';
    for (const seg of meta.phases || []) {
      const span = Math.max(0, seg.end - seg.start);
      if (!span) continue;
      const style = PHASE_STYLE[seg.phase] || PHASE_STYLE.all;
      const bar = document.createElement('span');
      bar.className = 'phase';
      bar.style.left = `${(seg.start / total) * 100}%`;
      bar.style.width = `${(span / total) * 100}%`;
      bar.style.background = style.color;
      bar.style.color = style.ink;
      bar.title = `${style.label} — frames ${seg.start}–${seg.end - 1}`;
      bar.dataset.label = style.label;
      this.el.phases.appendChild(bar);
    }
    this.fitPhaseLabels();
  }

  /** Only label a phase bar that is actually wide enough to hold the word. */
  fitPhaseLabels() {
    for (const bar of this.el?.phases?.children || []) {
      const label = bar.dataset.label || '';
      const fits = bar.getBoundingClientRect().width >= label.length * 7 + 10;
      bar.textContent = fits ? label : '';
    }
  }

  applyLayers() {
    if (this.humanMesh) this.humanMesh.visible = this.layers.human;
    for (const m of this.keyframeMeshes || []) m.visible = this.layers.keyframe;
    if (this.scenePoints) this.scenePoints.visible = this.layers.scene;
    if (this.trajLine) this.trajLine.visible = this.layers.trajectory;
    if (this.grid) this.grid.visible = this.layers.grid;
    for (const p of this.affordPoints || []) p.visible = this.layers.affordance;
  }

  /**
   * Points the default view should try to contain: the walked path, the body at
   * the current frame, and a thin sample of the scene cloud.
   */
  focusPoints() {
    const out = [];
    const push = (arr, stride) => {
      for (let i = 0; i < arr.length; i += stride * 3) {
        out.push(arr[i], arr[i + 1], arr[i + 2]);
      }
    };
    if (this.current?.trajectory) push(this.current.trajectory, 1);
    if (this.humanPositions) push(this.humanPositions, 24);
    const scene = this.current?.scene?.positions;
    if (scene) push(scene, Math.max(1, Math.floor(scene.length / 3 / 1500)));
    return out;
  }

  /**
   * Frame the sample from the capture camera's viewpoint.
   *
   * The eye slides along the capture axis until the focus points fit the
   * frustum. The 90th percentile rather than the maximum sets the distance, so
   * the handful of scene points that sit right beside the lens (MoGe
   * reconstructs everything the photo saw, including the near walls) cannot
   * push the whole scene into the distance. meta.camera.backoff keeps the
   * person from filling the frame as they pass the camera.
   */
  resetView() {
    if (!this.current) return;
    const cam = this.current.meta.camera || {};
    const target = new THREE.Vector3(...(cam.target || [0, 1, 0]));
    const fwd = new THREE.Vector3(...(cam.forward || [0, 0, -1])).normalize();
    const minBackoff = Number(cam.backoff) || 0;
    const base = cam.eye
      ? new THREE.Vector3(...cam.eye).addScaledVector(fwd, minBackoff)
      : target.clone().addScaledVector(fwd, -4);

    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    if (!Number.isFinite(right.x) || right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const camUp = new THREE.Vector3().crossVectors(right, fwd).normalize();

    const MARGIN = 0.92;
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * MARGIN;
    const tanX = tanY * this.camera.aspect;

    const pts = this.focusPoints();
    const needed = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pts.length; i += 3) {
      v.set(pts[i], pts[i + 1], pts[i + 2]).sub(base);
      const z = v.dot(fwd);
      const x = Math.abs(v.dot(right));
      const y = Math.abs(v.dot(camUp));
      needed.push(Math.max(x / tanX, y / tanY) - z);
    }
    needed.sort((a, b) => a - b);
    const q90 = needed.length ? needed[Math.floor((needed.length - 1) * 0.9)] : minBackoff;
    const backoff = Math.max(minBackoff, q90, 0.5);

    const eye = base.clone().addScaledVector(fwd, -backoff);
    // keep the look direction exactly on the capture axis
    const aim = eye.clone().addScaledVector(fwd, Math.max(target.clone().sub(eye).dot(fwd), 1));

    this.camera.position.copy(eye);
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(aim);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = Math.max(30, eye.distanceTo(aim) * 8);
    this.controls.update();
  }

  setPlaying(on) {
    this.playing = on;
    if (!on) this.holdUntil = 0;
    this.el.play.textContent = on ? '❙❙  Pause' : '▶  Play';
    this.el.play.setAttribute('aria-pressed', String(on));
  }

  step(delta) {
    if (!this.current) return;
    this.holdUntil = 0;
    const n = this.current.meta.human.frames;
    this.setFrame((Math.round(this.frame) + delta + n) % n);
  }

  setFrame(value) {
    if (!this.current) return;
    const meta = this.current.meta;
    const n = meta.human.frames;
    this.frame = ((value % n) + n) % n;

    const a = Math.floor(this.frame);
    const b = (a + 1) % n;
    dequantizeFrame(this.current.quantVerts, meta.human.verts, meta.human.origin,
      meta.human.step, a, b, this.frame - a, this.humanPositions);
    this.humanGeometry.attributes.position.needsUpdate = true;
    this.humanGeometry.computeVertexNormals();
    this.humanGeometry.computeBoundingSphere();

    this.el.slider.value = String(a);
    this.el.frameLabel.textContent = `${a + 1} / ${n}`;
    const seg = (meta.phases || []).find((s) => a >= s.start && a < s.end);
    const style = seg ? (PHASE_STYLE[seg.phase] || PHASE_STYLE.all) : null;
    this.el.phaseLabel.textContent = style ? style.label : '';
    this.el.phaseLabel.style.color = style ? style.text : 'inherit';
    this.updatePromptProgress(this.frame);
  }

  tick() {
    const dt = this.clock.getDelta();
    if (this.playing && this.current && !this.loading) {
      const n = this.current.meta.human.frames;
      const fps = this.current.meta.fps || 30;
      if (this.holdUntil) {
        if (performance.now() >= this.holdUntil) {
          this.holdUntil = 0;
          this.setFrame(0);
        }
      } else {
        const next = this.frame + dt * fps * this.speed;
        if (next >= n - 1) {
          this.setFrame(n - 1);                 // land exactly on the final pose
          this.holdUntil = performance.now() + LOOP_HOLD_MS;
        } else {
          this.setFrame(next);
        }
      }
    }
    this.controls.update();
    this.renderer.render(this.scene3, this.camera);
  }
}

function disposeTree(group) {
  group.traverse?.((obj) => {
    obj.geometry?.dispose?.();
    const m = obj.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}

function describeError(err) {
  const msg = String(err?.message || err);
  if (location.protocol === 'file:') {
    return 'Open this page over HTTP — browsers block local data files on file://. '
      + 'Run:  python -m http.server  in the website folder.';
  }
  return `Could not load the demo data: ${msg}`;
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function main() {
  const root = document.body;
  const viewer = new DemoViewer(root);
  try {
    const manifest = await fetchJSON(`${DATA_ROOT}/manifest.json`);
    const samples = manifest.samples || [];
    if (!samples.length) throw new Error('manifest.json lists no samples');
    viewer.setSamples(samples);
    const wanted = new URLSearchParams(location.search).get('sample');
    const start = Math.max(0, samples.findIndex((s) => s.slug === wanted));
    await viewer.select(start);
  } catch (err) {
    viewer.loading = false;
    viewer.status(describeError(err), 'error');
    console.error(err);
  }
}

main();
