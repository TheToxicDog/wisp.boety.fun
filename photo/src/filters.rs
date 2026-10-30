// Neighbourhood filters on single-channel f32 planes.

/// Box blur with an integer radius, edges clamped. O(n) per pass.
pub fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    let norm = 1.0 / (2 * r + 1) as f32;
    let ri = r as isize;
    // Horizontal
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let at = |x: isize| row[x.clamp(0, w as isize - 1) as usize];
        let mut acc: f32 = (-ri..=ri).map(at).sum();
        for x in 0..w {
            tmp[y * w + x] = acc * norm;
            acc += at(x as isize + ri + 1) - at(x as isize - ri);
        }
    }
    // Vertical
    for x in 0..w {
        let at = |y: isize| tmp[y.clamp(0, h as isize - 1) as usize * w + x];
        let mut acc: f32 = (-ri..=ri).map(at).sum();
        for y in 0..h {
            out[y * w + x] = acc * norm;
            acc += at(y as isize + ri + 1) - at(y as isize - ri);
        }
    }
    out
}

/// Three box passes ≈ Gaussian with the given sigma.
pub fn gauss3(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma < 0.4 {
        return src.to_vec();
    }
    if sigma < 2.0 {
        return gauss_exact(src, w, h, sigma);
    }
    // Radius for 3 passes: sigma² = 3·((2r+1)²−1)/12
    let r = (((4.0 * sigma * sigma + 1.0).sqrt() - 1.0) * 0.5).round().max(1.0) as usize;
    let a = box_blur(src, w, h, r);
    let b = box_blur(&a, w, h, r);
    box_blur(&b, w, h, r)
}

/// Separable Gaussian with an explicit kernel (for small radii, e.g. sharpening).
pub fn gauss_exact(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as isize;
    let mut k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let s: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= s);
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let xx = (x as isize + j as isize - r).clamp(0, w as isize - 1) as usize;
                acc += src[y * w + xx] * kv;
            }
            tmp[y * w + x] = acc;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let yy = (y as isize + j as isize - r).clamp(0, h as isize - 1) as usize;
                acc += tmp[yy * w + x] * kv;
            }
            out[y * w + x] = acc;
        }
    }
    out
}

/// Fast self-guided filter (He & Sun): edge-preserving smoothing with radius `r`
/// and regularisation `eps`, computed on a downsampled grid and applied at full res.
pub fn guided(src: &[f32], w: usize, h: usize, r: f32, eps: f32) -> Vec<f32> {
    let s = ((r / 6.0).floor() as usize).max(1);
    let (dw, dh) = ((w + s - 1) / s, (h + s - 1) / s);
    let mut small = vec![0f32; dw * dh];
    if s == 1 {
        small.copy_from_slice(src);
    } else {
        for dy in 0..dh {
            for dx in 0..dw {
                let mut acc = 0.0;
                let mut n = 0.0;
                for y in dy * s..((dy + 1) * s).min(h) {
                    for x in dx * s..((dx + 1) * s).min(w) {
                        acc += src[y * w + x];
                        n += 1.0;
                    }
                }
                small[dy * dw + dx] = acc / n;
            }
        }
    }
    let rd = ((r / s as f32).round() as usize).max(1);
    let mean = box_blur(&small, dw, dh, rd);
    let sq: Vec<f32> = small.iter().map(|v| v * v).collect();
    let mean_sq = box_blur(&sq, dw, dh, rd);
    let mut a = vec![0f32; dw * dh];
    let mut b = vec![0f32; dw * dh];
    for i in 0..dw * dh {
        let var = (mean_sq[i] - mean[i] * mean[i]).max(0.0);
        a[i] = var / (var + eps);
        b[i] = mean[i] - a[i] * mean[i];
    }
    let ma = box_blur(&a, dw, dh, rd);
    let mb = box_blur(&b, dw, dh, rd);
    let mut out = vec![0f32; w * h];
    let inv = 1.0 / s as f32;
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * inv - 0.5).clamp(0.0, (dh - 1) as f32);
        let y0 = fy as usize;
        let y1 = (y0 + 1).min(dh - 1);
        let ty = fy - y0 as f32;
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * inv - 0.5).clamp(0.0, (dw - 1) as f32);
            let x0 = fx as usize;
            let x1 = (x0 + 1).min(dw - 1);
            let tx = fx - x0 as f32;
            let bl = |p: &[f32]| {
                let t = p[y0 * dw + x0] + (p[y0 * dw + x1] - p[y0 * dw + x0]) * tx;
                let u = p[y1 * dw + x0] + (p[y1 * dw + x1] - p[y1 * dw + x0]) * tx;
                t + (u - t) * ty
            };
            out[y * w + x] = bl(&ma) * src[y * w + x] + bl(&mb);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_blur_preserves_constant() {
        let v = vec![0.5f32; 37 * 23];
        let b = box_blur(&v, 37, 23, 5);
        assert!(b.iter().all(|x| (x - 0.5).abs() < 1e-5));
    }

    #[test]
    fn guided_keeps_step_edge() {
        let (w, h) = (64, 8);
        let v: Vec<f32> = (0..w * h).map(|i| if i % w < 32 { 0.0 } else { 4.0 }).collect();
        let g = guided(&v, w, h, 12.0, 0.05);
        assert!(g[3 * w + 28] < 0.4, "{}", g[3 * w + 28]);
        assert!(g[3 * w + 36] > 3.6, "{}", g[3 * w + 36]);
    }
}
