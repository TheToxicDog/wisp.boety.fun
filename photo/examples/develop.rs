// Native smoke test: decode a photo, render it with default settings plus any
// `index=value` overrides, and write a JPEG. Used to eyeball the pipeline.
//   cargo run --release --example develop -- in.nef out.jpg 1200 2=0.5 4=-50
use wisp_photo::{color, decode, image::Image, render};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).expect("read");
    let t = std::time::Instant::now();
    let img = Image::new(decode::decode(&bytes, 1).expect("decode"));
    eprintln!("decoded {}x{} raw={} {} {} in {:?}", img.w, img.h, img.is_raw, img.make, img.model, t.elapsed());
    let xyz = color::mulv(&img.cam2xyz, img.neutral);
    let (x, y) = color::xyz_to_xy(xyz);
    let (temp, tint) = color::wb_from_xy(img.is_raw, x, y);
    eprintln!("as shot {temp:.0}K tint {tint:.1}");
    let long: usize = a.get(3).map_or(1200, |s| s.parse().unwrap());
    let (ow, oh) = if img.w >= img.h { (long, long * img.h / img.w) } else { (long * img.w / img.h, long) };
    let mut p = vec![0f32; render::NP + render::NCTL + 4 * render::LUT_N + 2];
    p[render::TEMP] = if img.is_raw { temp } else { 0.0 };
    p[render::TINT] = if img.is_raw { tint } else { 0.0 };
    p[render::TR_SCALE] = 100.0;
    p[render::CROP_R] = 1.0;
    p[render::CROP_B] = 1.0;
    p[render::LENS_VIG_MID] = 50.0;
    p[render::VIG_MID] = 50.0;
    p[render::VIG_FEATHER] = 50.0;
    p[render::CG_BLENDING] = 50.0;
    p[render::SHARP_RADIUS] = 1.0;
    p[render::SHARP_DETAIL] = 25.0;
    p[render::GRAIN_SIZE] = 25.0;
    p[render::GRAIN_ROUGH] = 50.0;
    if img.is_raw {
        p[render::SHARP_AMOUNT] = 40.0;
        p[render::NR_COLOR] = 25.0;
    }
    p[render::NR_COLOR_DETAIL] = 50.0;
    p[render::NR_COLOR_SMOOTH] = 50.0;
    p[render::NR_LUM_DETAIL] = 50.0;
    let c = render::NP;
    p[c + 2] = 1.0;
    p[c + 3] = 1.0;
    p[c + 5] = -1.0;
    for k in 0..4 {
        for i in 0..render::LUT_N {
            p[c + render::NCTL + k * render::LUT_N + i] = i as f32 / (render::LUT_N - 1) as f32;
        }
    }
    for kv in a.iter().skip(4) {
        let (k, v) = kv.split_once('=').unwrap();
        p[k.parse::<usize>().unwrap()] = v.parse().unwrap();
    }
    let tr = color::Transfer::new();
    let mut out = render::Output { rgba: vec![], hist: vec![] };
    let t = std::time::Instant::now();
    render::render(&img, &p, ow, oh, &tr, &mut out).expect("render");
    eprintln!("rendered {ow}x{oh} in {:?}", t.elapsed());
    let rgb: Vec<u8> = out.rgba.chunks_exact(4).flat_map(|c| [c[0], c[1], c[2]]).collect();
    let mut buf = Vec::new();
    jpeg_encoder::Encoder::new(&mut buf, 90).encode(&rgb, ow as u16, oh as u16, jpeg_encoder::ColorType::Rgb).unwrap();
    std::fs::write(&a[2], buf).unwrap();
}
