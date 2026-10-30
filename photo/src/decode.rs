// Decoders: camera raw (rawloader + demosaic), JPEG, PNG and pre-decoded RGBA.
// Everything lands in a linear RGB u16 buffer; raw files stay in camera space.

use crate::color::{self, M3};
use std::io::Cursor;

pub struct Decoded {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u16>, // RGB, linear, 0..65535
    pub is_raw: bool,
    pub cam2xyz: M3,
    pub xyz2cam: M3,
    pub neutral: [f32; 3], // camera response to the as-shot white
    pub make: String,
    pub model: String,
}

impl Decoded {
    fn rendered(w: usize, h: usize, data: Vec<u16>) -> Self {
        Decoded {
            w,
            h,
            data,
            is_raw: false,
            cam2xyz: color::SRGB2XYZ,
            xyz2cam: color::XYZ2SRGB,
            neutral: [1.0, 1.0, 1.0],
            make: String::new(),
            model: String::new(),
        }
    }
}

fn srgb8_lut() -> [u16; 256] {
    let mut t = [0u16; 256];
    for (i, v) in t.iter_mut().enumerate() {
        *v = (color::srgb_eotf(i as f32 / 255.0) * 65535.0 + 0.5) as u16;
    }
    t
}

fn srgb16(v: u16) -> u16 {
    (color::srgb_eotf(v as f32 / 65535.0) * 65535.0 + 0.5) as u16
}

/// EXIF orientation 1..8 → (transpose, hflip, vflip); flips apply before the transpose.
fn flips(orientation: u16) -> (bool, bool, bool) {
    match orientation {
        2 => (false, true, false),
        3 => (false, true, true),
        4 => (false, false, true),
        5 => (true, false, false),
        6 => (true, false, true),
        7 => (true, true, true),
        8 => (true, true, false),
        _ => (false, false, false),
    }
}

pub fn orient(d: &mut Decoded, orientation: u16) {
    let (t, hf, vf) = flips(orientation);
    if !(t || hf || vf) {
        return;
    }
    let (w, h) = (d.w, d.h);
    let (ow, oh) = if t { (h, w) } else { (w, h) };
    let mut out = vec![0u16; ow * oh * 3];
    for oy in 0..oh {
        for ox in 0..ow {
            let (mut x, mut y) = if t { (oy, ox) } else { (ox, oy) };
            if hf {
                x = w - 1 - x;
            }
            if vf {
                y = h - 1 - y;
            }
            let s = (y * w + x) * 3;
            let o = (oy * ow + ox) * 3;
            out[o..o + 3].copy_from_slice(&d.data[s..s + 3]);
        }
    }
    d.data = out;
    d.w = ow;
    d.h = oh;
}

pub fn from_rgba8(rgba: &[u8], w: usize, h: usize) -> Decoded {
    let lut = srgb8_lut();
    let mut data = Vec::with_capacity(w * h * 3);
    for px in rgba.chunks_exact(4).take(w * h) {
        data.push(lut[px[0] as usize]);
        data.push(lut[px[1] as usize]);
        data.push(lut[px[2] as usize]);
    }
    Decoded::rendered(w, h, data)
}

pub fn decode(bytes: &[u8], orientation: u16) -> Result<Decoded, String> {
    let mut d = if bytes.len() > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        decode_jpeg(bytes)?
    } else if bytes.len() > 8 && &bytes[1..4] == b"PNG" {
        decode_png(bytes)?
    } else {
        return decode_raw(bytes, orientation);
    };
    orient(&mut d, orientation);
    Ok(d)
}

fn decode_jpeg(bytes: &[u8]) -> Result<Decoded, String> {
    let mut dec = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    let px = dec.decode().map_err(|e| format!("JPEG: {}", e))?;
    let info = dec.info().ok_or("JPEG: no image info")?;
    let (w, h) = (info.width as usize, info.height as usize);
    let lut = srgb8_lut();
    let mut data = Vec::with_capacity(w * h * 3);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => data.extend(px.iter().map(|&v| lut[v as usize])),
        jpeg_decoder::PixelFormat::L8 => {
            for &v in &px {
                let l = lut[v as usize];
                data.extend_from_slice(&[l, l, l]);
            }
        }
        jpeg_decoder::PixelFormat::L16 => {
            for c in px.chunks_exact(2) {
                let l = srgb16(u16::from_be_bytes([c[0], c[1]]));
                data.extend_from_slice(&[l, l, l]);
            }
        }
        jpeg_decoder::PixelFormat::CMYK32 => {
            for c in px.chunks_exact(4) {
                let k = c[3] as u32;
                for i in 0..3 {
                    data.push(lut[(c[i] as u32 * k / 255) as usize]);
                }
            }
        }
    }
    Ok(Decoded::rendered(w, h, data))
}

fn decode_png(bytes: &[u8]) -> Result<Decoded, String> {
    let mut dec = png::Decoder::new(Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND);
    let mut reader = dec.read_info().map_err(|e| format!("PNG: {}", e))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("PNG: {}", e))?;
    let (w, h) = (info.width as usize, info.height as usize);
    let ch = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err("PNG: unexpanded palette".into()),
    };
    let sixteen = info.bit_depth == png::BitDepth::Sixteen;
    let lut = srgb8_lut();
    let get = |i: usize| -> u16 {
        if sixteen {
            srgb16(u16::from_be_bytes([buf[i * 2], buf[i * 2 + 1]]))
        } else {
            lut[buf[i] as usize]
        }
    };
    let mut data = Vec::with_capacity(w * h * 3);
    for p in 0..w * h {
        let b = p * ch;
        if ch < 3 {
            let l = get(b);
            data.extend_from_slice(&[l, l, l]);
        } else {
            data.extend_from_slice(&[get(b), get(b + 1), get(b + 2)]);
        }
    }
    Ok(Decoded::rendered(w, h, data))
}

// ───────── Camera raw ─────────

fn decode_raw(bytes: &[u8], hint: u16) -> Result<Decoded, String> {
    let raw = rawloader::decode(&mut Cursor::new(bytes)).map_err(|e| format!("{}", e))?;
    let (rw, rh) = (raw.width, raw.height);
    let [ct, cr, cb, cl] = raw.crops;
    let (w, h) = (rw.saturating_sub(cl + cr), rh.saturating_sub(ct + cb));
    if w < 16 || h < 16 {
        return Err("raw image too small".into());
    }
    let cpp = raw.cpp;
    let mut black = raw.blacklevels;
    if black.iter().all(|&b| b == 0) && cpp == 1 {
        if let Some(b) = masked_black(&raw) {
            black = b;
        }
    }
    let mut white = raw.whitelevels;
    if cpp == 1 {
        saturation_plateau(&raw, &black, &mut white);
    }
    let norm = |v: f32, c: usize| -> f32 {
        let c = c.min(3);
        let b = black[c] as f32;
        let wl = (white[c] as f32).max(b + 1.0);
        ((v - b) / (wl - b)).clamp(0.0, 1.0)
    };
    let get = |idx: usize| -> f32 {
        match &raw.data {
            rawloader::RawImageData::Integer(d) => d[idx] as f32,
            rawloader::RawImageData::Float(d) => d[idx] * 65535.0,
        }
    };
    let floats = matches!(raw.data, rawloader::RawImageData::Float(_));
    let normf = |v: f32, c: usize| -> f32 {
        if floats {
            (v / 65535.0).clamp(0.0, 1.0)
        } else {
            norm(v, c)
        }
    };

    let mut data = vec![0u16; w * h * 3];
    if cpp >= 3 {
        for y in 0..h {
            for x in 0..w {
                let s = ((y + ct) * rw + x + cl) * cpp;
                let o = (y * w + x) * 3;
                for c in 0..3 {
                    data[o + c] = (normf(get(s + c), c) * 65535.0) as u16;
                }
            }
        }
    } else {
        // Normalised mosaic, cropped.
        let cfa = raw.cropped_cfa();
        let mono = raw.is_monochrome() || cfa.width == 0;
        let colour = |y: usize, x: usize| -> usize {
            if mono {
                1
            } else {
                match cfa.color_at(y, x) {
                    3 => 1,
                    c => c.min(2),
                }
            }
        };
        let mut m = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let c = if mono { 0 } else { cfa.color_at(y, x) };
                m[y * w + x] = normf(get((y + ct) * rw + x + cl), c);
            }
        }
        if mono {
            for (i, &v) in m.iter().enumerate() {
                let q = (v * 65535.0) as u16;
                data[i * 3..i * 3 + 3].copy_from_slice(&[q, q, q]);
            }
        } else if cfa.width == 2 && cfa.height == 2 {
            demosaic_mhc(&m, w, h, &colour, &mut data);
        } else {
            demosaic_generic(&m, w, h, &colour, &mut data);
        }
    }

    // Colour matrices. Unknown cameras fall back to sRGB primaries.
    let x2c = raw.xyz_to_cam;
    let mut xyz2cam: M3 = [x2c[0], x2c[1], x2c[2]];
    let sum: f32 = xyz2cam.iter().flatten().map(|v| v.abs()).sum();
    if !(sum > 0.01) || !sum.is_finite() {
        xyz2cam = color::XYZ2SRGB;
    }
    let cam2xyz = color::inv(&xyz2cam);

    let wb = raw.wb_coeffs;
    let ok = |v: f32| v.is_finite() && v > 0.0;
    let neutral = if ok(wb[0]) && ok(wb[1]) && ok(wb[2]) {
        [1.0 / wb[0], 1.0 / wb[1], 1.0 / wb[2]]
    } else {
        let d65 = color::xy_to_xyz(color::D65.0, color::D65.1);
        color::mulv(&xyz2cam, d65)
    };
    let mx = neutral[0].max(neutral[1]).max(neutral[2]).max(1e-9);
    let neutral = [neutral[0] / mx, neutral[1] / mx, neutral[2] / mx];

    let mut d = Decoded {
        w,
        h,
        data,
        is_raw: true,
        cam2xyz,
        xyz2cam,
        neutral,
        make: raw.clean_make.clone(),
        model: raw.clean_model.clone(),
    };
    // Some formats keep orientation where rawloader doesn't look; fall back to the EXIF hint.
    let o = raw.orientation.to_u16();
    orient(&mut d, if o > 1 { o } else { hint });
    Ok(d)
}

/// Many sensors saturate below the white level the file declares. If a channel
/// has a plateau of identical maximum values (clipped highlights), use that as
/// its white point so blown areas clip cleanly instead of turning cyan/yellow.
fn saturation_plateau(raw: &rawloader::RawImage, black: &[u16; 4], white: &mut [u16; 4]) {
    let rawloader::RawImageData::Integer(d) = &raw.data else { return };
    let (w, h) = (raw.width, raw.height);
    let mut mx = [0u16; 4];
    let mut n = [0usize; 4];
    for y in (0..h).step_by(2) {
        for x in 0..w {
            let c = raw.cfa.color_at(y, x).min(3);
            let v = d[y * w + x];
            if v > mx[c] {
                mx[c] = v;
            }
            n[c] += 1;
        }
    }
    let mut near = [0usize; 4];
    for y in (0..h).step_by(2) {
        for x in 0..w {
            let c = raw.cfa.color_at(y, x).min(3);
            let tol = ((mx[c].saturating_sub(black[c])) as u32 / 400) as u16;
            if d[y * w + x] + tol >= mx[c] {
                near[c] += 1;
            }
        }
    }
    for c in 0..4 {
        let range = white[c].saturating_sub(black[c]) as f32;
        let span = mx[c].saturating_sub(black[c]) as f32;
        if n[c] > 0 && near[c] * 2000 >= n[c] && span > range * 0.5 && span < range {
            white[c] = mx[c] - ((mx[c] - black[c]) / 400).min(mx[c] - black[c]);
        }
    }
}

/// Black level from the sensor's masked (optical black) border, per CFA colour.
fn masked_black(raw: &rawloader::RawImage) -> Option<[u16; 4]> {
    let rawloader::RawImageData::Integer(d) = &raw.data else { return None };
    let mut vals: [Vec<u16>; 4] = Default::default();
    for &(t, r, b, l) in &raw.blackareas {
        let (y0, y1) = (t.min(b) as usize, (t.max(b) as usize).min(raw.height));
        let (x0, x1) = (r.min(l) as usize, (r.max(l) as usize).min(raw.width));
        for y in (y0..y1).step_by(2) {
            for x in x0..x1 {
                vals[raw.cfa.color_at(y, x).min(3)].push(d[y * raw.width + x]);
                vals[raw.cfa.color_at(y + 1, x).min(3)].push(d[((y + 1).min(raw.height - 1)) * raw.width + x]);
            }
        }
    }
    if vals.iter().all(|v| v.is_empty()) {
        return None;
    }
    let mut out = [0u16; 4];
    let mut fallback = 0;
    for (c, v) in vals.iter_mut().enumerate() {
        if !v.is_empty() {
            v.sort_unstable();
            out[c] = v[v.len() / 2];
            fallback = out[c];
        }
    }
    for (c, v) in vals.iter().enumerate() {
        if v.is_empty() {
            out[c] = fallback;
        }
    }
    Some(out)
}

#[inline]
fn q16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16
}

/// Malvar–He–Cutler gradient-corrected bilinear demosaic for 2×2 Bayer patterns.
fn demosaic_mhc(m: &[f32], w: usize, h: usize, colour: &dyn Fn(usize, usize) -> usize, out: &mut [u16]) {
    let at = |y: isize, x: isize| -> f32 {
        let y = y.clamp(0, h as isize - 1) as usize;
        let x = x.clamp(0, w as isize - 1) as usize;
        m[y * w + x]
    };
    // Where R sits within the 2×2 tile decides which kernel each site uses.
    let mut rpos = (0usize, 0usize);
    for y in 0..2 {
        for x in 0..2 {
            if colour(y, x) == 0 {
                rpos = (y, x);
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            let (yi, xi) = (y as isize, x as isize);
            let c = colour(y, x);
            let v = at(yi, xi);
            let n4 = at(yi - 1, xi) + at(yi + 1, xi) + at(yi, xi - 1) + at(yi, xi + 1);
            let d4 = at(yi - 1, xi - 1) + at(yi - 1, xi + 1) + at(yi + 1, xi - 1) + at(yi + 1, xi + 1);
            let h2 = at(yi, xi - 2) + at(yi, xi + 2);
            let v2 = at(yi - 2, xi) + at(yi + 2, xi);
            let mut rgb = [0f32; 3];
            rgb[c] = v;
            if c == 1 {
                // Green site: is red on this row or on this column?
                let red_row = (y & 1) == rpos.0;
                let horiz = (5.0 * v + 4.0 * (at(yi, xi - 1) + at(yi, xi + 1)) - d4 - h2 + 0.5 * v2) / 8.0;
                let vert = (5.0 * v + 4.0 * (at(yi - 1, xi) + at(yi + 1, xi)) - d4 - v2 + 0.5 * h2) / 8.0;
                if red_row {
                    rgb[0] = horiz;
                    rgb[2] = vert;
                } else {
                    rgb[0] = vert;
                    rgb[2] = horiz;
                }
            } else {
                let g = (4.0 * v + 2.0 * n4 - h2 - v2) / 8.0;
                let opp = (6.0 * v + 2.0 * d4 - 1.5 * (h2 + v2)) / 8.0;
                rgb[1] = g;
                rgb[2 - c] = opp;
            }
            let o = (y * w + x) * 3;
            out[o] = q16(rgb[0]);
            out[o + 1] = q16(rgb[1]);
            out[o + 2] = q16(rgb[2]);
        }
    }
}

/// Neighbourhood-average demosaic for any CFA (X-Trans and friends).
fn demosaic_generic(m: &[f32], w: usize, h: usize, colour: &dyn Fn(usize, usize) -> usize, out: &mut [u16]) {
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0f32; 3];
            let mut wt = [0f32; 3];
            let c0 = colour(y, x);
            for dy in -2isize..=2 {
                let yy = y as isize + dy;
                if yy < 0 || yy >= h as isize {
                    continue;
                }
                for dx in -2isize..=2 {
                    let xx = x as isize + dx;
                    if xx < 0 || xx >= w as isize {
                        continue;
                    }
                    let c = colour(yy as usize, xx as usize);
                    let k = 1.0 / (1.0 + (dx * dx + dy * dy) as f32);
                    sum[c] += m[yy as usize * w + xx as usize] * k;
                    wt[c] += k;
                }
            }
            let o = (y * w + x) * 3;
            for c in 0..3 {
                let v = if c == c0 { m[y * w + x] } else if wt[c] > 0.0 { sum[c] / wt[c] } else { 0.0 };
                out[o + c] = q16(v);
            }
        }
    }
}
