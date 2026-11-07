/*
 * Bundle loading + decoding for the ENACT interactive demos.
 * ─────────────────────────────────────────────────────────
 * Pure data layer: no three.js, no DOM. tools/test_bundles.mjs exercises this
 * file directly against a served bundle, so keep it free of browser-only APIs
 * other than fetch/DecompressionStream.
 *
 * Bundle format (written by tools/export_demo.py, described in README.md):
 *   human.bin   dq16  — per frame: a high-byte plane then a low-byte plane of
 *                       the wrapping int16 delta against the previous frame,
 *                       over uint16-quantised vertex positions.
 *   faces.bin         — uint16 (or uint32) triangle indices, shared by the
 *                       animation and the fitted keyframe poses.
 *   keyframe_poses.bin  dq16 — one frame per Stage-3 contact pose.
 *   scene.bin         — uint16 quantised xyz, then uint8 rgb at colorOffset.
 *   afford_kf*.bin    — same layout as scene.bin.
 *   traj.bin          — little-endian float32 xyz.
 * Positions are reconstructed as  origin + q * step  (metres, SMPL-X space, +Y up).
 */

export async function gunzip(buffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot un-gzip the demo data '
      + '(no DecompressionStream). Re-export with --compress none.');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Fetch a binary blob, un-gzipping only when the bytes really are gzip —
 * a server that sets Content-Encoding hands back plain bytes already.
 */
export async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength >= 2) {
    const head = new Uint8Array(buffer, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) return gunzip(buffer);
  }
  return buffer;
}

export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

/** Reverse of export_demo.encode_frames_dq16(). Returns uint16 [frames*verts*3]. */
export function decodeDQ16(buffer, frames, verts) {
  const n = verts * 3;
  const bytes = new Uint8Array(buffer);
  if (bytes.length < frames * 2 * n) {
    throw new Error(`motion blob is short: ${bytes.length} bytes, `
      + `expected ${frames * 2 * n} for ${frames}×${verts}`);
  }
  const out = new Uint16Array(frames * n);
  const running = new Uint16Array(n);
  for (let f = 0; f < frames; f++) {
    const hi = f * 2 * n;
    const lo = hi + n;
    const dst = f * n;
    for (let i = 0; i < n; i++) {
      running[i] = (running[i] + ((bytes[hi + i] << 8) | bytes[lo + i])) & 0xffff;
      out[dst + i] = running[i];
    }
  }
  return out;
}

/** Dequantise frame `a` into `target`, blended towards frame `b` by `t` ∈ [0,1). */
export function dequantizeFrame(q, verts, origin, step, a, b, t, target) {
  const base = a * verts * 3;
  const next = b * verts * 3;
  const [ox, oy, oz] = origin;
  const [sx, sy, sz] = step;
  if (!(t > 0) || a === b) {
    for (let v = 0, i = base, o = 0; v < verts; v++) {
      target[o++] = ox + q[i++] * sx;
      target[o++] = oy + q[i++] * sy;
      target[o++] = oz + q[i++] * sz;
    }
    return target;
  }
  const u = 1 - t;
  for (let v = 0, i = base, j = next, o = 0; v < verts; v++) {
    target[o++] = ox + (q[i++] * u + q[j++] * t) * sx;
    target[o++] = oy + (q[i++] * u + q[j++] * t) * sy;
    target[o++] = oz + (q[i++] * u + q[j++] * t) * sz;
  }
  return target;
}

/**
 * Quantised point cloud → { positions: Float32Array, colors: Uint8Array }.
 *
 * `codec: "mdq16"` means the positions are Z-ordered and stored as wrapping
 * uint16 deltas (export_demo.encode_points_mdq16) — a running sum rebuilds
 * them exactly. Anything else is plain absolute uint16.
 */
export function dequantizePoints(buffer, count, origin, step, colorOffset, codec) {
  const q = new Uint16Array(buffer, 0, count * 3);
  const positions = new Float32Array(count * 3);
  const [ox, oy, oz] = origin;
  const [sx, sy, sz] = step;
  if (codec === 'mdq16') {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < count; i++) {
      x = (x + q[i * 3]) & 0xffff;
      y = (y + q[i * 3 + 1]) & 0xffff;
      z = (z + q[i * 3 + 2]) & 0xffff;
      positions[i * 3] = ox + x * sx;
      positions[i * 3 + 1] = oy + y * sy;
      positions[i * 3 + 2] = oz + z * sz;
    }
  } else {
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = ox + q[i * 3]     * sx;
      positions[i * 3 + 1] = oy + q[i * 3 + 1] * sy;
      positions[i * 3 + 2] = oz + q[i * 3 + 2] * sz;
    }
  }
  const colors = new Uint8Array(buffer, colorOffset, count * 3).slice();
  return { positions, colors };
}

/**
 * Load one sample bundle. `entry` is a manifest.json row; `dataRoot` is the
 * directory that holds manifest.json.
 */
export async function loadSample(entry, dataRoot = 'data', onProgress = null) {
  const metaURL = `${dataRoot}/${entry.meta}`;
  const dir = metaURL.slice(0, metaURL.lastIndexOf('/'));
  if (onProgress) onProgress('reading metadata');
  const meta = await fetchJSON(metaURL);

  if (onProgress) onProgress('loading motion');
  const [humanBuf, facesBuf] = await Promise.all([
    fetchBinary(`${dir}/${meta.human.file}`),
    fetchBinary(`${dir}/${meta.human.faces.file}`),
  ]);
  const quantVerts = decodeDQ16(humanBuf, meta.human.frames, meta.human.verts);
  const faces = meta.human.faces.dtype === 'uint32'
    ? new Uint32Array(facesBuf)
    : new Uint16Array(facesBuf);

  let scene = null;
  if (meta.scene) {
    if (onProgress) onProgress('loading scene');
    const buf = await fetchBinary(`${dir}/${meta.scene.file}`);
    scene = dequantizePoints(buf, meta.scene.count, meta.scene.origin,
      meta.scene.step, meta.scene.colorOffset, meta.scene.codec);
  }

  const affordance = [];
  for (const layer of meta.affordance || []) {
    const buf = await fetchBinary(`${dir}/${layer.file}`);
    affordance.push({
      label: layer.label,
      ...dequantizePoints(buf, layer.count, layer.origin, layer.step, layer.colorOffset,
        layer.codec),
    });
  }

  let keyframePoses = null;
  if (meta.keyframePoses) {
    const kp = meta.keyframePoses;
    keyframePoses = decodeDQ16(await fetchBinary(`${dir}/${kp.file}`), kp.frames, kp.verts);
  }

  let trajectory = null;
  if (meta.trajectory) {
    trajectory = new Float32Array(await fetchBinary(`${dir}/${meta.trajectory.file}`));
  }

  return { meta, dir, quantVerts, faces, scene, affordance, trajectory, keyframePoses };
}
