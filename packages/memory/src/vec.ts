/**
 * Small vector helpers. Vectors are unit-length Float32Arrays, so cosine is a
 * dot product; the cache stores them as little-endian base64 so one 512-dim
 * vector is ~2.7 KB of text and round-trips exactly.
 */

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Cosine similarity; 0 when either side is empty or all zeros (an item without a vector never matches by vector). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return 0;
  return ab / Math.sqrt(aa * bb);
}

export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (n === 0) return v;
  const inv = 1 / Math.sqrt(n);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

export function toBase64(v: Float32Array): string {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf.toString("base64");
}

export function fromBase64(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
