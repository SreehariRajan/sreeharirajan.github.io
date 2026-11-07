/*
 * ENACT pipeline walkthrough
 * ──────────────────────────
 * Steps through the five stages for one sample, accumulating the 3D evidence
 * each stage produces: the photo, then the reconstructed scene and completed
 * object meshes, then the predicted affordance and the fitted contact poses,
 * then the planned route, then the generated motion.
 *
 * Data comes from tools/export_pipeline.py (stages.json + extras) layered on
 * top of the motion bundle that tools/export_demo.py already wrote. Payloads
 * are fetched the first time a stage needs them, so opening the page costs
 * one photo rather than the whole sample.
 */

import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { fetchJSON, fetchBinary, decodeDQ16, dequantizeFrame, dequantizePoints } from './codec.js';

const DATA_ROOT = 'data';
const DEFAULT_DEMO = 'kitchen_9';   // ?demo=<slug> picks another
const LOOP_HOLD_MS = 1000;
const TRAJECTORY_RADIUS = 0.022;

/** What each colour in the viewport means, keyed by layer. */
/** One colour per segmented target, in keyframe order. */
const MASK_COLORS = [0xff6b6b, 0x4cc9f0, 0xffd166, 0x06d6a0, 0xc77dff, 0xff9e4a];

const LEGEND = {
  scene:      { label: 'scene point cloud (MoGe)', swatch: 'linear-gradient(135deg,#cbb79a,#8fa4bd)' },
  objectMask: { label: 'Grounded-SAM target masks', swatch: 'linear-gradient(90deg,#ff6b6b,#4cc9f0,#ffd166,#06d6a0)' },
  objects:    { label: 'completed object mesh (SAM 3D)', swatch: '#c89a6a' },
  floor:      { label: 'walkable floor', swatch: '#cfdcf0' },
  affordance: { label: 'contact affordance, low → high', swatch: 'linear-gradient(90deg,#0000ff,#00c800,#ff0000)' },
  initPose:   { label: 'GVHMR pose initialisation', swatch: '#aab4c4' },
  keyframe:   { label: 'fitted contact pose', swatch: '#ffd919' },
  planned:    { label: 'planned route (A*)', swatch: '#2fd98f' },
  human:      { label: 'generated motion', swatch: '#5082ff' },
};

const PHASE_STYLE = {
  walk:        { label: 'walk',        color: '#4c8dff', ink: '#ffffff', text: '#7fb0ff' },
  interaction: { label: 'interaction', color: '#ffd919', ink: '#4a3b00', text: '#ffd919' },
  transition:  { label: 'transition',  color: '#9aa4b2', ink: '#ffffff', text: '#9aa4b2' },
  all:         { label: 'motion',      color: '#4c8dff', ink: '#ffffff', text: '#7fb0ff' },
};

/** Positions-only quantised blob (the walkable floor). */
function dequantizePositions(buffer, count, origin, step) {
  const q = new Uint16Array(buffer, 0, count * 3);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3]     = origin[0] + q[i * 3]     * step[0];
    out[i * 3 + 1] = origin[1] + q[i * 3 + 1] * step[1];
    out[i * 3 + 2] = origin[2] + q[i * 3 + 2] * step[2];
  }
  return out;
}

class Walkthrough {
  constructor() {
    this.canvas = document.querySelector('#stage');
    this.loads = new Map();          // key → promise, so each payload loads once
    this.stageIndex = 0;
    this.frame = 0;
    this.holdUntil = 0;
    this.playing = false;
    this.loading = false;
    this.layers = {};
    this.initThree();
    this.initUI();
  }

  /* ── three.js ──────────────────────────────────────────────────────────── */

  initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setClearColor(0x0d1117, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene3 = new THREE.Scene();
    this.baseFov = 50;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.01, 500);
    this.camera.position.set(0, 1.6, 4);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;

    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x2a3240, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2.5, 5, 3);
    this.scene3.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    fill.position.set(-3, 2, -2.5);
    this.scene3.add(fill);

    this.group = new THREE.Group();
    this.scene3.add(this.group);
    this.nodes = {};                 // layer name → Object3D (or array)

    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.resize();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
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
  }

  splatSize() {
    const h = this.renderer.domElement.height || 600;
    const s = this.sceneStats;
    const mult = Number(this.el?.pointSize?.value) || 1;
    if (s?.spacingImagePx && s?.imageSize?.[1]) {
      return Math.max(1, 1.35 * s.spacingImagePx * (h / s.imageSize[1])) * mult;
    }
    return 2.2 * Math.min(window.devicePixelRatio || 1, 2) * mult;
  }

  applySplatSize() {
    const size = this.splatSize();
    if (this.nodes.scene) this.nodes.scene.material.size = size;
    for (const p of this.nodes.affordance || []) p.material.size = size * 0.7;
    if (this.nodes.floor) this.nodes.floor.material.size = size * 1.6;
    if (this.nodes.objectMask) this.nodes.objectMask.material.size = size * 1.25;
  }

  /* ── DOM ───────────────────────────────────────────────────────────────── */

  initUI() {
    this.el = {
      rail: document.querySelector('#rail'),
      legend: document.querySelector('#legend'),
      number: document.querySelector('#stage-number'),
      title: document.querySelector('#stage-title'),
      subtitle: document.querySelector('#stage-subtitle'),
      body: document.querySelector('#stage-body'),
      gallery: document.querySelector('#gallery'),
      keyframes: document.querySelector('#keyframes'),
      prompt: document.querySelector('#prompt'),
      docTitle: document.querySelector('#doc-title'),
      photo: document.querySelector('#photo-stage'),
      photoImg: document.querySelector('#photo-stage img'),
      photoPrompt: document.querySelector('#photo-prompt'),
      status: document.querySelector('#status'),
      prev: document.querySelector('#prev'),
      next: document.querySelector('#next'),
      transport: document.querySelector('#transport'),
      play: document.querySelector('#play'),
      slider: document.querySelector('#timeline'),
      phases: document.querySelector('#phases'),
      frameLabel: document.querySelector('#frame-label'),
      pointSize: document.querySelector('#point-size'),
      lightbox: document.querySelector('#lightbox'),
      lightboxImg: document.querySelector('#lightbox img'),
      lightboxCap: document.querySelector('#lightbox figcaption'),
    };

    this.el.prev.addEventListener('click', () => this.goto(this.stageIndex - 1));
    this.el.next.addEventListener('click', () => this.goto(this.stageIndex + 1));
    document.querySelector('#reset-view').addEventListener('click', () => this.resetView());
    this.el.play.addEventListener('click', () => this.setPlaying(!this.playing));
    this.el.slider.addEventListener('input', () => {
      this.setPlaying(false);
      this.holdUntil = 0;
      this.setFrame(Number(this.el.slider.value));
    });
    this.el.pointSize.addEventListener('input', () => this.applySplatSize());
    this.el.lightbox.addEventListener('click', () => this.el.lightbox.classList.add('is-hidden'));

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'ArrowRight') { e.preventDefault(); this.goto(this.stageIndex + 1); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); this.goto(this.stageIndex - 1); }
      else if (e.code === 'Escape') this.el.lightbox.classList.add('is-hidden');
      else if (e.code === 'Space' && this.layers.timeline) {
        e.preventDefault();
        this.setPlaying(!this.playing);
      }
    });
  }

  status(text, kind = 'info') {
    this.el.status.textContent = text || '';
    this.el.status.dataset.kind = kind;
    this.el.status.classList.toggle('is-hidden', !text);
  }

  setLoading(on, message = '') {
    this.loading = on;
    if (on) {
      this.setPlaying(false);
      this.status(message);
    } else {
      this.status('');
    }
  }

  /** Run `fn` once per key; later calls await the same promise. */
  once(key, fn) {
    if (!this.loads.has(key)) this.loads.set(key, fn());
    return this.loads.get(key);
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */

  async start() {
    const params = new URLSearchParams(location.search);
    const slug = params.get('demo') || DEFAULT_DEMO;
    this.dir = `${DATA_ROOT}/pipeline_${slug}`;
    this.meta = await fetchJSON(`${this.dir}/stages.json`);
    this.bundleDir = `${DATA_ROOT}/${this.meta.bundle}`;
    this.cameraMeta = (await this.bundleMeta()).camera;

    this.el.docTitle.textContent = this.meta.title || this.meta.slug;
    this.el.prompt.textContent = this.meta.prompt || '';
    this.el.photoPrompt.textContent = this.meta.prompt || '';
    this.buildRail();
    this.buildKeyframeCards();
    if (this.meta.image) this.el.photoImg.src = `${this.bundleDir}/${this.meta.image}`;

    const wanted = Number(params.get('stage'));
    await this.goto(Number.isFinite(wanted) && wanted > 0 ? wanted - 1 : 0);
  }

  buildRail() {
    this.el.rail.innerHTML = '';
    this.meta.stages.forEach((stage, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'step';
      btn.innerHTML = `<span class="step-n">${stage.number}</span>`
        + `<span class="step-t">${stage.title}</span>`;
      btn.addEventListener('click', () => this.goto(i));
      this.el.rail.appendChild(btn);
    });
  }

  buildKeyframeCards() {
    this.el.keyframes.innerHTML = '';
    for (const kf of this.meta.keyframes || []) {
      const card = document.createElement('div');
      card.className = 'kf';
      const part = kf.targetPart ? ` · ${kf.targetPart}` : '';
      card.innerHTML = `<b>KF${kf.keyframeId}</b> <span class="kf-verb">${kf.verb}</span>`
        + `<span class="kf-obj">${kf.targetObject || ''}${part}</span>`
        + `<span class="kf-meta">${kf.bodyPart || ''}${
          kf.orientation != null ? ` · yaw ${kf.orientation}°` : ''}</span>`;
      this.el.keyframes.appendChild(card);
    }
  }

  /* ── payloads ──────────────────────────────────────────────────────────── */

  async bundleMeta() {
    return this.once('meta', async () => fetchJSON(`${this.bundleDir}/meta.json`));
  }

  async loadScene() {
    return this.once('scene', async () => {
      const m = await this.bundleMeta();
      if (!m.scene) return;
      this.sceneStats = m.scene;
      const buf = await fetchBinary(`${this.bundleDir}/${m.scene.file}`);
      const { positions, colors } = dequantizePoints(
        buf, m.scene.count, m.scene.origin, m.scene.step, m.scene.colorOffset, m.scene.codec);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: this.splatSize(), vertexColors: true, sizeAttenuation: false }));
      pts.visible = false;
      this.nodes.scene = pts;
      this.group.add(pts);
      this.scenePositions = positions;

      // The lifted Grounded-SAM masks, drawn over the cloud: the points that
      // belong to a target, in that target's colour. Same geometry as the
      // scene cloud, just a subset — no second point cloud in the bundle.
      if (m.scene.objectIdOffset !== undefined) {
        const ids = new Uint8Array(buf, m.scene.objectIdOffset, m.scene.count);
        const names = m.scene.objectNames || [];
        const sel = [];
        for (let i = 0; i < ids.length; i++) if (ids[i]) sel.push(i);
        if (sel.length) {
          const mp = new Float32Array(sel.length * 3);
          const mc = new Uint8Array(sel.length * 3);
          sel.forEach((p, k) => {
            mp[k * 3] = positions[p * 3];
            mp[k * 3 + 1] = positions[p * 3 + 1];
            mp[k * 3 + 2] = positions[p * 3 + 2];
            const c = MASK_COLORS[(ids[p] - 1) % MASK_COLORS.length];
            mc[k * 3] = (c >> 16) & 255;
            mc[k * 3 + 1] = (c >> 8) & 255;
            mc[k * 3 + 2] = c & 255;
          });
          const mg = new THREE.BufferGeometry();
          mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
          mg.setAttribute('color', new THREE.BufferAttribute(mc, 3, true));
          const mask = new THREE.Points(mg, new THREE.PointsMaterial({
            size: this.splatSize() * 1.25, vertexColors: true, sizeAttenuation: false }));
          mask.visible = false;
          mask.renderOrder = 1;
          this.nodes.objectMask = mask;
          this.group.add(mask);
          this.maskNames = names;
        }
      }
    });
  }

  async loadObjects() {
    return this.once('objects', async () => {
      const o = this.meta.objectMeshes;
      if (!o) return;
      const buf = await fetchBinary(`${this.dir}/${o.file}`);
      const { positions, colors } = dequantizePoints(
        buf, o.vertexCount, o.origin, o.step, o.colorOffset);
      const idx = new Uint32Array(buf, o.indexOffset, o.indexCount);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide }));
      mesh.visible = false;
      this.nodes.objects = mesh;
      this.group.add(mesh);
    });
  }

  async loadFloor() {
    return this.once('floor', async () => {
      const f = this.meta.floor;
      if (!f) return;
      const buf = await fetchBinary(`${this.dir}/${f.file}`);
      const positions = dequantizePositions(buf, f.count, f.origin, f.step);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: this.splatSize() * 1.6, color: 0xcfdcf0, sizeAttenuation: false,
        transparent: true, opacity: 0.5, depthWrite: false }));
      pts.visible = false;
      this.nodes.floor = pts;
      this.group.add(pts);
    });
  }

  async loadPlanned() {
    return this.once('planned', async () => {
      const p = this.meta.planned;
      if (!p) return;
      const buf = await fetchBinary(`${this.dir}/${p.file}`);
      const pos = new Float32Array(buf, 0, p.count * 3);
      const pts = [];
      for (let i = 0; i < pos.length; i += 3) {
        const v = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
        if (!pts.length || v.distanceToSquared(pts[pts.length - 1]) > 1e-8) pts.push(v);
      }
      if (pts.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const tube = new THREE.TubeGeometry(
        curve, Math.min(Math.max(pts.length, 32), 1200), TRAJECTORY_RADIUS, 8, false);
      const mesh = new THREE.Mesh(tube, new THREE.MeshStandardMaterial({
        color: 0x2fd98f, roughness: 0.5, emissive: 0x0e4531, emissiveIntensity: 0.45 }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.nodes.planned = mesh;
      this.group.add(mesh);
    });
  }

  async loadFaces() {
    return this.once('faces', async () => {
      const m = await this.bundleMeta();
      const buf = await fetchBinary(`${this.bundleDir}/${m.human.faces.file}`);
      this.faces = m.human.faces.dtype === 'uint32' ? new Uint32Array(buf) : new Uint16Array(buf);
    });
  }

  async loadPoses() {
    return this.once('poses', async () => {
      const m = await this.bundleMeta();
      await this.loadFaces();

      const build = (q, spec, i, material) => {
        const positions = new Float32Array(spec.verts * 3);
        dequantizeFrame(q, spec.verts, spec.origin, spec.step, i, i, 0, positions);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(new THREE.BufferAttribute(this.faces, 1));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, material);
        mesh.visible = false;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        return mesh;
      };

      if (m.keyframePoses) {
        const kp = m.keyframePoses;
        const q = decodeDQ16(await fetchBinary(`${this.bundleDir}/${kp.file}`), kp.frames, kp.verts);
        this.nodes.keyframe = Array.from({ length: kp.frames }, (_, i) => build(q, kp, i,
          new THREE.MeshStandardMaterial({
            color: 0xffd919, roughness: 0.65, emissive: 0x5a4200, emissiveIntensity: 0.25,
            transparent: true, opacity: 0.62, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 })));
      }
      if (this.meta.initPose) {
        const ip = this.meta.initPose;
        const q = decodeDQ16(await fetchBinary(`${this.dir}/${ip.file}`), ip.frames, ip.verts);
        this.nodes.initPose = Array.from({ length: ip.frames }, (_, i) => build(q, ip, i,
          new THREE.MeshStandardMaterial({
            color: 0xaab4c4, roughness: 0.8, transparent: true, opacity: 0.4,
            depthWrite: false })));
      }

      this.nodes.affordance = [];
      for (const layer of m.affordance || []) {
        const buf = await fetchBinary(`${this.bundleDir}/${layer.file}`);
        const { positions, colors } = dequantizePoints(
          buf, layer.count, layer.origin, layer.step, layer.colorOffset, layer.codec);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({
          size: this.splatSize() * 0.7, vertexColors: true, sizeAttenuation: false }));
        pts.visible = false;
        this.nodes.affordance.push(pts);
        this.group.add(pts);
      }
    });
  }

  async loadMotion() {
    return this.once('motion', async () => {
      const m = await this.bundleMeta();
      await this.loadFaces();
      const h = m.human;
      this.motion = {
        q: decodeDQ16(await fetchBinary(`${this.bundleDir}/${h.file}`), h.frames, h.verts),
        spec: h, frames: h.frames, fps: m.fps || 30, phases: m.phases || [],
      };
      const positions = new Float32Array(h.verts * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(new THREE.BufferAttribute(this.faces, 1));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x5082ff, roughness: 0.55, metalness: 0.05 }));
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.humanPositions = positions;
      this.humanGeometry = geo;
      this.nodes.human = mesh;
      this.group.add(mesh);

      this.el.slider.max = String(Math.max(0, h.frames - 1));
      this.buildPhaseRibbon();
      this.setFrame(0);
    });
  }

  /* ── stages ────────────────────────────────────────────────────────────── */

  async goto(index) {
    const stages = this.meta.stages;
    this.stageIndex = Math.max(0, Math.min(index, stages.length - 1));
    const stage = stages[this.stageIndex];
    this.layers = stage.layers || {};

    [...this.el.rail.children].forEach((b, i) => {
      b.classList.toggle('is-active', i === this.stageIndex);
      b.classList.toggle('is-done', i < this.stageIndex);
    });
    this.el.number.textContent = `Stage ${stage.number} of ${stages.length}`;
    this.el.title.textContent = stage.title;
    this.el.subtitle.textContent = stage.subtitle || '';
    this.el.body.innerHTML = '';
    for (const para of (stage.body || '').split('\n\n')) {
      const el = document.createElement('p');
      el.textContent = para;
      this.el.body.appendChild(el);
    }
    this.el.prev.disabled = this.stageIndex === 0;
    this.el.next.disabled = this.stageIndex === stages.length - 1;
    this.el.keyframes.classList.toggle('is-hidden', this.stageIndex !== 0);
    this.buildGallery(stage.images || []);
    this.buildLegend();

    const needed = [];
    if (this.layers.scene || this.layers.objectMask) {
      needed.push(['the reconstructed scene', () => this.loadScene()]);
    }
    if (this.layers.objects) needed.push(['the object meshes', () => this.loadObjects()]);
    if (this.layers.floor) needed.push(['the walkable floor', () => this.loadFloor()]);
    if (this.layers.planned) needed.push(['the planned route', () => this.loadPlanned()]);
    if (this.layers.keyframe || this.layers.initPose || this.layers.affordance) {
      needed.push(['the contact poses', () => this.loadPoses()]);
    }
    if (this.layers.human) needed.push(['the generated motion', () => this.loadMotion()]);

    if (needed.length) {
      this.setLoading(true, `Loading ${needed[needed.length - 1][0]} …`);
      try {
        for (const [, fn] of needed) await fn();
      } catch (err) {
        this.setLoading(false);
        this.status(`Could not load this stage: ${err.message}`, 'error');
        console.error(err);
        return;
      }
      this.setLoading(false);
    }

    this.applyLayers();
    if (!this.framed && this.nodes.scene) { this.resetView(); this.framed = true; }
    if (this.layers.timeline) {
      this.holdUntil = 0;
      this.setFrame(0);
      this.setPlaying(true);
    }
  }

  applyLayers() {
    const show = (node, on) => {
      if (!node) return;
      if (Array.isArray(node)) node.forEach((n) => { n.visible = on; });
      else node.visible = on;
    };
    show(this.nodes.scene, !!this.layers.scene);
    show(this.nodes.objects, !!this.layers.objects);
    show(this.nodes.objectMask, !!this.layers.objectMask);
    show(this.nodes.floor, !!this.layers.floor);
    show(this.nodes.planned, !!this.layers.planned);
    show(this.nodes.keyframe, !!this.layers.keyframe);
    show(this.nodes.initPose, !!this.layers.initPose);
    show(this.nodes.affordance, !!this.layers.affordance);
    show(this.nodes.human, !!this.layers.human);

    this.el.photo.classList.toggle('is-hidden', !this.layers.photo);
    this.el.transport.classList.toggle('is-hidden', !this.layers.timeline);
    if (!this.layers.timeline) this.setPlaying(false);
    this.applySplatSize();
  }

  buildLegend() {
    const keys = Object.keys(LEGEND).filter((k) => this.layers[k]);
    this.el.legend.innerHTML = '';
    this.el.legend.classList.toggle('is-hidden', !keys.length);
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="sw" style="background:${LEGEND[k].swatch}"></span>`
        + `<span>${LEGEND[k].label}</span>`;
      this.el.legend.appendChild(row);
    }
  }

  buildGallery(images) {
    this.el.gallery.innerHTML = '';
    this.el.gallery.classList.toggle('is-hidden', !images.length);
    for (const img of images) {
      const fig = document.createElement('figure');
      fig.className = 'shot';
      fig.innerHTML = `<img loading="lazy" src="${this.dir}/${img.src}" alt="${img.caption}">`
        + `<figcaption>${img.caption}</figcaption>`;
      fig.addEventListener('click', () => {
        this.el.lightboxImg.src = `${this.dir}/${img.src}`;
        this.el.lightboxCap.textContent = img.caption;
        this.el.lightbox.classList.remove('is-hidden');
      });
      this.el.gallery.appendChild(fig);
    }
  }

  /* ── playback ──────────────────────────────────────────────────────────── */

  buildPhaseRibbon() {
    const total = Math.max(1, this.motion.frames);
    this.el.phases.innerHTML = '';
    for (const seg of this.motion.phases) {
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
      if (span / total > 0.12) bar.textContent = style.label;
      this.el.phases.appendChild(bar);
    }
  }

  setPlaying(on) {
    this.playing = on && !!this.motion;
    this.el.play.textContent = this.playing ? '❙❙  Pause' : '▶  Play';
  }

  setFrame(value) {
    if (!this.motion) return;
    const n = this.motion.frames;
    this.frame = ((value % n) + n) % n;
    const a = Math.floor(this.frame);
    const b = (a + 1) % n;
    dequantizeFrame(this.motion.q, this.motion.spec.verts, this.motion.spec.origin,
      this.motion.spec.step, a, b, this.frame - a, this.humanPositions);
    this.humanGeometry.attributes.position.needsUpdate = true;
    this.humanGeometry.computeVertexNormals();
    this.humanGeometry.computeBoundingSphere();
    this.el.slider.value = String(a);
    this.el.frameLabel.textContent = `${a + 1} / ${n}`;
  }

  resetView() {
    const cam = this.cameraMeta || {};
    const fwd = new THREE.Vector3(...(cam.forward || [0, 0, -1])).normalize();
    const target = new THREE.Vector3(...(cam.target || [0, 1, 0]));
    const base = cam.eye
      ? new THREE.Vector3(...cam.eye).addScaledVector(fwd, Number(cam.backoff) || 0)
      : target.clone().addScaledVector(fwd, -4);

    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const camUp = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 0.92;
    const tanX = tanY * this.camera.aspect;

    const needed = [];
    const v = new THREE.Vector3();
    const pts = this.scenePositions;
    const stride = pts ? Math.max(3, Math.floor(pts.length / 3 / 1500) * 3) : 0;
    for (let i = 0; pts && i < pts.length; i += stride) {
      v.set(pts[i], pts[i + 1], pts[i + 2]).sub(base);
      needed.push(Math.max(Math.abs(v.dot(right)) / tanX, Math.abs(v.dot(camUp)) / tanY)
        - v.dot(fwd));
    }
    needed.sort((a, b) => a - b);
    const backoff = Math.max(Number(cam.backoff) || 0,
      needed.length ? needed[Math.floor((needed.length - 1) * 0.9)] : 0, 0.5);

    const eye = base.clone().addScaledVector(fwd, -backoff);
    const aim = eye.clone().addScaledVector(fwd, Math.max(target.clone().sub(eye).dot(fwd), 1));
    this.camera.position.copy(eye);
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(aim);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = Math.max(30, eye.distanceTo(aim) * 8);
    this.controls.update();
  }

  tick() {
    const dt = this.clock.getDelta();
    if (this.playing && this.motion && !this.loading) {
      const n = this.motion.frames;
      if (this.holdUntil) {
        if (performance.now() >= this.holdUntil) { this.holdUntil = 0; this.setFrame(0); }
      } else {
        const next = this.frame + dt * this.motion.fps;
        if (next >= n - 1) {
          this.setFrame(n - 1);
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

async function main() {
  const app = new Walkthrough();
  try {
    await app.start();
  } catch (err) {
    const msg = location.protocol === 'file:'
      ? 'Open this page over HTTP — browsers block local data files on file://. '
        + 'Run:  python -m http.server  in the website folder.'
      : `Could not load the walkthrough: ${err.message}`;
    app.status(msg, 'error');
    console.error(err);
  }
}

main();
