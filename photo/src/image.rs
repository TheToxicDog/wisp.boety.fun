// A decoded photo held as a mip pyramid of linear u16 RGB, plus its colour metadata.

use crate::color::M3;
use crate::decode::Decoded;

pub struct Level {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u16>,
    pub inv_scale: f32, // level pixels per level-0 pixel
}

pub struct Image {
    pub w: usize,
    pub h: usize,
    pub levels: Vec<Level>,
    pub is_raw: bool,
    pub cam2xyz: M3,
    pub xyz2cam: M3,
    pub neutral: [f32; 3],
    pub make: String,
    pub model: String,
}

impl Image {
    pub fn new(d: Decoded) -> Image {
        let (w, h) = (d.w, d.h);
        let mut levels = vec![Level { w, h, data: d.data, inv_scale: 1.0 }];
        while {
            let l = levels.last().unwrap();
            l.w.max(l.h) > 96 && l.w > 1 && l.h > 1
        } {
            let l = levels.last().unwrap();
            let (nw, nh) = (l.w / 2, l.h / 2);
            let mut data = vec![0u16; nw * nh * 3];
            for y in 0..nh {
                let r0 = 2 * y * l.w;
                let r1 = (2 * y + 1) * l.w;
                for x in 0..nw {
                    for c in 0..3 {
                        let s = l.data[(r0 + 2 * x) * 3 + c] as u32
                            + l.data[(r0 + 2 * x + 1) * 3 + c] as u32
                            + l.data[(r1 + 2 * x) * 3 + c] as u32
                            + l.data[(r1 + 2 * x + 1) * 3 + c] as u32;
                        data[(y * nw + x) * 3 + c] = ((s + 2) / 4) as u16;
                    }
                }
            }
            levels.push(Level { w: nw, h: nh, data, inv_scale: nw as f32 / w as f32 });
        }
        Image {
            w,
            h,
            levels,
            is_raw: d.is_raw,
            cam2xyz: d.cam2xyz,
            xyz2cam: d.xyz2cam,
            neutral: d.neutral,
            make: d.make,
            model: d.model,
        }
    }

    /// Largest level whose resolution still covers `src_per_px` source pixels per output pixel.
    pub fn pick_level(&self, src_per_px: f32) -> usize {
        let mut l = 0;
        let mut s = 1.0;
        while l + 1 < self.levels.len() && s * 2.0 <= src_per_px.max(1.0) {
            s *= 2.0;
            l += 1;
        }
        l
    }

    /// Bilinear sample at level `l`, coordinates in level-0 pixels (continuous, pixel centres at .5).
    #[inline]
    pub fn sample(&self, l: usize, x: f32, y: f32) -> [f32; 3] {
        let lv = &self.levels[l];
        let fx = (x * lv.inv_scale - 0.5).clamp(0.0, (lv.w - 1) as f32);
        let fy = (y * lv.inv_scale - 0.5).clamp(0.0, (lv.h - 1) as f32);
        let x0 = fx as usize;
        let y0 = fy as usize;
        let x1 = (x0 + 1).min(lv.w - 1);
        let y1 = (y0 + 1).min(lv.h - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let d = &lv.data;
        let (a, b, c, e) = ((y0 * lv.w + x0) * 3, (y0 * lv.w + x1) * 3, (y1 * lv.w + x0) * 3, (y1 * lv.w + x1) * 3);
        let mut out = [0f32; 3];
        for k in 0..3 {
            let top = d[a + k] as f32 + (d[b + k] as f32 - d[a + k] as f32) * tx;
            let bot = d[c + k] as f32 + (d[e + k] as f32 - d[c + k] as f32) * tx;
            out[k] = (top + (bot - top) * ty) * (1.0 / 65535.0);
        }
        out
    }

    #[inline]
    pub fn sample_ch(&self, l: usize, x: f32, y: f32, k: usize) -> f32 {
        self.sample(l, x, y)[k]
    }
}
