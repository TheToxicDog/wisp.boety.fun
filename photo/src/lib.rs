// Wisp Photo develop engine: a C ABI over WebAssembly, driven by
// public/js/photo-worker.js. No wasm-bindgen: JS reads/writes linear memory
// directly through alloc/dealloc and the *_ptr getters.

pub mod color;
pub mod decode;
pub mod filters;
pub mod image;
pub mod render;

use image::Image;
use std::cell::RefCell;
use std::collections::HashMap;

struct State {
    images: HashMap<i32, Image>,
    next: i32,
    error: String,
    out: render::Output,
    info: Vec<f32>,
    text: Vec<u8>,
    tr: color::Transfer,
    canvas: Vec<u8>, // export RGB
    cw: usize,
    ch: usize,
    encoded: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.get_or_insert_with(|| State {
            images: HashMap::new(),
            next: 1,
            error: String::new(),
            out: render::Output { rgba: Vec::new(), hist: Vec::new() },
            info: Vec::new(),
            text: Vec::new(),
            tr: color::Transfer::new(),
            canvas: Vec::new(),
            cw: 0,
            ch: 0,
            encoded: Vec::new(),
        });
        f(st)
    })
}

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `alloc(n)` with the same `n`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

#[no_mangle]
pub extern "C" fn param_count() -> i32 {
    render::NP as i32
}

fn store(img: Image) -> i32 {
    with(|s| {
        let h = s.next;
        s.next += 1;
        s.images.insert(h, img);
        h
    })
}

/// Decode JPEG, PNG or a camera raw file. Returns a handle, or 0 (see last_error).
///
/// # Safety
/// `p..p+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn open(p: *const u8, len: usize, orientation: u32) -> i32 {
    let bytes = std::slice::from_raw_parts(p, len);
    match decode::decode(bytes, orientation as u16) {
        Ok(d) => store(Image::new(d)),
        Err(e) => {
            with(|s| s.error = e);
            0
        }
    }
}

/// Wrap RGBA8 pixels the browser decoded (WebP, HEIC, AVIF, GIF…).
///
/// # Safety
/// `p` must point to `w*h*4` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn open_rgba(p: *const u8, w: usize, h: usize) -> i32 {
    let px = std::slice::from_raw_parts(p, w * h * 4);
    store(Image::new(decode::from_rgba8(px, w, h)))
}

#[no_mangle]
pub extern "C" fn close(h: i32) {
    with(|s| {
        s.images.remove(&h);
    });
}

#[no_mangle]
pub extern "C" fn error_ptr() -> *const u8 {
    with(|s| s.error.as_ptr())
}

#[no_mangle]
pub extern "C" fn error_len() -> usize {
    with(|s| s.error.len())
}

/// [w, h, is_raw, as-shot temp, as-shot tint]; make/model via text_ptr/text_len.
#[no_mangle]
pub extern "C" fn info(h: i32) -> *const f32 {
    with(|s| {
        let Some(img) = s.images.get(&h) else { return std::ptr::null() };
        let n = img.neutral;
        let xyz = color::mulv(&img.cam2xyz, n);
        let (x, y) = color::xyz_to_xy(xyz);
        let (t, tint) = color::wb_from_xy(img.is_raw, x, y);
        let (t, tint) = if img.is_raw { (t, tint) } else { (0.0, 0.0) };
        s.info = vec![img.w as f32, img.h as f32, if img.is_raw { 1.0 } else { 0.0 }, t, tint];
        s.text = format!("{}\n{}", img.make, img.model).into_bytes();
        s.info.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn text_ptr() -> *const u8 {
    with(|s| s.text.as_ptr())
}

#[no_mangle]
pub extern "C" fn text_len() -> usize {
    with(|s| s.text.len())
}

fn wb_from_cam(img: &Image, cam: [f32; 3]) -> [f32; 2] {
    let xyz = color::mulv(&img.cam2xyz, [cam[0].max(1e-5), cam[1].max(1e-5), cam[2].max(1e-5)]);
    let (x, y) = color::xyz_to_xy(xyz);
    let (t, tint) = color::wb_from_xy(img.is_raw, x, y);
    [t, tint]
}

/// White balance that makes the area around (x, y) neutral. Coordinates in
/// source units (long edge = 1). Returns [temp, tint] via info buffer.
#[no_mangle]
pub extern "C" fn wb_pick(h: i32, x: f32, y: f32, r: f32) -> *const f32 {
    with(|s| {
        let Some(img) = s.images.get(&h) else { return std::ptr::null() };
        let ls = img.w.max(img.h) as f32;
        let lvl = img.pick_level(r * ls / 3.0);
        let mut acc = [0f32; 3];
        let mut nacc = 0.0;
        for dy in -2..=2 {
            for dx in -2..=2 {
                let c = img.sample(lvl, (x + dx as f32 * r * 0.4) * ls, (y + dy as f32 * r * 0.4) * ls);
                for k in 0..3 {
                    acc[k] += c[k];
                }
                nacc += 1.0;
            }
        }
        let cam = [acc[0] / nacc, acc[1] / nacc, acc[2] / nacc];
        s.info = wb_from_cam(img, cam).to_vec();
        s.info.as_ptr()
    })
}

/// Grey-world white balance over mid-tone pixels.
#[no_mangle]
pub extern "C" fn wb_auto(h: i32) -> *const f32 {
    with(|s| {
        let Some(img) = s.images.get(&h) else { return std::ptr::null() };
        let mut li = img.levels.len() - 1;
        while li > 0 && img.levels[li].w.max(img.levels[li].h) < 300 {
            li -= 1;
        }
        let lv = &img.levels[li];
        let mut acc = [0f64; 3];
        let mut n = 0.0;
        for c in lv.data.chunks_exact(3) {
            let v = [c[0] as f32 / 65535.0, c[1] as f32 / 65535.0, c[2] as f32 / 65535.0];
            let mx = v[0].max(v[1]).max(v[2]);
            if mx > 0.95 || mx < 0.02 {
                continue;
            }
            for k in 0..3 {
                acc[k] += v[k] as f64;
            }
            n += 1.0;
        }
        let cam = if n > 0.0 { [(acc[0] / n) as f32, (acc[1] / n) as f32, (acc[2] / n) as f32] } else { img.neutral };
        s.info = wb_from_cam(img, cam).to_vec();
        s.info.as_ptr()
    })
}

/// Render; returns 1 on success. Pixels at out_ptr (RGBA, w*h*4), histogram at hist_ptr (4×256 u32).
///
/// # Safety
/// `p` must point to `len` readable f32 values.
#[no_mangle]
pub unsafe extern "C" fn render(h: i32, p: *const f32, len: usize, w: usize, hgt: usize) -> i32 {
    let buf = std::slice::from_raw_parts(p, len);
    with(|s| {
        let State { images, out, tr, error, .. } = s;
        let Some(img) = images.get(&h) else {
            *error = "no such image".into();
            return 0;
        };
        match render::render(img, buf, w, hgt, tr, out) {
            Ok(()) => 1,
            Err(e) => {
                *error = e;
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    with(|s| s.out.rgba.as_ptr())
}

#[no_mangle]
pub extern "C" fn hist_ptr() -> *const u32 {
    with(|s| s.out.hist.as_ptr())
}

// ───────── Export: tiles are rendered into an RGB canvas, then encoded ─────────

#[no_mangle]
pub extern "C" fn export_begin(w: usize, h: usize) -> i32 {
    with(|s| {
        s.canvas = Vec::new();
        s.encoded = Vec::new();
        if s.canvas.try_reserve_exact(w * h * 3).is_err() {
            s.error = "not enough memory for export".into();
            return 0;
        }
        s.canvas.resize(w * h * 3, 0);
        s.cw = w;
        s.ch = h;
        1
    })
}

/// Copy the last render (tw×th) into the export canvas at (x, y).
#[no_mangle]
pub extern "C" fn export_tile(x: usize, y: usize, tw: usize, th: usize) {
    with(|s| {
        for j in 0..th {
            if y + j >= s.ch {
                break;
            }
            for i in 0..tw {
                if x + i >= s.cw {
                    break;
                }
                let src = (j * tw + i) * 4;
                let dst = ((y + j) * s.cw + x + i) * 3;
                s.canvas[dst..dst + 3].copy_from_slice(&s.out.rgba[src..src + 3]);
            }
        }
    })
}

/// Alpha-blend an RGBA overlay (e.g. a watermark) onto the export canvas.
///
/// # Safety
/// `p` must point to `w*h*4` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn export_blend(p: *const u8, w: usize, h: usize, x: i32, y: i32, opacity: f32) {
    let px = std::slice::from_raw_parts(p, w * h * 4);
    with(|s| {
        for j in 0..h {
            let yy = y + j as i32;
            if yy < 0 || yy >= s.ch as i32 {
                continue;
            }
            for i in 0..w {
                let xx = x + i as i32;
                if xx < 0 || xx >= s.cw as i32 {
                    continue;
                }
                let a = px[(j * w + i) * 4 + 3] as f32 / 255.0 * opacity;
                if a <= 0.0 {
                    continue;
                }
                let d = (yy as usize * s.cw + xx as usize) * 3;
                for k in 0..3 {
                    let v = s.canvas[d + k] as f32;
                    s.canvas[d + k] = (v + (px[(j * w + i) * 4 + k] as f32 - v) * a + 0.5) as u8;
                }
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn export_rgb_ptr() -> *const u8 {
    with(|s| s.canvas.as_ptr())
}

/// Encode the canvas: 0 = JPEG, 1 = PNG, 2 = TIFF. `meta` is an optional EXIF
/// APP1 payload for JPEG. Returns the encoded length (bytes at export_ptr), 0 on error.
///
/// # Safety
/// `meta..meta+meta_len` must be readable when meta_len > 0.
#[no_mangle]
pub unsafe extern "C" fn export_encode(fmt: u32, quality: u32, meta: *const u8, meta_len: usize) -> usize {
    let exif = if meta_len > 0 { std::slice::from_raw_parts(meta, meta_len).to_vec() } else { Vec::new() };
    with(|s| {
        let mut buf = Vec::new();
        let res: Result<(), String> = match fmt {
            0 => {
                let mut enc = jpeg_encoder::Encoder::new(&mut buf, quality.clamp(1, 100) as u8);
                enc.set_sampling_factor(if quality >= 90 { jpeg_encoder::SamplingFactor::R_4_4_4 } else { jpeg_encoder::SamplingFactor::R_4_2_0 });
                let r = if exif.is_empty() { Ok(()) } else { enc.add_app_segment(1, &exif).map_err(|e| e.to_string()) };
                r.and_then(|_| enc.encode(&s.canvas, s.cw as u16, s.ch as u16, jpeg_encoder::ColorType::Rgb).map_err(|e| e.to_string()))
            }
            1 => {
                let mut e = png::Encoder::new(&mut buf, s.cw as u32, s.ch as u32);
                e.set_color(png::ColorType::Rgb);
                e.set_depth(png::BitDepth::Eight);
                e.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
                e.write_header().and_then(|mut w| w.write_image_data(&s.canvas)).map_err(|e| e.to_string())
            }
            _ => {
                buf = tiff(&s.canvas, s.cw, s.ch);
                Ok(())
            }
        };
        match res {
            Ok(()) => {
                s.encoded = buf;
                s.encoded.len()
            }
            Err(e) => {
                s.error = e;
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn export_ptr() -> *const u8 {
    with(|s| s.encoded.as_ptr())
}

#[no_mangle]
pub extern "C" fn export_end() {
    with(|s| {
        s.canvas = Vec::new();
        s.encoded = Vec::new();
    })
}

/// Minimal baseline TIFF (8-bit RGB, uncompressed, one strip).
fn tiff(rgb: &[u8], w: usize, h: usize) -> Vec<u8> {
    let entries: [(u16, u16, u32, u32); 10] = [
        (256, 4, 1, w as u32),
        (257, 4, 1, h as u32),
        (258, 3, 3, 0), // patched: offset to bits-per-sample
        (259, 3, 1, 1),
        (262, 3, 1, 2),
        (273, 4, 1, 0), // patched: strip offset
        (277, 3, 1, 3),
        (278, 4, 1, h as u32),
        (279, 4, 1, (w * h * 3) as u32),
        (284, 3, 1, 1),
    ];
    let ifd_off = 8u32;
    let ifd_len = 2 + entries.len() as u32 * 12 + 4;
    let bps_off = ifd_off + ifd_len;
    let data_off = bps_off + 6;
    let mut v = Vec::with_capacity(data_off as usize + rgb.len());
    v.extend_from_slice(b"II*\0");
    v.extend_from_slice(&ifd_off.to_le_bytes());
    v.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for &(tag, typ, count, val) in &entries {
        let val = match tag {
            258 => bps_off,
            273 => data_off,
            _ => val,
        };
        v.extend_from_slice(&tag.to_le_bytes());
        v.extend_from_slice(&typ.to_le_bytes());
        v.extend_from_slice(&count.to_le_bytes());
        if typ == 3 && count == 1 {
            v.extend_from_slice(&(val as u16).to_le_bytes());
            v.extend_from_slice(&[0, 0]);
        } else {
            v.extend_from_slice(&val.to_le_bytes());
        }
    }
    v.extend_from_slice(&0u32.to_le_bytes());
    for _ in 0..3 {
        v.extend_from_slice(&8u16.to_le_bytes());
    }
    v.extend_from_slice(&rgb[..w * h * 3]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Vec<f32> {
        let mut p = vec![0f32; render::NP + render::NCTL + 4 * render::LUT_N + 2];
        p[render::TR_SCALE] = 100.0;
        p[render::CROP_R] = 1.0;
        p[render::CROP_B] = 1.0;
        p[render::LENS_VIG_MID] = 50.0;
        p[render::VIG_MID] = 50.0;
        p[render::VIG_FEATHER] = 50.0;
        p[render::CG_BLENDING] = 50.0;
        p[render::SHARP_RADIUS] = 1.0;
        p[render::SHARP_DETAIL] = 25.0;
        let c = render::NP;
        p[c + 2] = 1.0;
        p[c + 3] = 1.0;
        p[c + 5] = -1.0;
        for k in 0..4 {
            for i in 0..render::LUT_N {
                p[c + render::NCTL + k * render::LUT_N + i] = i as f32 / (render::LUT_N - 1) as f32;
            }
        }
        p
    }

    fn gradient_image() -> Image {
        let (w, h) = (64usize, 48usize);
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 4;
                rgba[o] = (x * 4) as u8;
                rgba[o + 1] = (y * 5) as u8;
                rgba[o + 2] = ((x + y) * 2) as u8;
                rgba[o + 3] = 255;
            }
        }
        Image::new(decode::from_rgba8(&rgba, w, h))
    }

    #[test]
    fn neutral_render_is_identity_for_jpeg() {
        let img = gradient_image();
        let tr = color::Transfer::new();
        let mut out = render::Output { rgba: vec![], hist: vec![] };
        render::render(&img, &params(), 64, 48, &tr, &mut out).unwrap();
        let mut worst = 0i32;
        for y in 0..48 {
            for x in 0..64 {
                let o = (y * 64 + x) * 4;
                let want = [(x * 4) as i32, (y * 5) as i32, ((x + y) * 2) as i32];
                for k in 0..3 {
                    worst = worst.max((out.rgba[o + k] as i32 - want[k]).abs());
                }
            }
        }
        assert!(worst <= 2, "max channel error {}", worst);
    }

    #[test]
    fn every_stage_runs() {
        let img = gradient_image();
        let tr = color::Transfer::new();
        let mut p = params();
        for (k, v) in [
            (render::EXPOSURE, 0.5),
            (render::CONTRAST, 30.0),
            (render::HIGHLIGHTS, -60.0),
            (render::SHADOWS, 50.0),
            (render::WHITES, 20.0),
            (render::BLACKS, -20.0),
            (render::TEXTURE, 30.0),
            (render::CLARITY, 40.0),
            (render::DEHAZE, 30.0),
            (render::VIBRANCE, 30.0),
            (render::SATURATION, 10.0),
            (render::HSL_HUE + 1, 30.0),
            (render::SHARP_AMOUNT, 80.0),
            (render::NR_LUM, 40.0),
            (render::NR_COLOR, 40.0),
            (render::VIG_AMOUNT, -40.0),
            (render::GRAIN_AMOUNT, 30.0),
            (render::LENS_DISTORTION, 20.0),
            (render::ANGLE, 5.0),
            (render::TEMP, 30.0),
            (render::CG + 1, 40.0),
        ] {
            p[k] = v;
        }
        render::render(&img, &p, 40, 30, &tr, &mut render::Output { rgba: vec![], hist: vec![] }).unwrap();
    }

    #[test]
    fn tiff_header() {
        let t = tiff(&[1, 2, 3, 4, 5, 6], 2, 1);
        assert_eq!(&t[..4], b"II*\0");
        assert_eq!(&t[t.len() - 6..], &[1, 2, 3, 4, 5, 6]);
    }
}
