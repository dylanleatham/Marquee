// Deterministic 2D value noise — the smooth, organic randomness behind the aurora and shimmer
// effects. Pure and dependency-free: a hashed value at each integer lattice point, smootherstep-
// interpolated between them. Same inputs → same output, always (no Math.random), so effects that use
// it stay testable and previewable.

/** Hash two integers to a stable value in [0, 1). Bit-mixing; not cryptographic, just well-spread. */
function hash2(xi: number, yi: number): number {
  // `| 0` / `>>> 0` keep everything in 32-bit lane so the mix is stable across platforms.
  let h = (xi * 374761393 + yi * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Ken Perlin's smootherstep — a 0..1 ease with zero 1st and 2nd derivatives at the ends. */
const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Value noise sampled at (`x`, `y`), returning a smooth field in [0, 1). Integer steps in either
 * axis cross into a fresh lattice cell; fractional movement eases between the four corners, so the
 * field drifts continuously as you animate a coordinate over time.
 */
export function valueNoise2D(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = hash2(x0, y0);
  const v10 = hash2(x0 + 1, y0);
  const v01 = hash2(x0, y0 + 1);
  const v11 = hash2(x0 + 1, y0 + 1);
  const ux = smoother(fx);
  const uy = smoother(fy);
  const top = v00 + (v10 - v00) * ux;
  const bottom = v01 + (v11 - v01) * ux;
  return top + (bottom - top) * uy;
}
