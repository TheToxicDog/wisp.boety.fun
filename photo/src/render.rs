// The develop pipeline. One call renders a rectangle of the cropped photo at any
// scale: geometry → spot healing → white balance & camera matrix → local masks →
// exposure → dehaze → base curve → local tone (highlights/shadows/clarity/texture)
// → global tone & curves → colour (HSL, vibrance, B&W, grading) → detail
// (noise reduction, sharpening, defringe) → effects (vignette, grain).

use crate::color::{self, smoothstep, Transfer, M3};
use crate::filters;
use crate::image::Image;

// ───────── Parameter layout (mirrored in public/js/photo-params.js) ─────────
pub const TEMP: usize = 0;
pub const TINT: usize = 1;
pub const EXPOSURE: usize = 2;
pub const CONTRAST: usize = 3;
pub const HIGHLIGHTS: usize = 4;
pub const SHADOWS: usize = 5;
pub const WHITES: usize = 6;
pub const BLACKS: usize = 7;
pub const TEXTURE: usize = 8;
pub const CLARITY: usize = 9;
pub const DEHAZE: usize = 10;
pub const VIBRANCE: usize = 11;
pub const SATURATION: usize = 12;
pub const HSL_HUE: usize = 13; // 8 bands
pub const HSL_SAT: usize = 21;
pub const HSL_LUM: usize = 29;
pub const BW_MIX: usize = 37;
pub const TREATMENT: usize = 45;
pub const CG: usize = 46; // shadows h,s,l · mids h,s,l · highs h,s,l · global h,s,l
pub const CG_BLENDING: usize = 58;
pub const CG_BALANCE: usize = 59;
pub const SHARP_AMOUNT: usize = 60;
pub const SHARP_RADIUS: usize = 61;
pub const SHARP_DETAIL: usize = 62;
pub const SHARP_MASKING: usize = 63;
pub const NR_LUM: usize = 64;
pub const NR_LUM_DETAIL: usize = 65;
pub const NR_LUM_CONTRAST: usize = 66;
pub const NR_COLOR: usize = 67;
pub const NR_COLOR_DETAIL: usize = 68;
pub const NR_COLOR_SMOOTH: usize = 69;
pub const LENS_DISTORTION: usize = 70;
pub const LENS_VIG: usize = 71;
pub const LENS_VIG_MID: usize = 72;
pub const DEFRINGE_PURPLE: usize = 73;
pub const DEFRINGE_GREEN: usize = 74;
pub const CA_RED: usize = 75;
pub const CA_BLUE: usize = 76;
pub const TR_VERTICAL: usize = 77;
pub const TR_HORIZONTAL: usize = 78;
pub const TR_ROTATE: usize = 79;
pub const TR_ASPECT: usize = 80;
pub const TR_SCALE: usize = 81;
pub const TR_X: usize = 82;
pub const TR_Y: usize = 83;
pub const VIG_AMOUNT: usize = 84;
pub const VIG_MID: usize = 85;
pub const VIG_ROUND: usize = 86;
pub const VIG_FEATHER: usize = 87;
pub const VIG_HIGHLIGHTS: usize = 88;
pub const VIG_STYLE: usize = 89;
pub const GRAIN_AMOUNT: usize = 90;
pub const GRAIN_SIZE: usize = 91;
pub const GRAIN_ROUGH: usize = 92;
pub const CAL_SHADOWS: usize = 93;
pub const CAL_RED_HUE: usize = 94;
pub const CROP_L: usize = 100;
pub const CROP_T: usize = 101;
pub const CROP_R: usize = 102;
pub const CROP_B: usize = 103;
pub const ANGLE: usize = 104;
pub const ORIENT: usize = 105;
pub const NP: usize = 106;

// Render controls follow the parameters.
pub const NCTL: usize = 8; // region x0,y0,x1,y1 · draft · overlay mask · fill · reserved
pub const LUT_N: usize = 1024; // master, red, green, blue curves
pub const MASK_HDR: usize = 24;
pub const LOCAL_N: usize = 16;
pub const SPOT_N: usize = 8;

// Local adjustment slots
const L_TEMP: usize = 0;
const L_TINT: usize = 1;
const L_EXPOSURE: usize = 2;
const L_CONTRAST: usize = 3;
const L_HIGHLIGHTS: usize = 4;
const L_SHADOWS: usize = 5;
const L_WHITES: usize = 6;
const L_BLACKS: usize = 7;
const L_TEXTURE: usize = 8;
const L_CLARITY: usize = 9;
const L_DEHAZE: usize = 10;
const L_HUE: usize = 11;
const L_SAT: usize = 12;
const L_SHARP: usize = 13;
const L_COLOR_H: usize = 14;
const L_COLOR_S: usize = 15;
const NMAPS: usize = 17; // 14 direct + colour overlay r,g,b

const GREY: f32 = -2.473_931_2; // log2(0.18)
const RAW_BASELINE_EV: f32 = 0.5;
const RAW_BASE_CONTRAST: f32 = 0.18;
const BAND_CENTRES: [f32; 9] = [0.0, 30.0, 60.0, 120.0, 180.0, 225.0, 270.0, 315.0, 360.0];

pub struct Output {
    pub rgba: Vec<u8>,
    pub hist: Vec<u32>,
}

struct Mask {
    kind: u32,
    invert: bool,
    amount: f32,
    a: [f32; 8], // x1 y1 x2 y2 rx ry angle feather
    lum: Option<(f32, f32, f32)>,
    col: Option<(f32, f32, f32)>,
    local: [f32; LOCAL_N],
    tint: [f32; 3],
    raster: Option<(usize, usize, Vec<f32>)>,
}

struct Spot {
    x: f32,
    y: f32,
    r: f32,
    sx: f32,
    sy: f32,
    feather: f32,
    opacity: f32,
    heal: bool,
    off: [f32; 3],
}

/// Inverse geometry: output frame → oriented content → source pixels.
pub struct Geo {
    pub w: f32,
    pub h: f32,
    pub wo: f32,
    pub ho: f32,
    pub ls: f32,
    rot: u32,
    flip: bool,
    cos: f32,
    sin: f32,
    scale: f32,
    tx: f32,
    ty: f32,
    ak: f32,
    pv: f32,
    ph: f32,
    dist: f32,
    lh: f32,
    inv_scale: f32,
    inv_ak: f32,
    inv_lh: f32,
}

impl Geo {
    pub fn new(w: usize, h: usize, p: &[f32]) -> Geo {
        let orient = p[ORIENT].max(0.0) as u32;
        let rot = orient & 3;
        let (w, h) = (w as f32, h as f32);
        let (wo, ho) = if rot & 1 == 1 { (h, w) } else { (w, h) };
        let ang = (p[ANGLE] + p[TR_ROTATE]).to_radians();
        let scale = (p[TR_SCALE] / 100.0).max(0.05);
        let ak = (p[TR_ASPECT] / 100.0 * 0.5).exp2();
        let lh = wo.max(ho) * 0.5;
        Geo {
            inv_scale: 1.0 / scale,
            inv_ak: 1.0 / ak,
            inv_lh: 1.0 / lh,
            w,
            h,
            wo,
            ho,
            ls: w.max(h),
            rot,
            flip: orient & 4 != 0,
            cos: ang.cos(),
            sin: ang.sin(),
            scale,
            tx: p[TR_X] / 100.0 * wo * 0.5,
            ty: p[TR_Y] / 100.0 * ho * 0.5,
            ak,
            pv: p[TR_VERTICAL] / 100.0 * 0.35,
            ph: p[TR_HORIZONTAL] / 100.0 * 0.35,
            dist: p[LENS_DISTORTION] / 100.0 * 0.12,
            lh,
        }
    }

    /// Frame pixel → normalised lens-centred coordinates of the content.
    #[inline]
    pub fn to_q(&self, fx: f32, fy: f32) -> (f32, f32) {
        let px = fx - self.wo * 0.5;
        let py = fy - self.ho * 0.5;
        let x = (px * self.cos + py * self.sin) * self.inv_scale - self.tx;
        let y = (-px * self.sin + py * self.cos) * self.inv_scale - self.ty;
        let (mut qx, mut qy) = (x * self.inv_ak * self.inv_lh, y * self.ak * self.inv_lh);
        if self.pv != 0.0 || self.ph != 0.0 {
            let wgt = 1.0 / (1.0 + self.pv * qy + self.ph * qx).max(0.05);
            qx *= wgt;
            qy *= wgt;
        }
        if self.dist != 0.0 {
            let f = 1.0 - self.dist * (qx * qx + qy * qy);
            qx *= f;
            qy *= f;
        }
        (qx, qy)
    }

    #[inline]
    pub fn q_to_source(&self, qx: f32, qy: f32) -> (f32, f32) {
        let cx = qx * self.lh + self.wo * 0.5;
        let cy = qy * self.lh + self.ho * 0.5;
        let (mut sx, sy) = match self.rot {
            1 => (cy, self.h - cx),
            2 => (self.w - cx, self.h - cy),
            3 => (self.w - cy, cx),
            _ => (cx, cy),
        };
        if self.flip {
            sx = self.w - sx;
        }
        (sx, sy)
    }

    #[inline]
    pub fn inside(&self, sx: f32, sy: f32) -> bool {
        sx >= 0.0 && sy >= 0.0 && sx <= self.w && sy <= self.h
    }
}

#[inline]
fn lut(t: &[f32], v: f32) -> f32 {
    let f = v.clamp(0.0, 1.0) * (LUT_N - 1) as f32;
    let i = (f as usize).min(LUT_N - 2);
    let k = f - i as f32;
    t[i] + (t[i + 1] - t[i]) * k
}

#[inline]
fn band_weights(h: f32) -> (usize, usize, f32, f32) {
    let mut i = 0;
    while i < 7 && h >= BAND_CENTRES[i + 1] {
        i += 1;
    }
    let t = (h - BAND_CENTRES[i]) / (BAND_CENTRES[i + 1] - BAND_CENTRES[i]);
    let t = t * t * (3.0 - 2.0 * t);
    (i, (i + 1) % 8, 1.0 - t, t)
}

#[inline]
fn hue_dist(a: f32, b: f32) -> f32 {
    let d = (a - b).abs();
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

#[inline]
fn hash(ix: i32, iy: i32, seed: u32) -> f32 {
    let mut h = (ix as u32).wrapping_mul(0x8da6_b343) ^ (iy as u32).wrapping_mul(0xd816_3841) ^ seed.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0xffff) as f32 / 32767.5 - 1.0
}

#[inline]
fn vnoise(x: f32, y: f32, seed: u32) -> f32 {
    let (xf, yf) = (x.floor(), y.floor());
    let (ix, iy) = (xf as i32, yf as i32);
    let (tx, ty) = (x - xf, y - yf);
    let (tx, ty) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty));
    let a = hash(ix, iy, seed);
    let b = hash(ix + 1, iy, seed);
    let c = hash(ix, iy + 1, seed);
    let d = hash(ix + 1, iy + 1, seed);
    let t = a + (b - a) * tx;
    let u = c + (d - c) * tx;
    t + (u - t) * ty
}

/// The scene white for the current temperature/tint as camera gains + output matrix.
pub fn colour_matrix(img: &Image, p: &[f32]) -> ([f32; 3], M3) {
    let (x, y) = color::wb_white_xy(img.is_raw, p[TEMP], p[TINT]);
    let white = color::xy_to_xyz(x, y);
    let n = color::mulv(&img.xyz2cam, white);
    let n = [n[0].max(1e-6), n[1].max(1e-6), n[2].max(1e-6)];
    let mx = n[0].max(n[1]).max(n[2]);
    let gains = [mx / n[0], mx / n[1], mx / n[2]];
    let d65 = color::xy_to_xyz(color::D65.0, color::D65.1);
    let adapt = color::bradford(white, d65);
    let ungain = [[1.0 / gains[0], 0.0, 0.0], [0.0, 1.0 / gains[1], 0.0], [0.0, 0.0, 1.0 / gains[2]]];
    let m0 = color::mul(&color::XYZ2SRGB, &color::mul(&adapt, &color::mul(&img.cam2xyz, &ungain)));
    let y1 = color::luma(color::mulv(&m0, [1.0, 1.0, 1.0])).max(1e-6);
    let m = color::scale(&m0, 1.0 / y1);
    let cal = color::calibration(
        p[CAL_RED_HUE],
        p[CAL_RED_HUE + 1],
        p[CAL_RED_HUE + 2],
        p[CAL_RED_HUE + 3],
        p[CAL_RED_HUE + 4],
        p[CAL_RED_HUE + 5],
    );
    (gains, color::mul(&cal, &m))
}

/// White-balance and convert camera RGB to linear sRGB. Raw values aren't
/// clipped after the gains (so bright colours keep their hue and highlights
/// stay recoverable); instead, where a sensor channel nears saturation the
/// pixel fades to neutral so blown areas don't turn pink, cyan or green.
/// Rendered files are already clipped, so their balanced values clip at 1.
#[inline]
fn to_linear(cam: [f32; 3], gains: &[f32; 3], m: &M3, raw: bool) -> [f32; 3] {
    let mut b = [cam[0] * gains[0], cam[1] * gains[1], cam[2] * gains[2]];
    if raw {
        let k = cam[0].max(cam[1]).max(cam[2]);
        if k > 0.94 {
            let w = smoothstep(0.94, 0.995, k);
            let t = b[0].max(b[1]).max(b[2]);
            b = [b[0] + (t - b[0]) * w, b[1] + (t - b[1]) * w, b[2] + (t - b[2]) * w];
        }
    } else {
        b = [b[0].min(1.0), b[1].min(1.0), b[2].min(1.0)];
    }
    color::mulv(m, b)
}

/// Atmospheric light for dehaze, estimated from a small level of the whole photo.
fn atmosphere(img: &Image, gains: &[f32; 3], m: &M3, gain: f32) -> [f32; 3] {
    let mut li = img.levels.len() - 1;
    while li > 0 && img.levels[li].w.max(img.levels[li].h) < 200 {
        li -= 1;
    }
    let lv = &img.levels[li];
    let mut px: Vec<(f32, [f32; 3])> = lv
        .data
        .chunks_exact(3)
        .map(|c| {
            let cam = [c[0] as f32 / 65535.0, c[1] as f32 / 65535.0, c[2] as f32 / 65535.0];
            let l = to_linear(cam, gains, m, img.is_raw);
            let l = [l[0] * gain, l[1] * gain, l[2] * gain];
            (l[0].min(l[1]).min(l[2]), l)
        })
        .collect();
    let k = (px.len() / 500).max(1);
    let n = px.len();
    px.select_nth_unstable_by(n - k, |a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut a = [0f32; 3];
    for (_, c) in &px[n - k..] {
        for i in 0..3 {
            a[i] += c[i];
        }
    }
    [(a[0] / k as f32).clamp(0.05, 1.5), (a[1] / k as f32).clamp(0.05, 1.5), (a[2] / k as f32).clamp(0.05, 1.5)]
}

fn parse(buf: &[f32], img: &Image) -> Result<(Vec<Mask>, Vec<Spot>), String> {
    let mut i = NP + NCTL + 4 * LUT_N;
    let take = |i: &mut usize, n: usize| -> Result<std::ops::Range<usize>, String> {
        if *i + n > buf.len() {
            return Err("truncated parameters".into());
        }
        let r = *i..*i + n;
        *i += n;
        Ok(r)
    };
    let nm = buf[take(&mut i, 1)?][0].max(0.0) as usize;
    let mut masks = Vec::with_capacity(nm);
    let ls = img.w.max(img.h) as f32;
    let (uw, uh) = (img.w as f32 / ls, img.h as f32 / ls);
    for _ in 0..nm {
        let hd = take(&mut i, MASK_HDR)?;
        let h = &buf[hd];
        let mut local = [0f32; LOCAL_N];
        local.copy_from_slice(&buf[take(&mut i, LOCAL_N)?]);
        let nd = buf[take(&mut i, 1)?][0].max(0.0) as usize;
        let dabs = &buf[take(&mut i, nd * 6)?];
        let kind = h[0] as u32;
        let raster = if kind == 2 {
            const G: f32 = 640.0;
            let (gw, gh) = ((uw * G).ceil() as usize + 1, (uh * G).ceil() as usize + 1);
            let mut r = vec![0f32; gw * gh];
            for d in dabs.chunks_exact(6) {
                let (cx, cy, rad, fe, flow, erase) = (d[0] * G, d[1] * G, (d[2] * G).max(0.5), d[3].clamp(0.0, 1.0), d[4].clamp(0.0, 1.0), d[5] > 0.5);
                let x0 = (cx - rad).floor().max(0.0) as usize;
                let y0 = (cy - rad).floor().max(0.0) as usize;
                let x1 = ((cx + rad).ceil() as usize).min(gw - 1);
                let y1 = ((cy + rad).ceil() as usize).min(gh - 1);
                let inner = rad * (1.0 - fe);
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        let dd = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                        if dd > rad {
                            continue;
                        }
                        let a = flow * if dd <= inner { 1.0 } else { 1.0 - smoothstep(inner, rad, dd) };
                        let v = &mut r[y * gw + x];
                        *v = if erase { *v * (1.0 - a) } else { *v + (1.0 - *v) * a };
                    }
                }
            }
            Some((gw, gh, r))
        } else {
            None
        };
        let mut a = [0f32; 8];
        a.copy_from_slice(&h[3..11]);
        let tint = if local[L_COLOR_S] != 0.0 {
            let c = color::hue_chroma(local[L_COLOR_H]);
            let s = local[L_COLOR_S] / 100.0;
            [c[0] * s, c[1] * s, c[2] * s]
        } else {
            [0.0; 3]
        };
        masks.push(Mask {
            kind,
            invert: h[1] > 0.5,
            amount: h[2].clamp(0.0, 1.0),
            a,
            lum: if h[11] > 0.5 { Some((h[12], h[13], h[14])) } else { None },
            col: if h[15] > 0.5 { Some((h[16], h[17], h[18])) } else { None },
            local,
            tint,
            raster,
        });
    }
    let ns = buf[take(&mut i, 1)?][0].max(0.0) as usize;
    let mut spots = Vec::with_capacity(ns);
    for _ in 0..ns {
        let s = &buf[take(&mut i, SPOT_N)?];
        spots.push(Spot {
            x: s[0],
            y: s[1],
            r: s[2].max(1e-4),
            sx: s[3],
            sy: s[4],
            feather: s[5].clamp(0.0, 1.0),
            opacity: s[6].clamp(0.0, 1.0),
            heal: s[7] < 0.5,
            off: [0.0; 3],
        });
    }
    Ok((masks, spots))
}

impl Mask {
    #[inline]
    fn weight(&self, x: f32, y: f32, lum: f32, hue: f32, sat: f32) -> f32 {
        let a = &self.a;
        let mut w = match self.kind {
            0 => {
                let (dx, dy) = (a[2] - a[0], a[3] - a[1]);
                let l2 = (dx * dx + dy * dy).max(1e-9);
                let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
                1.0 - smoothstep(0.0, 1.0, t)
            }
            1 => {
                let (dx, dy) = (x - a[0], y - a[1]);
                let (c, s) = (a[6].cos(), a[6].sin());
                let lx = (dx * c + dy * s) / a[4].max(1e-5);
                let ly = (-dx * s + dy * c) / a[5].max(1e-5);
                let d = (lx * lx + ly * ly).sqrt();
                let f = a[7].clamp(0.0, 1.0);
                if f < 1e-3 {
                    if d < 1.0 { 1.0 } else { 0.0 }
                } else {
                    1.0 - smoothstep(1.0 - f, 1.0, d)
                }
            }
            2 => {
                if let Some((gw, gh, r)) = &self.raster {
                    let fx = (x * 640.0).clamp(0.0, (*gw - 1) as f32);
                    let fy = (y * 640.0).clamp(0.0, (*gh - 1) as f32);
                    let (x0, y0) = (fx as usize, fy as usize);
                    let (x1, y1) = ((x0 + 1).min(gw - 1), (y0 + 1).min(gh - 1));
                    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
                    let t = r[y0 * gw + x0] + (r[y0 * gw + x1] - r[y0 * gw + x0]) * tx;
                    let u = r[y1 * gw + x0] + (r[y1 * gw + x1] - r[y1 * gw + x0]) * tx;
                    t + (u - t) * ty
                } else {
                    0.0
                }
            }
            _ => 1.0,
        };
        if self.invert {
            w = 1.0 - w;
        }
        if w <= 0.0 {
            return 0.0;
        }
        if let Some((lo, hi, sm)) = self.lum {
            let e = 0.004 + sm * 0.3;
            w *= smoothstep(lo - e, lo, lum) * (1.0 - smoothstep(hi, hi + e, lum));
        }
        if let Some((th, ts, amt)) = self.col {
            let tol = 8.0 + amt * 70.0;
            let hw = 1.0 - smoothstep(tol * 0.5, tol, hue_dist(hue, th));
            let sw = 1.0 - smoothstep(0.2 + amt * 0.4, 0.45 + amt * 0.5, (sat - ts).abs());
            w *= hw * sw * smoothstep(0.02, 0.08, sat);
        }
        w * self.amount
    }
}

/// Whites, blacks and contrast on an encoded value (may exceed 1 before clipping).
#[inline]
fn tone(mut v: f32, wh: f32, bk: f32, ct: f32) -> f32 {
    if wh != 0.0 {
        v *= 1.0 + wh * 0.35 * smoothstep(0.25, 1.0, v);
    }
    if bk != 0.0 {
        v += bk * 0.12 * (1.0 - smoothstep(0.0, 0.5, v));
    }
    if ct != 0.0 {
        let k = if ct > 0.0 { 1.0 + ct * 0.9 } else { 1.0 / (1.0 - ct * 0.7) };
        let pv = 0.42;
        let vc = v.clamp(0.0, 1.0);
        let c = if vc < pv { pv * (vc / pv).powf(k) } else { 1.0 - (1.0 - pv) * ((1.0 - vc) / (1.0 - pv)).powf(k) };
        v = c + (v - vc);
    }
    v
}

pub fn render(img: &Image, buf: &[f32], ow: usize, oh: usize, tr: &Transfer, out: &mut Output) -> Result<(), String> {
    if buf.len() < NP + NCTL + 4 * LUT_N + 2 || ow == 0 || oh == 0 {
        return Err("bad render arguments".into());
    }
    let p = &buf[..NP];
    let ctl = &buf[NP..NP + NCTL];
    let luts = &buf[NP + NCTL..NP + NCTL + 4 * LUT_N];
    let (lut_m, lut_r, lut_g, lut_b) = (&luts[..LUT_N], &luts[LUT_N..2 * LUT_N], &luts[2 * LUT_N..3 * LUT_N], &luts[3 * LUT_N..]);
    let curves_rgb = (0..LUT_N).any(|i| {
        let x = i as f32 / (LUT_N - 1) as f32;
        (lut_r[i] - x).abs() > 1e-4 || (lut_g[i] - x).abs() > 1e-4 || (lut_b[i] - x).abs() > 1e-4
    });
    let (masks, mut spots) = parse(buf, img)?;
    let draft = ctl[4] > 0.5;
    let overlay = if ctl[5] >= 0.0 && (ctl[5] as usize) < masks.len() { Some(ctl[5] as usize) } else { None };
    let fill = ctl[6].clamp(0.0, 1.0);

    let geo = Geo::new(img.w, img.h, p);
    let (cl, ct, cr, cb) = (p[CROP_L], p[CROP_T], p[CROP_R].max(p[CROP_L] + 1e-4), p[CROP_B].max(p[CROP_T] + 1e-4));
    let (rx0, ry0, rx1, ry1) = (ctl[0], ctl[1], ctl[2].max(ctl[0] + 1e-6), ctl[3].max(ctl[1] + 1e-6));
    let full_w = ow as f32 / (rx1 - rx0);
    let full_h = oh as f32 / (ry1 - ry0);
    let cpp = ((cr - cl) * geo.wo / full_w / geo.scale).max(1e-3); // source px per output px
    let sc = 1.0 / cpp;
    let lvl = img.pick_level(cpp);
    let diag = (full_w * full_w + full_h * full_h).sqrt();

    // Which stages are active (globally or in any mask)?
    let any_local = |k: usize| masks.iter().any(|m| m.local[k] != 0.0);
    let use_hs = p[HIGHLIGHTS] != 0.0 || p[SHADOWS] != 0.0 || any_local(L_HIGHLIGHTS) || any_local(L_SHADOWS);
    let use_clar = p[CLARITY] != 0.0 || any_local(L_CLARITY);
    let use_tex = p[TEXTURE] != 0.0 || any_local(L_TEXTURE);
    let use_haze = p[DEHAZE] != 0.0 || any_local(L_DEHAZE);
    let r_big = 0.03 * diag;
    let r_mid = 0.012 * diag;
    let r_small = (0.0012 * diag).max(0.7);
    let r_haze = 0.008 * diag;
    let mut need: f32 = 3.0;
    if use_hs {
        need = need.max(r_big * 1.5);
    }
    if use_clar {
        need = need.max(r_mid * 1.5);
    }
    if use_haze {
        need = need.max(r_haze * 3.0);
    }
    let margin = if draft { 0 } else { 12 };
    let pad = (need.ceil() as usize + margin).min(384);
    let (pw, ph) = (ow + 2 * pad, oh + 2 * pad);
    let n = pw * ph;

    let (gains, m) = colour_matrix(img, p);
    let baseline = if img.is_raw { RAW_BASELINE_EV } else { 0.0 };
    let exp_gain = (p[EXPOSURE] + baseline).exp2();

    // Spot healing: colour offset between ring samples around target and source.
    let ls = geo.ls;
    for s in spots.iter_mut() {
        if !s.heal {
            continue;
        }
        let mut acc = [0f32; 3];
        for k in 0..32 {
            let a = k as f32 / 32.0 * std::f32::consts::TAU;
            let (dx, dy) = (a.cos() * s.r * 1.1, a.sin() * s.r * 1.1);
            let t = img.sample(lvl, (s.x + dx) * ls, (s.y + dy) * ls);
            let o = img.sample(lvl, (s.sx + dx) * ls, (s.sy + dy) * ls);
            for c in 0..3 {
                acc[c] += (t[c] - o[c]) / 32.0;
            }
        }
        s.off = acc;
    }

    let active: Vec<bool> = (0..NMAPS)
        .map(|k| if k < 14 { any_local(k) } else { any_local(L_COLOR_S) })
        .collect();
    let mut maps: Vec<Option<Vec<f32>>> = active.iter().map(|&a| if a { Some(vec![0f32; n]) } else { None }).collect();
    let mut over = overlay.map(|_| vec![0f32; n]);
    let need_col = masks.iter().any(|m| m.col.is_some());

    let car = p[CA_RED] / 100.0 * 0.004;
    let cab = p[CA_BLUE] / 100.0 * 0.004;
    let use_ca = car != 0.0 || cab != 0.0;
    let lv_amt = p[LENS_VIG] / 100.0;
    let lv_mid = p[LENS_VIG_MID] / 100.0;
    let half_diag = (geo.wo * geo.wo + geo.ho * geo.ho).sqrt() * 0.5 / geo.lh;

    // ───────── Pass 1: sample, heal, colour, masks, exposure ─────────
    let mut rgb = vec![0f32; n * 3];
    let mut outside = vec![false; n];
    let du = (rx1 - rx0) / ow as f32;
    let dv = (ry1 - ry0) / oh as f32;
    for j in 0..ph {
        let v = ry0 + (j as f32 + 0.5 - pad as f32) * dv;
        let fy = (ct + v * (cb - ct)) * geo.ho;
        for i in 0..pw {
            let idx = j * pw + i;
            let u = rx0 + (i as f32 + 0.5 - pad as f32) * du;
            let fx = (cl + u * (cr - cl)) * geo.wo;
            let (qx, qy) = geo.to_q(fx, fy);
            let (sx, sy) = geo.q_to_source(qx, qy);
            outside[idx] = !geo.inside(sx, sy);
            let mut cam = img.sample(lvl, sx, sy);
            if use_ca {
                let (ax, ay) = geo.q_to_source(qx * (1.0 + car), qy * (1.0 + car));
                cam[0] = img.sample_ch(lvl, ax, ay, 0);
                let (bx, by) = geo.q_to_source(qx * (1.0 + cab), qy * (1.0 + cab));
                cam[2] = img.sample_ch(lvl, bx, by, 2);
            }
            if lv_amt != 0.0 {
                let r = (qx * qx + qy * qy).sqrt() / half_diag;
                let k = ((r - lv_mid * 0.6) / (1.0 - lv_mid * 0.6 + 1e-3)).clamp(0.0, 1.0);
                let g = (lv_amt * 1.5 * k * k).exp2();
                cam = [cam[0] * g, cam[1] * g, cam[2] * g];
            }
            if !spots.is_empty() {
                let (x, y) = (sx / ls, sy / ls);
                for s in &spots {
                    let (dx, dy) = (x - s.x, y - s.y);
                    if dx.abs() > s.r || dy.abs() > s.r {
                        continue;
                    }
                    let d = (dx * dx + dy * dy).sqrt();
                    if d >= s.r {
                        continue;
                    }
                    let inner = s.r * (1.0 - s.feather);
                    let w = s.opacity * if d <= inner { 1.0 } else { 1.0 - smoothstep(inner, s.r, d) };
                    let src = img.sample(lvl, (s.sx + dx) * ls, (s.sy + dy) * ls);
                    for c in 0..3 {
                        let rep = (src[c] + s.off[c]).max(0.0);
                        cam[c] += (rep - cam[c]) * w;
                    }
                }
            }
            let mut lin = to_linear(cam, &gains, &m, img.is_raw);
            if !masks.is_empty() {
                let (x, y) = (sx / ls, sy / ls);
                let lum = tr.enc(color::luma(lin) * exp_gain).clamp(0.0, 1.0);
                let (hue, sat) = if need_col {
                    let e = [tr.enc(lin[0].max(0.0) * exp_gain), tr.enc(lin[1].max(0.0) * exp_gain), tr.enc(lin[2].max(0.0) * exp_gain)];
                    let (h, s, _) = color::hsv(e);
                    (h, s)
                } else {
                    (0.0, 0.0)
                };
                for (mi, mk) in masks.iter().enumerate() {
                    let w = mk.weight(x, y, lum, hue, sat);
                    if let (Some(o), Some(oi)) = (over.as_mut(), overlay) {
                        if oi == mi {
                            o[idx] = w;
                        }
                    }
                    if w <= 0.0 {
                        continue;
                    }
                    for k in 0..14 {
                        if let Some(mp) = maps[k].as_mut() {
                            mp[idx] += w * mk.local[k];
                        }
                    }
                    if active[14] {
                        for c in 0..3 {
                            maps[14 + c].as_mut().unwrap()[idx] += w * mk.tint[c];
                        }
                    }
                }
                let lt = maps[L_TEMP].as_ref().map_or(0.0, |mp| mp[idx]) / 100.0;
                let lti = maps[L_TINT].as_ref().map_or(0.0, |mp| mp[idx]) / 100.0;
                if lt != 0.0 || lti != 0.0 {
                    lin[0] *= (lt * 0.4).exp2();
                    lin[2] *= (-lt * 0.4).exp2();
                    lin[1] *= (-lti * 0.3).exp2();
                }
            }
            let le = maps[L_EXPOSURE].as_ref().map_or(0.0, |mp| mp[idx]);
            let g = if le != 0.0 { exp_gain * le.exp2() } else { exp_gain };
            rgb[idx * 3] = lin[0] * g;
            rgb[idx * 3 + 1] = lin[1] * g;
            rgb[idx * 3 + 2] = lin[2] * g;
        }
    }

    // ───────── Dehaze ─────────
    if use_haze {
        let a = atmosphere(img, &gains, &m, exp_gain);
        let dark: Vec<f32> = rgb.chunks_exact(3).map(|c| (c[0] / a[0]).min(c[1] / a[1]).min(c[2] / a[2]).max(0.0)).collect();
        let dark = filters::gauss3(&filters::guided(&dark, pw, ph, r_haze * 2.0, 0.02), pw, ph, r_haze * 0.5);
        for i in 0..n {
            let amt = (p[DEHAZE] + maps[L_DEHAZE].as_ref().map_or(0.0, |mp| mp[i])) / 100.0;
            if amt == 0.0 {
                continue;
            }
            let c = &mut rgb[i * 3..i * 3 + 3];
            if amt > 0.0 {
                let t = (1.0 - 0.95 * amt * dark[i].min(1.0)).max(0.12);
                for k in 0..3 {
                    c[k] = ((c[k] - a[k]) / t + a[k]).max(0.0);
                }
            } else {
                let f = (-amt * 0.55).min(1.0);
                for k in 0..3 {
                    c[k] += (a[k] - c[k]) * f;
                }
            }
        }
    }

    // ───────── Base curve + log luminance ─────────
    let mut lum = vec![0f32; n];
    let mut lx = vec![0f32; n];
    for i in 0..n {
        let c = &mut rgb[i * 3..i * 3 + 3];
        let l0 = color::luma([c[0], c[1], c[2]]).max(0.0);
        let l1 = if img.is_raw && l0 > 0.6 {
            let (k, a) = (0.6f32, 1.08f32);
            k + (a - k) * (1.0 - color::fast_exp2(-(l0 - k) / (a - k) * std::f32::consts::LOG2_E))
        } else {
            l0
        };
        if l1 != l0 && l0 > 1e-6 {
            let r = l1 / l0;
            c[0] *= r;
            c[1] *= r;
            c[2] *= r;
        }
        lum[i] = l1;
        lx[i] = color::fast_log2(l1.max(1e-6));
    }
    let base = if use_hs { filters::guided(&lx, pw, ph, r_big, 0.3) } else { Vec::new() };
    let mid = if use_clar { filters::guided(&lx, pw, ph, r_mid, 1.2) } else { Vec::new() };
    let small = if use_tex { filters::gauss3(&lx, pw, ph, r_small) } else { Vec::new() };

    // ───────── Pass 2: tone, curves, colour (over the output + margin) ─────────
    let (x0, y0) = (pad - margin, pad - margin);
    let (rw, rh) = (ow + 2 * margin, oh + 2 * margin);
    let mut enc = vec![0f32; rw * rh * 3];
    let lm = |k: usize, i: usize| maps[k].as_ref().map_or(0.0, |mp| mp[i]);
    let raw_c = if img.is_raw { RAW_BASE_CONTRAST } else { 0.0 };
    let treat_bw = p[TREATMENT] > 0.5;
    let hsl_on = (0..24).any(|k| p[HSL_HUE + k] != 0.0) || any_local(L_HUE);
    let bw_on = (0..8).any(|k| p[BW_MIX + k] != 0.0);
    let cg = &p[CG..CG + 12];
    let cg_on = (0..4).any(|z| cg[z * 3 + 1] != 0.0 || cg[z * 3 + 2] != 0.0);
    let cg_p = 0.5 - p[CG_BALANCE] / 200.0 * 0.5;
    let cg_bl = p[CG_BLENDING] / 100.0;
    let cg_chroma: Vec<[f32; 3]> = (0..4).map(|z| color::hue_chroma(cg[z * 3])).collect();
    let vib = p[VIBRANCE] / 100.0;
    let cal_sh = p[CAL_SHADOWS] / 100.0;

    let local_tone = active[L_WHITES] || active[L_BLACKS] || active[L_CONTRAST];
    let tone_lut: Vec<f32> = if local_tone {
        Vec::new()
    } else {
        let (wh, bk, ct_) = (p[WHITES] / 100.0, p[BLACKS] / 100.0, p[CONTRAST] / 100.0 + raw_c);
        (0..=2048).map(|i| lut(lut_m, tone(i as f32 / 1024.0, wh, bk, ct_))).collect()
    };
    for j in 0..rh {
        for i in 0..rw {
            let pi = (j + y0) * pw + (i + x0);
            let l1 = lum[pi];
            let xx = lx[pi];
            let hl = (p[HIGHLIGHTS] + lm(L_HIGHLIGHTS, pi)) / 100.0;
            let sh = (p[SHADOWS] + lm(L_SHADOWS, pi)) / 100.0;
            let mut xn = xx;
            if use_hs {
                let t = base[pi] - GREY;
                let ww = smoothstep(-1.0, 2.0, t);
                let ws = 1.0 - smoothstep(-4.5, -0.8, t);
                // Recovery strengthens with brightness, but eases off on blown cores
                // so the sun doesn't turn into a grey disc.
                let k = if hl < 0.0 { (0.9 + 0.3 * t.clamp(0.0, 1.5)) * (1.0 - 0.5 * smoothstep(2.0, 2.6, t)) } else { 0.7 };
                xn += hl * ww * k;
                xn += sh * ws * 1.5;
            }
            if use_clar {
                let cl = (p[CLARITY] + lm(L_CLARITY, pi)) / 100.0;
                let t = mid[pi] - GREY + 0.3;
                let mw = color::fast_exp2(-(t * t) * (std::f32::consts::LOG2_E / (2.0 * 1.8 * 1.8)));
                xn += cl * 0.75 * mw * (xx - mid[pi]);
            }
            if use_tex {
                let tx = (p[TEXTURE] + lm(L_TEXTURE, pi)) / 100.0;
                xn += tx * 1.1 * (xx - small[pi]);
            }
            let y2 = if xn == xx { l1 } else { color::fast_exp2(xn) };
            let v = tr.enc(y2);
            let v3 = if local_tone {
                let wh = (p[WHITES] + lm(L_WHITES, pi)) / 100.0;
                let bk = (p[BLACKS] + lm(L_BLACKS, pi)) / 100.0;
                let ct_ = (p[CONTRAST] + lm(L_CONTRAST, pi)) / 100.0 + raw_c;
                lut(lut_m, tone(v, wh, bk, ct_))
            } else {
                let f = v.clamp(0.0, 2.0) * 1024.0;
                let i = (f as usize).min(2047);
                tone_lut[i] + (tone_lut[i + 1] - tone_lut[i]) * (f - i as f32)
            };
            let y3 = tr.dec(v3);
            let c = &rgb[pi * 3..pi * 3 + 3];
            let cr_ = if l1 > 1e-6 { (y3 / l1).min(6.0) } else { 0.0 };
            let mut o = [y3 + (c[0] - l1) * cr_, y3 + (c[1] - l1) * cr_, y3 + (c[2] - l1) * cr_];
            // Fit into gamut by desaturating towards the luminance.
            let mx = o[0].max(o[1]).max(o[2]);
            if mx > 1.0 && mx - y3 > 1e-6 {
                let t = ((1.0 - y3) / (mx - y3)).max(0.0);
                o = [y3 + (o[0] - y3) * t, y3 + (o[1] - y3) * t, y3 + (o[2] - y3) * t];
            }
            let mn = o[0].min(o[1]).min(o[2]);
            if mn < 0.0 && y3 - mn > 1e-6 {
                let t = y3 / (y3 - mn);
                o = [y3 + (o[0] - y3) * t, y3 + (o[1] - y3) * t, y3 + (o[2] - y3) * t];
            }
            let mut e = [tr.enc(o[0].clamp(0.0, 1.0)), tr.enc(o[1].clamp(0.0, 1.0)), tr.enc(o[2].clamp(0.0, 1.0))];
            if curves_rgb {
                e = [lut(lut_r, e[0]), lut(lut_g, e[1]), lut(lut_b, e[2])];
            }
            if cal_sh != 0.0 {
                let d = (1.0 - color::luma(e)).max(0.0);
                let w = d * d * cal_sh;
                e[1] -= w * 0.06;
                e[0] += w * 0.03;
                e[2] += w * 0.03;
            }

            // Colour: HSL / vibrance / saturation or B&W mix.
            let (h, s, _) = color::hsv([e[0].clamp(0.0, 1.0), e[1].clamp(0.0, 1.0), e[2].clamp(0.0, 1.0)]);
            let ye = color::luma(e);
            let (b0, b1, w0, w1) = band_weights(h);
            if treat_bw {
                let mut f = 1.0;
                if bw_on {
                    f += (w0 * p[BW_MIX + b0] + w1 * p[BW_MIX + b1]) / 100.0 * s * 0.6;
                }
                let g = ye * f.max(0.0);
                e = [g, g, g];
            } else {
                let mut ch = [e[0] - ye, e[1] - ye, e[2] - ye];
                let mut lsh = 0.0;
                let mut fs = 1.0;
                if hsl_on {
                    let dh = (w0 * p[HSL_HUE + b0] + w1 * p[HSL_HUE + b1]) / 100.0 * 30.0 + lm(L_HUE, pi) * 0.3;
                    if dh != 0.0 {
                        let a = dh.to_radians();
                        ch = color::rotate_hue(ch, a.cos(), a.sin());
                    }
                    fs *= 1.0 + (w0 * p[HSL_SAT + b0] + w1 * p[HSL_SAT + b1]) / 100.0;
                    lsh = (w0 * p[HSL_LUM + b0] + w1 * p[HSL_LUM + b1]) / 100.0;
                }
                if vib != 0.0 {
                    let skin = color::fast_exp2(-(hue_dist(h, 25.0) / 25.0).powi(2) * std::f32::consts::LOG2_E);
                    let q = (1.0 - s.min(1.0)).powi(2);
                    fs *= if vib > 0.0 { 1.0 + vib * 1.2 * q * (1.0 - 0.5 * skin) } else { 1.0 + vib * (1.0 - 0.4 * s) };
                }
                fs *= (1.0 + (p[SATURATION] + lm(L_SAT, pi)) / 100.0).max(0.0);
                let fl = 1.0 + lsh * 0.5 * (s * 1.6).min(1.0);
                e = [(ye + ch[0] * fs) * fl, (ye + ch[1] * fs) * fl, (ye + ch[2] * fs) * fl];
            }
            if cg_on {
                let l = color::luma(e).clamp(0.0, 1.0);
                let ws = 1.0 - smoothstep(cg_p * (1.0 - cg_bl), cg_p + (1.0 - cg_p) * cg_bl * 0.6, l);
                let whh = smoothstep(cg_p - cg_p * cg_bl * 0.6, cg_p + (1.0 - cg_p) * cg_bl, l);
                let wm = (-((l - cg_p) / (0.15 + 0.25 * cg_bl)).powi(2)).exp();
                for (z, w) in [ws, wm, whh, 1.0].iter().enumerate() {
                    let (sat, lumz) = (cg[z * 3 + 1] / 100.0, cg[z * 3 + 2] / 100.0);
                    if sat != 0.0 {
                        let k = sat * 0.35 * w;
                        let c = cg_chroma[z];
                        e = [e[0] + c[0] * k, e[1] + c[1] * k, e[2] + c[2] * k];
                    }
                    if lumz != 0.0 {
                        let k = lumz * 0.2 * w;
                        e = [e[0] + k, e[1] + k, e[2] + k];
                    }
                }
            }
            if active[14] {
                for c in 0..3 {
                    e[c] += lm(14 + c, pi) * 0.3;
                }
            }
            let o = (j * rw + i) * 3;
            enc[o] = e[0];
            enc[o + 1] = e[1];
            enc[o + 2] = e[2];
        }
    }

    // ───────── Pass 3: detail (noise reduction, sharpening, defringe) ─────────
    let sharp_amt = p[SHARP_AMOUNT] / 100.0;
    let sharp_sigma = p[SHARP_RADIUS] * sc * 0.8;
    // Noise reduction and sharpening act on source-pixel detail; when several
    // source pixels fold into one output pixel they'd be invisible, so skip them.
    let detail_visible = sc >= 0.4;
    let use_sharp = detail_visible && (sharp_amt > 0.0 || active[L_SHARP]) && sharp_sigma >= 0.25;
    let nr_l = p[NR_LUM] / 100.0;
    let nr_c = p[NR_COLOR] / 100.0;
    let nrl_r = (1.0 + nr_l * 2.5) * sc;
    let nrc_r = (1.0 + nr_c * 8.0) * sc;
    let use_nrl = detail_visible && nr_l > 0.0 && nrl_r >= 0.5;
    let use_nrc = detail_visible && nr_c > 0.0 && nrc_r >= 0.5;
    let fringe = (p[DEFRINGE_PURPLE] / 20.0, p[DEFRINGE_GREEN] / 20.0);
    let use_fringe = fringe.0 > 0.0 || fringe.1 > 0.0;
    if !draft && (use_sharp || use_nrl || use_nrc || use_fringe) {
        let rn = rw * rh;
        let mut y: Vec<f32> = enc.chunks_exact(3).map(|c| color::luma([c[0], c[1], c[2]])).collect();
        let mut chroma: Vec<Vec<f32>> = (0..3).map(|k| (0..rn).map(|i| enc[i * 3 + k] - y[i]).collect()).collect();
        if use_nrc {
            let mix = (nr_c * 1.5).min(1.0);
            let smooth = 0.5 + p[NR_COLOR_SMOOTH] / 200.0;
            let keep = p[NR_COLOR_DETAIL] / 100.0 * 0.5;
            for ch in chroma.iter_mut() {
                let b = filters::gauss3(ch, rw, rh, nrc_r * smooth * 1.4);
                for i in 0..rn {
                    ch[i] += (b[i] - ch[i]) * mix * (1.0 - keep);
                }
            }
        }
        if use_nrl {
            let eps = (nr_l * 0.05).powi(2) * (1.6 - p[NR_LUM_DETAIL] / 100.0);
            let g = filters::guided(&y, rw, rh, nrl_r, eps.max(1e-7));
            let back = p[NR_LUM_CONTRAST] / 100.0 * 0.4;
            for i in 0..rn {
                y[i] = g[i] + (y[i] - g[i]) * back;
            }
        }
        if use_sharp {
            let b = filters::gauss_exact(&y, rw, rh, sharp_sigma.max(0.4));
            let detail = p[SHARP_DETAIL] / 100.0;
            let mk = p[SHARP_MASKING] / 100.0;
            let yc = y.clone();
            for j in 0..rh {
                for i in 0..rw {
                    let k = j * rw + i;
                    let pi = (j + y0) * pw + (i + x0);
                    let amt = sharp_amt + lm(L_SHARP, pi) / 100.0;
                    if amt <= 0.0 {
                        continue;
                    }
                    let mut d = yc[k] - b[k];
                    d /= 1.0 + d.abs() * (1.0 - detail) * 25.0;
                    let mut w = 1.0;
                    if mk > 0.0 {
                        let gx = b[j * rw + (i + 1).min(rw - 1)] - b[j * rw + i.saturating_sub(1)];
                        let gy = b[(j + 1).min(rh - 1) * rw + i] - b[j.saturating_sub(1) * rw + i];
                        let gm = (gx * gx + gy * gy).sqrt();
                        w = smoothstep(mk * 0.06, mk * 0.06 + 0.03, gm);
                    }
                    y[k] += amt * 1.6 * (0.5 + detail) * d * w;
                }
            }
        }
        if use_fringe {
            for j in 0..rh {
                for i in 0..rw {
                    let k = j * rw + i;
                    let gx = y[j * rw + (i + 1).min(rw - 1)] - y[j * rw + i.saturating_sub(1)];
                    let gy = y[(j + 1).min(rh - 1) * rw + i] - y[j.saturating_sub(1) * rw + i];
                    let edge = smoothstep(0.03, 0.12, (gx * gx + gy * gy).sqrt());
                    if edge <= 0.0 {
                        continue;
                    }
                    let c = [chroma[0][k] + y[k], chroma[1][k] + y[k], chroma[2][k] + y[k]];
                    let (h, _, _) = color::hsv([c[0].clamp(0.0, 1.0), c[1].clamp(0.0, 1.0), c[2].clamp(0.0, 1.0)]);
                    let pw_ = 1.0 - smoothstep(20.0, 40.0, hue_dist(h, 295.0));
                    let gw_ = 1.0 - smoothstep(30.0, 50.0, hue_dist(h, 120.0));
                    let r = (fringe.0 * pw_ + fringe.1 * gw_).min(1.0) * edge;
                    for ch in chroma.iter_mut() {
                        ch[k] *= 1.0 - r;
                    }
                }
            }
        }
        for i in 0..rn {
            for k in 0..3 {
                enc[i * 3 + k] = y[i] + chroma[k][i];
            }
        }
    }

    // ───────── Pass 4: effects + output ─────────
    out.rgba.clear();
    out.rgba.resize(ow * oh * 4, 255);
    out.hist.clear();
    out.hist.resize(1024, 0);
    let va = p[VIG_AMOUNT] / 100.0;
    let asp = full_w / full_h;
    let vround = p[VIG_ROUND] / 100.0;
    let vexp = if vround < 0.0 { 2.0 + -vround * 6.0 } else { 2.0 };
    let vs0 = 0.2 + p[VIG_MID] / 100.0;
    let vs1 = vs0 + 0.02 + p[VIG_FEATHER] / 100.0 * 1.2;
    let vhl = p[VIG_HIGHLIGHTS] / 100.0;
    let vstyle = p[VIG_STYLE] as i32;
    let ga = p[GRAIN_AMOUNT] / 100.0;
    let gcell = 0.8 + p[GRAIN_SIZE] / 100.0 * 3.0;
    let grough = p[GRAIN_ROUGH] / 100.0;
    for j in 0..oh {
        let vv = ry0 + (j as f32 + 0.5) * dv;
        for i in 0..ow {
            let uu = rx0 + (i as f32 + 0.5) * du;
            let pi = (j + pad) * pw + (i + pad);
            let k = ((j + margin) * rw + (i + margin)) * 3;
            let mut e = [enc[k], enc[k + 1], enc[k + 2]];
            if va != 0.0 {
                let (mut xs, mut ys) = ((uu - 0.5) * 2.0, (vv - 0.5) * 2.0);
                if vround > 0.0 {
                    if asp > 1.0 {
                        xs *= 1.0 + (asp - 1.0) * vround;
                    } else {
                        ys *= 1.0 + (1.0 / asp - 1.0) * vround;
                    }
                }
                let d = if vexp == 2.0 { (xs * xs + ys * ys).sqrt() } else { (xs.abs().powf(vexp) + ys.abs().powf(vexp)).powf(1.0 / vexp) };
                let w = smoothstep(vs0, vs1, d);
                if w > 0.0 {
                    if vstyle == 2 {
                        let t = if va < 0.0 { 0.0 } else { 1.0 };
                        let f = va.abs() * w * 0.9;
                        e = [e[0] + (t - e[0]) * f, e[1] + (t - e[1]) * f, e[2] + (t - e[2]) * f];
                    } else if va < 0.0 {
                        let f = 1.0 + va * w * 0.9;
                        let yv = color::luma(e);
                        let hp = if vstyle == 0 { vhl * smoothstep(0.5, 1.0, yv) } else { 0.0 };
                        let f = f + (1.0 - f) * hp;
                        if vstyle == 1 {
                            let ch = [e[0] - yv, e[1] - yv, e[2] - yv];
                            let ny = yv * f;
                            e = [ny + ch[0], ny + ch[1], ny + ch[2]];
                        } else {
                            e = [e[0] * f, e[1] * f, e[2] * f];
                        }
                    } else {
                        let f = va * w * 0.9;
                        e = [e[0] + (1.0 - e[0]) * f, e[1] + (1.0 - e[1]) * f, e[2] + (1.0 - e[2]) * f];
                    }
                }
            }
            if ga > 0.0 {
                let gx = uu * 3000.0 / gcell;
                let gy = vv * 3000.0 / asp / gcell;
                let nz = vnoise(gx, gy, 7) * (1.0 - grough * 0.5) + vnoise(gx * 2.7 + 17.3, gy * 2.7 + 5.1, 11) * grough * 0.5;
                let yv = color::luma(e).clamp(0.0, 1.0);
                let g = nz * ga * 0.2 * (0.25 + yv * (1.0 - yv) * 3.0);
                e = [e[0] + g, e[1] + g, e[2] + g];
            }
            if outside[pi] {
                e = [fill, fill, fill];
            }
            if let Some(o) = over.as_ref() {
                let w = o[pi] * 0.55;
                e = [e[0] + (1.0 - e[0]) * w, e[1] + (0.15 - e[1]) * w, e[2] + (0.2 - e[2]) * w];
            }
            let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            let (r, g, b) = (q(e[0]), q(e[1]), q(e[2]));
            let o = (j * ow + i) * 4;
            out.rgba[o] = r;
            out.rgba[o + 1] = g;
            out.rgba[o + 2] = b;
            if !outside[pi] {
                out.hist[r as usize] += 1;
                out.hist[256 + g as usize] += 1;
                out.hist[512 + b as usize] += 1;
                let l = (0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32) as usize;
                out.hist[768 + l.min(255)] += 1;
            }
        }
    }
    Ok(())
}
