// Colour science: matrices, white balance on the Planckian locus, Bradford
// adaptation and fast sRGB transfer functions.

pub type M3 = [[f32; 3]; 3];

pub const SRGB2XYZ: M3 = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
];
pub const XYZ2SRGB: M3 = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
];
pub const D65: (f64, f64) = (0.31271, 0.32902);
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];
pub const IDENTITY: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[inline]
pub fn luma(c: [f32; 3]) -> f32 {
    c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
}

pub fn mul(a: &M3, b: &M3) -> M3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    r
}

#[inline]
pub fn mulv(a: &M3, v: [f32; 3]) -> [f32; 3] {
    [
        a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
        a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
        a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
    ]
}

pub fn scale(a: &M3, s: f32) -> M3 {
    let mut r = *a;
    for row in r.iter_mut() {
        for v in row.iter_mut() {
            *v *= s;
        }
    }
    r
}

pub fn inv(m: &M3) -> M3 {
    let m: [[f64; 3]; 3] = [
        [m[0][0] as f64, m[0][1] as f64, m[0][2] as f64],
        [m[1][0] as f64, m[1][1] as f64, m[1][2] as f64],
        [m[2][0] as f64, m[2][1] as f64, m[2][2] as f64],
    ];
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return IDENTITY;
    }
    let d = 1.0 / det;
    let c = |a: usize, b: usize, c: usize, e: usize| (m[a][b] * m[c][e] - m[a][e] * m[c][b]) * d;
    [
        [c(1, 1, 2, 2) as f32, -c(0, 1, 2, 2) as f32, c(0, 1, 1, 2) as f32],
        [-c(1, 0, 2, 2) as f32, c(0, 0, 2, 2) as f32, -c(0, 0, 1, 2) as f32],
        [c(1, 0, 2, 1) as f32, -c(0, 0, 2, 1) as f32, c(0, 0, 1, 1) as f32],
    ]
}

pub fn xy_to_xyz(x: f64, y: f64) -> [f32; 3] {
    let y = y.max(1e-6);
    [(x / y) as f32, 1.0, ((1.0 - x - y) / y) as f32]
}

pub fn xyz_to_xy(c: [f32; 3]) -> (f64, f64) {
    let s = (c[0] + c[1] + c[2]) as f64;
    if s.abs() < 1e-9 {
        return D65;
    }
    (c[0] as f64 / s, c[1] as f64 / s)
}

const BRADFORD: M3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/// Chromatic adaptation that maps the `src` white onto the `dst` white.
pub fn bradford(src: [f32; 3], dst: [f32; 3]) -> M3 {
    let s = mulv(&BRADFORD, src);
    let d = mulv(&BRADFORD, dst);
    let diag = [[d[0] / s[0], 0.0, 0.0], [0.0, d[1] / s[1], 0.0], [0.0, 0.0, d[2] / s[2]]];
    mul(&inv(&BRADFORD), &mul(&diag, &BRADFORD))
}

// ───────── Planckian locus (Kim et al. 2002), CIE 1960 uv ─────────

fn kim_xy(t: f64) -> (f64, f64) {
    let t = t.clamp(1667.0, 25000.0);
    let (t2, t3) = (t * t, t * t * t);
    let x = if t <= 4000.0 {
        -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
    } else {
        -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390
    };
    let (x2, x3) = (x * x, x * x * x);
    let y = if t <= 2222.0 {
        -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    } else if t <= 4000.0 {
        -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
    } else {
        3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483
    };
    (x, y)
}

fn xy_to_uv(x: f64, y: f64) -> (f64, f64) {
    let d = -2.0 * x + 12.0 * y + 3.0;
    (4.0 * x / d, 6.0 * y / d)
}

fn uv_to_xy(u: f64, v: f64) -> (f64, f64) {
    let d = 2.0 * u - 8.0 * v + 4.0;
    (3.0 * u / d, 2.0 * v / d)
}

/// Locus point at a given mired (1e6/K), extrapolated linearly past 25000K.
fn locus_uv(mired: f64) -> (f64, f64) {
    if mired < 40.0 {
        let a = locus_uv(40.0);
        let b = locus_uv(41.0);
        let k = 40.0 - mired;
        return (a.0 - (b.0 - a.0) * k, a.1 - (b.1 - a.1) * k);
    }
    let (x, y) = kim_xy(1e6 / mired);
    xy_to_uv(x, y)
}

fn locus_normal(mired: f64) -> (f64, f64) {
    let a = locus_uv(mired);
    let b = locus_uv(mired + 0.5);
    let (du, dv) = (b.0 - a.0, b.1 - a.1);
    let l = (du * du + dv * dv).sqrt().max(1e-12);
    (-dv / l, du / l)
}

/// xy chromaticity of a white given colour temperature and Duv (offset from the locus).
pub fn temp_duv_to_xy(kelvin: f64, duv: f64) -> (f64, f64) {
    let m = 1e6 / kelvin.clamp(1000.0, 60000.0);
    let (u, v) = locus_uv(m);
    let n = locus_normal(m);
    uv_to_xy(u + n.0 * duv, v + n.1 * duv)
}

pub fn xy_to_temp_duv(x: f64, y: f64) -> (f64, f64) {
    let (u, v) = xy_to_uv(x, y);
    let dist = |m: f64| {
        let (a, b) = locus_uv(m);
        (a - u) * (a - u) + (b - v) * (b - v)
    };
    let mut best = 20.0;
    let mut bd = f64::MAX;
    let mut m = 16.0;
    while m <= 700.0 {
        let d = dist(m);
        if d < bd {
            bd = d;
            best = m;
        }
        m += 2.0;
    }
    // Golden-section refine.
    let (mut lo, mut hi) = ((best - 2.0).max(16.0), best + 2.0);
    let g = 0.618_033_988_75;
    for _ in 0..40 {
        let a = hi - (hi - lo) * g;
        let b = lo + (hi - lo) * g;
        if dist(a) < dist(b) {
            hi = b;
        } else {
            lo = a;
        }
    }
    let m = (lo + hi) * 0.5;
    let (a, b) = locus_uv(m);
    let n = locus_normal(m);
    let duv = (u - a) * n.0 + (v - b) * n.1;
    (1e6 / m, duv)
}

// White balance encoding. Raw files use Kelvin + tint like a raw converter;
// rendered (JPEG/PNG) files use relative -100…100 sliders around D65.
const DUV_REF: f64 = 0.0032;
const TINT_SCALE_RAW: f64 = 3000.0;
const TINT_SCALE_REL: f64 = 4000.0;
const D65_MIRED: f64 = 1e6 / 6504.0;

pub fn wb_white_xy(is_raw: bool, temp: f32, tint: f32) -> (f64, f64) {
    if is_raw {
        temp_duv_to_xy(temp as f64, DUV_REF + tint as f64 / TINT_SCALE_RAW)
    } else {
        let m = (D65_MIRED - temp as f64 * 0.9).max(20.0);
        let (x, y) = temp_duv_to_xy(1e6 / m, DUV_REF + tint as f64 / TINT_SCALE_REL);
        let (x0, y0) = temp_duv_to_xy(6504.0, DUV_REF);
        (D65.0 + x - x0, D65.1 + y - y0)
    }
}

pub fn wb_from_xy(is_raw: bool, x: f64, y: f64) -> (f32, f32) {
    if is_raw {
        let (t, duv) = xy_to_temp_duv(x, y);
        (t.clamp(2000.0, 50000.0) as f32, ((duv - DUV_REF) * TINT_SCALE_RAW).clamp(-150.0, 150.0) as f32)
    } else {
        let (x0, y0) = temp_duv_to_xy(6504.0, DUV_REF);
        let (t, duv) = xy_to_temp_duv(x - D65.0 + x0, y - D65.1 + y0);
        let rel = (D65_MIRED - 1e6 / t) / 0.9;
        (rel.clamp(-100.0, 100.0) as f32, ((duv - DUV_REF) * TINT_SCALE_REL).clamp(-100.0, 100.0) as f32)
    }
}

// ───────── Fast transfer functions ─────────

pub struct Transfer {
    oetf: Vec<f32>, // indexed by sqrt(linear)
    eotf: Vec<f32>, // indexed by encoded value
}

const TN: usize = 4096;

impl Transfer {
    pub fn new() -> Self {
        let mut oetf = Vec::with_capacity(TN + 2);
        let mut eotf = Vec::with_capacity(TN + 2);
        for i in 0..=TN + 1 {
            let s = i as f64 / TN as f64;
            oetf.push(srgb_oetf((s * s) as f32));
            eotf.push(srgb_eotf(s as f32));
        }
        Transfer { oetf, eotf }
    }
    #[inline]
    pub fn enc(&self, v: f32) -> f32 {
        if v <= 0.0 {
            return v * 12.92;
        }
        if v >= 1.0 {
            return 1.0 + (v - 1.0) * 0.44;
        }
        let f = v.sqrt() * TN as f32;
        let i = f as usize;
        let t = f - i as f32;
        self.oetf[i] + (self.oetf[i + 1] - self.oetf[i]) * t
    }
    #[inline]
    pub fn dec(&self, v: f32) -> f32 {
        if v <= 0.0 {
            return v / 12.92;
        }
        if v >= 1.0 {
            return 1.0 + (v - 1.0) / 0.44;
        }
        let f = v * TN as f32;
        let i = f as usize;
        let t = f - i as f32;
        self.eotf[i] + (self.eotf[i + 1] - self.eotf[i]) * t
    }
}

pub fn srgb_oetf(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

pub fn srgb_eotf(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
pub fn fast_log2(x: f32) -> f32 {
    let x = x.max(1e-20);
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1,2)
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let ln = 2.0 * s * (1.0 + s2 * (1.0 / 3.0 + s2 * (0.2 + s2 * (1.0 / 7.0 + s2 / 9.0))));
    e as f32 + ln * std::f32::consts::LOG2_E
}

#[inline]
pub fn fast_exp2(x: f32) -> f32 {
    let x = x.clamp(-126.0, 126.0);
    let xi = x.floor();
    let f = x - xi;
    let p = 1.0 + f * (0.693_147_2 + f * (0.240_226_5 + f * (0.055_504_1 + f * (0.009_618_1 + f * 0.001_333_6))));
    f32::from_bits(((xi as i32 + 127) as u32) << 23) * p
}

#[inline]
pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// RGB (0..1) → hue in degrees (0..360), HSV saturation and value.
#[inline]
pub fn hsv(c: [f32; 3]) -> (f32, f32, f32) {
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    let d = mx - mn;
    if mx <= 1e-6 || d <= 1e-6 {
        return (0.0, 0.0, mx);
    }
    let inv = 1.0 / d;
    let h = if mx == c[0] {
        60.0 * ((c[1] - c[2]) * inv)
    } else if mx == c[1] {
        60.0 * ((c[2] - c[0]) * inv + 2.0)
    } else {
        60.0 * ((c[0] - c[1]) * inv + 4.0)
    };
    (if h < 0.0 { h + 360.0 } else { h }, d / mx, mx)
}

/// Fully saturated colour for a hue, minus its luma: a direction to push a tint along.
pub fn hue_chroma(h: f32) -> [f32; 3] {
    let h = ((h % 360.0) + 360.0) % 360.0 / 60.0;
    let x = 1.0 - ((h % 2.0) - 1.0).abs();
    let c = match h as i32 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    };
    let y = luma(c);
    [c[0] - y, c[1] - y, c[2] - y]
}

/// Rotate a colour around the grey axis (Rodrigues; positive = R→Y→G).
#[inline]
pub fn rotate_hue(c: [f32; 3], cos: f32, sin: f32) -> [f32; 3] {
    const K: f32 = 0.577_350_3;
    let kv = K * K * (c[0] + c[1] + c[2]) * (1.0 - cos);
    [
        c[0] * cos + K * (c[2] - c[1]) * sin + kv,
        c[1] * cos + K * (c[0] - c[2]) * sin + kv,
        c[2] * cos + K * (c[1] - c[0]) * sin + kv,
    ]
}

/// Lightroom-style calibration: rotate/saturate each primary, then renormalise so white stays white.
pub fn calibration(rh: f32, rs: f32, gh: f32, gs: f32, bh: f32, bs: f32) -> M3 {
    if rh == 0.0 && rs == 0.0 && gh == 0.0 && gs == 0.0 && bh == 0.0 && bs == 0.0 {
        return IDENTITY;
    }
    let mut m = [[0.0f32; 3]; 3];
    let prim = [(rh, rs), (gh, gs), (bh, bs)];
    for (i, &(h, s)) in prim.iter().enumerate() {
        let mut e = [0.0f32; 3];
        e[i] = 1.0;
        let y = luma(e);
        let ang = (h / 100.0 * 30.0).to_radians();
        let r = rotate_hue(e, ang.cos(), ang.sin());
        let ry = (r[0] + r[1] + r[2]) / 3.0;
        let k = 1.0 + s / 100.0;
        for c in 0..3 {
            m[c][i] = y + (r[c] - ry) * k;
        }
    }
    for row in m.iter_mut() {
        let s = row[0] + row[1] + row[2];
        if s.abs() > 1e-6 {
            for v in row.iter_mut() {
                *v /= s;
            }
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_hue_matches_rodrigues() {
        // Red rotated +120° lands on green.
        let a = 120f32.to_radians();
        let g = rotate_hue([1.0, 0.0, 0.0], a.cos(), a.sin());
        assert!((g[0]).abs() < 1e-4 && (g[1] - 1.0).abs() < 1e-4 && g[2].abs() < 1e-4, "{:?}", g);
    }

    #[test]
    fn locus_roundtrip() {
        for &t in &[2850.0, 4000.0, 5500.0, 6504.0, 9000.0, 20000.0] {
            for &d in &[-0.01, 0.0, 0.006] {
                let (x, y) = temp_duv_to_xy(t, d);
                let (t2, d2) = xy_to_temp_duv(x, y);
                assert!((t2 - t).abs() / t < 0.01, "{} {} -> {}", t, d, t2);
                assert!((d2 - d).abs() < 5e-4, "{} {} -> {}", t, d, d2);
            }
        }
    }

    #[test]
    fn relative_wb_is_identity_at_zero() {
        let (x, y) = wb_white_xy(false, 0.0, 0.0);
        assert!((x - D65.0).abs() < 1e-9 && (y - D65.1).abs() < 1e-9);
        let (t, q) = wb_from_xy(false, D65.0, D65.1);
        assert!(t.abs() < 0.5 && q.abs() < 0.5, "{} {}", t, q);
    }

    #[test]
    fn fast_math() {
        for i in 1..200 {
            let x = i as f32 * 0.037;
            assert!((fast_log2(x) - x.log2()).abs() < 2e-3, "log2 {}", x);
            let y = (i as f32 - 100.0) * 0.07;
            assert!((fast_exp2(y) / y.exp2() - 1.0).abs() < 1e-3, "exp2 {}", y);
        }
    }
}
