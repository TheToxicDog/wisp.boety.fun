// BoetyCut: WebGL2 compositor. Each frame: background → per layer (draw the
// clip with transform/crop/colour/chroma/mask into a layer buffer, run its
// effects, blend onto the accumulator) → global effects/filters → screen.

const VS = `#version 300 es
in vec2 a;
uniform mat3 u_m;
out vec2 v_uv;
void main() {
  v_uv = a;
  vec3 p = u_m * vec3(a, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

// Full-screen pass: uv (0,0) = top-left of the target.
const FS_HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hue2rgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
`;

const LAYER_FS = FS_HEAD + `
uniform sampler2D u_tex;
uniform vec4 u_crop;      // l t r b in source uv
uniform vec2 u_texel;     // 1/source size
uniform float u_opacity;
uniform float u_adj[13];  // brightness contrast saturation exposure sharpen highlights shadows temperature tint hue fade vignette grain (-1..1)
uniform vec4 u_tone;      // shadow hue, shadow amt, highlight hue, highlight amt
uniform float u_time;
uniform vec4 u_chroma;    // r g b, on
uniform vec2 u_chromaP;   // intensity, shadow
uniform int u_mask;       // 0 none 1 linear 2 mirror 3 circle 4 rect 5 heart 6 star 7 diamond
uniform vec4 u_maskA;     // x y w h  (centre offset and size, in clip uv units)
uniform vec4 u_maskB;     // rot(rad) feather invert round
uniform vec2 u_aspect;    // clip w/h for round masks
uniform float u_blur;     // animation blur

float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdStar(vec2 p, float r) {
  const float an = 3.141593 / 5.0; const float en = 3.141593 / 2.5;
  vec2 acs = vec2(cos(an), sin(an)); vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs; p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}
float sdHeart(vec2 p) {
  p.y = -p.y + 0.55; p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)), dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
float maskAlpha(vec2 uv) {
  if (u_mask == 0) return 1.0;
  vec2 p = (uv - 0.5 - u_maskA.xy * 0.5) * u_aspect;
  float c = cos(u_maskB.x), s = sin(u_maskB.x);
  p = mat2(c, s, -s, c) * p;
  vec2 hs = u_maskA.zw * 0.5 * u_aspect;
  float d;
  if (u_mask == 1) d = p.y;
  else if (u_mask == 2) d = abs(p.y) - hs.y;
  else if (u_mask == 3) d = length(p / max(hs, 1e-4)) - 1.0;
  else if (u_mask == 4) d = sdBox(p, hs, u_maskB.w * min(hs.x, hs.y));
  else if (u_mask == 5) d = sdHeart(p / max(hs.x, 1e-4) * 0.6) ;
  else if (u_mask == 6) d = sdStar(p / max(hs.x, 1e-4), 0.9);
  else d = (abs(p.x) / max(hs.x, 1e-4) + abs(p.y) / max(hs.y, 1e-4)) - 1.0;
  float f = max(u_maskB.y, 0.002);
  float a = 1.0 - smoothstep(-f, f, d);
  return u_maskB.z > 0.5 ? 1.0 - a : a;
}
vec3 hueShift(vec3 c, float h) {
  const mat3 toY = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toR = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toY * c; float a = h * 3.141593; float cs = cos(a), sn = sin(a);
  y.yz = mat2(cs, sn, -sn, cs) * y.yz;
  return toR * y;
}
vec4 sampleSrc(vec2 uv) {
  if (u_blur <= 0.0) return texture(u_tex, uv);
  vec4 acc = vec4(0.0); float r = u_blur * 0.02;
  for (int i = 0; i < 12; i++) { float a = float(i) * 2.3999; float d = sqrt(float(i) / 12.0); acc += texture(u_tex, uv + vec2(cos(a), sin(a)) * r * d); }
  return acc / 12.0;
}
void main() {
  vec2 uv = mix(u_crop.xy, u_crop.zw, v_uv);
  vec4 t = sampleSrc(uv);
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  float a = t.a;
  float sh = u_adj[4];
  if (sh != 0.0) {
    vec3 n = texture(u_tex, uv + vec2(u_texel.x, 0.0)).rgb + texture(u_tex, uv - vec2(u_texel.x, 0.0)).rgb
           + texture(u_tex, uv + vec2(0.0, u_texel.y)).rgb + texture(u_tex, uv - vec2(0.0, u_texel.y)).rgb;
    c += (c - n * 0.25) * sh * 2.5;
  }
  c *= exp2(u_adj[3] * 1.5);
  c += u_adj[0] * 0.25;
  float l = luma(c);
  c += u_adj[5] * 0.35 * smoothstep(0.45, 1.0, l) * (u_adj[5] < 0.0 ? 1.0 : 0.6);
  c += u_adj[6] * 0.35 * (1.0 - smoothstep(0.0, 0.55, l));
  c = (c - 0.5) * (1.0 + u_adj[1] * (u_adj[1] > 0.0 ? 0.9 : 0.6)) + 0.5;
  c.r += u_adj[7] * 0.1; c.b -= u_adj[7] * 0.1;
  c.g -= u_adj[8] * 0.08; c.rb += u_adj[8] * 0.03;
  if (u_adj[9] != 0.0) c = hueShift(c, u_adj[9]);
  l = luma(c);
  c = mix(vec3(l), c, 1.0 + u_adj[2]);
  if (u_tone.y > 0.0) c += (hue2rgb(u_tone.x) - 0.5) * u_tone.y * 0.5 * (1.0 - smoothstep(0.0, 0.6, l));
  if (u_tone.w > 0.0) c += (hue2rgb(u_tone.z) - 0.5) * u_tone.w * 0.5 * smoothstep(0.4, 1.0, l);
  c = c * (1.0 - u_adj[10] * 0.25) + u_adj[10] * 0.12;
  if (u_adj[11] != 0.0) { vec2 d = v_uv - 0.5; c *= 1.0 - u_adj[11] * smoothstep(0.3, 0.85, length(d) * 1.2); }
  if (u_adj[12] > 0.0) c += (hash(v_uv * 1000.0 + u_time) - 0.5) * u_adj[12] * 0.25;
  c = clamp(c, 0.0, 1.0);
  if (u_chroma.w > 0.5) {
    vec3 k = u_chroma.rgb;
    vec2 cc = vec2(dot(c, vec3(-0.169, -0.331, 0.5)), dot(c, vec3(0.5, -0.419, -0.081)));
    vec2 kc = vec2(dot(k, vec3(-0.169, -0.331, 0.5)), dot(k, vec3(0.5, -0.419, -0.081)));
    float dist = distance(cc, kc);
    float sim = u_chromaP.x * 0.4 + 0.02;
    float ka = smoothstep(sim, sim + 0.02 + u_chromaP.y * 0.2, dist);
    a *= ka;
    // spill suppression
    c = mix(vec3(luma(c)), c, ka);
  }
  a *= maskAlpha(v_uv) * u_opacity;
  o = vec4(c * a, a);
}`;

// Blend layer (premultiplied) over accumulator.
const COMP_FS = FS_HEAD + `
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
vec3 blend(vec3 b, vec3 s, int m) {
  if (m == 1) return b * s;
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return min(b + s, 1.0);
  if (m == 7) return abs(b - s);
  if (m == 8) return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s), sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(0.5, s));
  if (m == 9) return 1.0 - min(vec3(1.0), (1.0 - b) / max(s, 1e-3));
  return s;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv);
  if (s.a <= 0.0) { o = d; return; }
  vec3 sc = s.rgb / s.a;
  vec3 bc = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 m = blend(bc, sc, u_mode);
  vec3 col = mix(sc, m, d.a);
  o = vec4(col * s.a + d.rgb * (1.0 - s.a), s.a + d.a * (1.0 - s.a));
}`;

const EFFECT_FS = FS_HEAD + `
uniform sampler2D u_tex;
uniform int u_n;
uniform float u_amt;
uniform float u_t;
uniform vec2 u_res;
vec4 tx(vec2 uv) { return texture(u_tex, clamp(uv, 0.0, 1.0)); }
vec4 blurAt(vec2 uv, float r) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) { float a = float(i) * 2.3999; float d = sqrt((float(i) + 0.5) / 24.0); acc += tx(uv + vec2(cos(a), sin(a)) * r * d / 1000.0 * vec2(u_res.y / u_res.x, 1.0)); }
  return acc / 24.0;
}
float edge(vec2 uv) {
  vec2 e = 1.5 / u_res;
  float gx = luma(tx(uv + vec2(e.x, 0)).rgb) - luma(tx(uv - vec2(e.x, 0)).rgb);
  float gy = luma(tx(uv + vec2(0, e.y)).rgb) - luma(tx(uv - vec2(0, e.y)).rgb);
  return length(vec2(gx, gy));
}
void main() {
  vec2 uv = v_uv; float A = u_amt; float t = u_t;
  vec4 c;
  if (u_n == 1) c = blurAt(uv, A * 30.0);
  else if (u_n == 2) { vec2 off = vec2(hash(vec2(floor(t * 24.0), 1.0)) - 0.5, hash(vec2(floor(t * 24.0), 2.0)) - 0.5) * 0.04 * A; c = tx((uv - 0.5) / (1.0 + 0.06 * A) + 0.5 + off); }
  else if (u_n == 3) { float z = 1.0 + A * 0.18 * abs(sin(t * 3.14159 * 1.5)); c = tx((uv - 0.5) / z + 0.5); }
  else if (u_n == 4) { c = tx(uv); c.rgb = mix(c.rgb, vec3(c.a), pow(abs(sin(t * 3.14159 * 1.2)), 10.0) * A); }
  else if (u_n == 5) { c = tx(uv); c.rgb *= mix(1.0, step(0.5, fract(t * 7.0)) * 1.4, A); }
  else if (u_n == 6) { c = tx(uv); c.rgb *= 1.0 - A * smoothstep(0.2, 0.8, length(uv - 0.5) * 1.3); }
  else if (u_n == 7) { float b = mix(1.0, 60.0, A) / u_res.x; vec2 bb = vec2(b, b * u_res.x / u_res.y); c = tx((floor(uv / bb) + 0.5) * bb); }
  else if (u_n == 8) { c = tx(vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y)); }
  else if (u_n == 9) { c = tx(abs(fract(uv * 2.0) * 2.0 - 1.0) * 0.5 + 0.25); }
  else if (u_n == 10) { c = tx(vec2(uv.x, fract(uv.y * 3.0) / 3.0 + 1.0 / 3.0)); }
  else if (u_n == 11) { c = tx(fract(uv * 2.0)); }
  else if (u_n == 12) { float o2 = 0.012 * A; c = vec4(tx(uv + vec2(o2, 0)).r, tx(uv).g, tx(uv - vec2(o2, 0)).b, tx(uv).a); }
  else if (u_n == 13) {
    float blk = floor(t * 12.0); float row = floor(uv.y * 18.0);
    float r = hash(vec2(row, blk)); float sh = (r > 0.75 ? (hash(vec2(blk, row + 3.0)) - 0.5) * 0.15 * A : 0.0);
    vec2 u2 = uv + vec2(sh, 0.0); float o2 = 0.01 * A * step(0.6, hash(vec2(blk, 7.0)));
    c = vec4(tx(u2 + vec2(o2, 0)).r, tx(u2).g, tx(u2 - vec2(o2, 0)).b, tx(u2).a);
  }
  else if (u_n == 14) {
    float w = sin(uv.y * 40.0 + t * 8.0) * 0.002 * A + (hash(vec2(floor(uv.y * 240.0), floor(t * 30.0))) - 0.5) * 0.004 * A;
    vec2 u2 = uv + vec2(w, 0.0);
    c = vec4(tx(u2 + vec2(0.004 * A, 0)).r, tx(u2).g, tx(u2 - vec2(0.004 * A, 0)).b, 1.0);
    c.rgb += (hash(uv * u_res + t) - 0.5) * 0.12 * A; c.rgb *= 1.0 - 0.15 * A * step(0.5, fract(uv.y * u_res.y / 3.0));
    c.rgb = mix(c.rgb, c.rgb * vec3(1.05, 0.95, 1.1), A);
  }
  else if (u_n == 15) {
    vec2 d = uv - 0.5; vec2 u2 = uv + d * dot(d, d) * 0.15 * A; c = tx(u2);
    c.rgb *= 1.0 - 0.35 * A * step(0.5, fract(uv.y * u_res.y / 4.0));
    c.rgb = mix(c.rgb, vec3(luma(c.rgb)), 0.4 * A); c.rgb += (hash(uv * 900.0 + t) - 0.5) * 0.1 * A;
    if (u2.x < 0.0 || u2.x > 1.0 || u2.y < 0.0 || u2.y > 1.0) c = vec4(0, 0, 0, 1);
  }
  else if (u_n == 16) { c = tx(uv); c.rgb += (hash(uv * u_res + fract(t * 13.0) * 100.0) - 0.5) * 0.35 * A; }
  else if (u_n == 17) { c = tx(uv); float g = smoothstep(1.2, 0.0, length(uv - vec2(0.9 + 0.1 * sin(t), 0.1))); c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - vec3(1.0, 0.55, 0.2) * g * A * 0.9); }
  else if (u_n == 18) { c = tx(uv + vec2(sin(uv.y * 18.0 + t * 4.0), cos(uv.x * 14.0 + t * 3.0)) * 0.012 * A); }
  else if (u_n == 19) { vec2 d = uv - 0.5; float r = length(d); c = tx(0.5 + d * (1.0 - A * 0.5 + A * 0.5 * r * r * 2.6)); }
  else if (u_n == 20) { vec4 b = blurAt(uv, 25.0); c = tx(uv); c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - b.rgb * 0.8 * A); }
  else if (u_n == 21) { c = tx(uv); c.rgb = mix(c.rgb, c.rgb * 0.6 + hue2rgb(fract(uv.x * 0.8 + uv.y * 0.4 - t * 0.3)) * 0.55, A * 0.6); }
  else if (u_n == 22) {
    c = tx(uv); vec2 g = uv * vec2(u_res.x / u_res.y, 1.0) * 14.0; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
    float h = hash(id); float tw = pow(abs(sin(t * (2.0 + h * 4.0) + h * 40.0)), 12.0);
    float s = step(0.82, h) * tw * (0.012 / (dot(f, f) + 0.012)) * (max(0.0, 1.0 - abs(f.x) * 12.0) + max(0.0, 1.0 - abs(f.y) * 12.0) + 0.5);
    c.rgb += vec3(1.0, 0.95, 0.8) * s * A;
  }
  else if (u_n == 23) { c = tx(uv); c.rgb = mix(c.rgb, 1.0 - c.rgb, A); }
  else if (u_n == 24) { c = tx(uv); float lv = mix(16.0, 3.0, A); c.rgb = floor(c.rgb * lv) / lv; }
  else if (u_n == 25) { c = tx(uv); float l = luma(c.rgb); c.rgb = mix(c.rgb, mix(vec3(0.25, 0.05, 0.45), vec3(1.0, 0.85, 0.3), l), A); }
  else if (u_n == 26) { c = tx(uv); float e = edge(uv); c.rgb = mix(c.rgb, vec3(1.0 - smoothstep(0.02, 0.25, e)), A); }
  else if (u_n == 27) { c = tx(uv); float e = smoothstep(0.05, 0.3, edge(uv)); c.rgb = mix(c.rgb, c.rgb * 0.15 + hue2rgb(fract(uv.y + t * 0.2)) * e * 1.5, A); }
  else if (u_n == 28) { c = tx(uv); float b = 0.13 * A; if (uv.y < b || uv.y > 1.0 - b) c = vec4(0, 0, 0, 1); }
  else if (u_n == 29) { c = tx(uv); c.rgb *= 1.0 - A; }
  else if (u_n == 30) { c = tx(uv + vec2(hash(vec2(floor(uv.y * 80.0), floor(t * 20.0))) - 0.5, 0.0) * 0.006 * A + vec2(sin(uv.y * 60.0 + t * 10.0) * 0.003 * A, 0.0)); }
  else c = tx(uv);
  o = c;
}`;

const TRANS_FS = FS_HEAD + `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform int u_n;
uniform vec2 u_res;
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0, 0, 0, 1) : texture(u_a, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0, 0, 0, 1) : texture(u_b, uv); }
vec4 blurT(sampler2D s, vec2 uv, float r) { vec4 acc = vec4(0.0); for (int i = 0; i < 16; i++) { float a = float(i) * 2.3999; float d = sqrt((float(i) + 0.5) / 16.0); acc += texture(s, uv + vec2(cos(a), sin(a)) * r * d); } return acc / 16.0; }
void main() {
  vec2 uv = v_uv; float p = u_p; float e = 0.02; float asp = u_res.x / u_res.y;
  vec4 c;
  if (u_n == 1) c = mix(A(uv), B(uv), p);
  else if (u_n == 2) c = p < 0.5 ? mix(A(uv), vec4(0, 0, 0, 1), p * 2.0) : mix(vec4(0, 0, 0, 1), B(uv), p * 2.0 - 1.0);
  else if (u_n == 3) c = p < 0.5 ? mix(A(uv), vec4(1), p * 2.0) : mix(vec4(1), B(uv), p * 2.0 - 1.0);
  else if (u_n == 4) c = mix(A(uv), B(uv), smoothstep(p - e, p + e, 1.0 - uv.x) );
  else if (u_n == 5) c = mix(A(uv), B(uv), smoothstep(p - e, p + e, uv.x));
  else if (u_n == 6) c = mix(A(uv), B(uv), smoothstep(p - e, p + e, uv.y));
  else if (u_n == 7) c = mix(A(uv), B(uv), smoothstep(p - e, p + e, 1.0 - uv.y));
  else if (u_n == 8) c = uv.x < 1.0 - p ? A(uv + vec2(p, 0)) : B(uv - vec2(1.0 - p, 0));
  else if (u_n == 9) c = uv.x > p ? A(uv - vec2(p, 0)) : B(uv + vec2(1.0 - p, 0));
  else if (u_n == 10) c = uv.y < 1.0 - p ? A(uv + vec2(0, p)) : B(uv - vec2(0, 1.0 - p));
  else if (u_n == 11) c = uv.y > p ? A(uv - vec2(0, p)) : B(uv + vec2(0, 1.0 - p));
  else if (u_n == 12) { float z = 1.0 + p * 1.5; c = mix(A((uv - 0.5) / z + 0.5), B((uv - 0.5) / (0.6 + 0.4 * p) + 0.5), smoothstep(0.3, 0.8, p)); }
  else if (u_n == 13) { float z = 1.0 - p * 0.5; c = mix(A((uv - 0.5) / z + 0.5), B((uv - 0.5) * (1.6 - 0.6 * p) + 0.5), smoothstep(0.3, 0.8, p)); }
  else if (u_n == 14) {
    float an = p * 6.2832; vec2 d = (uv - 0.5) * vec2(asp, 1.0); float s = 1.0 + sin(p * 3.14159) * 0.8;
    d = mat2(cos(an), sin(an), -sin(an), cos(an)) * d * s; vec2 u2 = d / vec2(asp, 1.0) + 0.5;
    c = mix(A(u2), B(u2), smoothstep(0.4, 0.6, p));
  }
  else if (u_n == 15) { float r = sin(p * 3.14159) * 0.03; c = mix(blurT(u_a, uv, r), blurT(u_b, uv, r), p); }
  else if (u_n == 16) { float d = length((uv - 0.5) * vec2(asp, 1.0)); c = mix(A(uv), B(uv), 1.0 - smoothstep(p * 1.2 - e, p * 1.2 + e, d)); }
  else if (u_n == 17) { float d = length((uv - 0.5) * vec2(asp, 1.0)); c = mix(B(uv), A(uv), 1.0 - smoothstep((1.0 - p) * 1.2 - e, (1.0 - p) * 1.2 + e, d)); }
  else if (u_n == 18) { float a = atan(uv.x - 0.5, -(uv.y - 0.5)) / 6.2832 + 0.5; c = mix(A(uv), B(uv), step(a, p)); }
  else if (u_n == 19) { float s = sin(p * 3.14159); float b = mix(1.0, 50.0, s) / u_res.x; vec2 bb = vec2(b, b * asp); vec2 q = (floor(uv / bb) + 0.5) * bb; c = mix(A(q), B(q), step(0.5, p)); }
  else if (u_n == 20) {
    float s = sin(p * 3.14159); float row = floor(uv.y * 20.0); float sh = (hash(vec2(row, floor(p * 20.0))) - 0.5) * 0.2 * s;
    vec2 u2 = uv + vec2(sh, 0.0); vec4 a2 = vec4(A(u2 + vec2(0.02 * s, 0)).r, A(u2).g, A(u2 - vec2(0.02 * s, 0)).b, 1.0);
    vec4 b2 = vec4(B(u2 + vec2(0.02 * s, 0)).r, B(u2).g, B(u2 - vec2(0.02 * s, 0)).b, 1.0); c = mix(a2, b2, step(0.5, p));
  }
  else if (u_n == 21) { float d = abs(uv.x - 0.5); c = d < p * 0.5 ? B(uv) : A(uv.x < 0.5 ? uv + vec2(p * 0.5, 0) : uv - vec2(p * 0.5, 0)); }
  else if (u_n == 22) { float d = abs(uv.x - 0.5) * asp + abs(uv.y - 0.5); c = mix(A(uv), B(uv), 1.0 - smoothstep(p * 1.6 - e, p * 1.6 + e, d)); }
  else if (u_n == 23) { float s = sin(p * 3.14159) * 0.04; vec4 m = mix(A(uv), B(uv), p); c = vec4(mix(A(uv + vec2(s, 0)), B(uv + vec2(s, 0)), p).r, m.g, mix(A(uv - vec2(s, 0)), B(uv - vec2(s, 0)), p).b, 1.0); }
  else c = mix(A(uv), B(uv), p);
  o = c;
}`;

const COPY_FS = FS_HEAD + `
uniform sampler2D u_tex;
uniform float u_alpha;
void main() { o = texture(u_tex, v_uv) * u_alpha; }`;

const GRAD_FS = FS_HEAD + `
uniform vec3 u_c1;
uniform vec3 u_c2;
void main() { o = vec4(mix(u_c1, u_c2, 1.0 - v_uv.y), 1.0); }`;

export class Compositor {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: preserve, antialias: false });
    if (!gl) throw new Error("WebGL2 isn't available in this browser");
    this.gl = gl;
    this.progs = {
      layer: this.prog(LAYER_FS), comp: this.prog(COMP_FS), effect: this.prog(EFFECT_FS),
      trans: this.prog(TRANS_FS), copy: this.prog(COPY_FS), grad: this.prog(GRAD_FS),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.textures = new Map(); // key → { tex, w, h, src }
    this.fbos = [];
    this.w = this.h = 0;
  }

  prog(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "a");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace("[0]", "")] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [0, 1, 2, 3, 4, 5].map(() => this.fbo(w, h));
    this.small = this.fbo(Math.max(8, Math.round(w / 16)), Math.max(8, Math.round(h / 16)));
  }

  fbo(w, h) {
    const gl = this.gl;
    const tex = this.newTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  newTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Upload (or reuse) a texture for an image source; `version` changes force re-upload. */
  texture(key, src, version) {
    const gl = this.gl;
    let t = this.textures.get(key);
    if (!t) { t = { tex: this.newTex(), src: null, version: null }; this.textures.set(key, t); }
    if (t.src !== src || t.version !== version) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      t.src = src; t.version = version;
      t.w = src.displayWidth || src.videoWidth || src.width; t.h = src.displayHeight || src.videoHeight || src.height;
    }
    t.used = true;
    return t;
  }

  /** Free textures not used since the last call. */
  sweep() {
    for (const [k, t] of this.textures) {
      if (!t.used) { this.gl.deleteTexture(t.tex); this.textures.delete(k); } else t.used = false;
    }
  }

  target(f) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f ? f.fb : null);
    gl.viewport(0, 0, f ? f.w : this.w, f ? f.h : this.h);
  }

  bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // Full-screen quad in GL orientation (uv matches framebuffer texture coords, y up).
  full(prog) { this.gl.uniformMatrix3fv(prog.u.u_m, false, [2, 0, 0, 0, 2, 0, -1, -1, 1]); }

  clear(f, rgba = [0, 0, 0, 0]) {
    const gl = this.gl;
    this.target(f);
    gl.clearColor(...rgba);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw() { this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }

  /**
   * Render a frame.
   * scene = { bg: {type, color, c1, c2, src?}, layers: [{ tex, quad, crop, adj, tone, opacity, chroma, mask, blend, effects:[{n, amt, t}], blur, trans? }], post: [{n, amt, t} | {adj, tone}] }
   */
  render(scene, toScreen = true) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    let [acc, other] = [this.fbos[0], this.fbos[1]];
    const layerF = this.fbos[2], tmp = this.fbos[3];
    // Background
    const bg = scene.bg || {};
    if (bg.type === "gradient") {
      const P = this.progs.grad;
      this.target(acc); gl.useProgram(P.p); this.full(P);
      gl.uniform3fv(P.u.u_c1, hex(bg.c1)); gl.uniform3fv(P.u.u_c2, hex(bg.c2));
      this.draw();
    } else if (bg.type === "blur" && bg.layer) {
      // cover-fit the main frame into a tiny buffer, then stretch back: a cheap heavy blur
      this.clear(this.small, [0, 0, 0, 1]);
      this.drawLayer({ ...bg.layer, quad: coverQuad(bg.layer.srcW, bg.layer.srcH, this.w, this.h), mask: null, opacity: 1, chroma: null, blur: 0 }, this.small);
      this.clear(acc, [0, 0, 0, 1]);
      const P = this.progs.copy;
      this.target(acc); gl.useProgram(P.p); this.full(P);
      this.bindTex(0, this.small.tex); gl.uniform1i(P.u.u_tex, 0); gl.uniform1f(P.u.u_alpha, 1);
      this.draw();
      this.effectPass(acc, other, { n: 1, amt: Math.min(1, (bg.blur ?? 40) / 100 + 0.2), t: 0 });
      [acc, other] = [other, acc];
    } else {
      const c = hex(bg.color || "#000000");
      this.clear(acc, [c[0], c[1], c[2], 1]);
    }
    for (const L of scene.layers) {
      this.clear(layerF);
      if (L.trans) {
        // two clips crossing: render each into its own buffer, then mix
        const fa = this.fbos[4], fb = this.fbos[5];
        this.clear(fa); this.clear(fb);
        this.drawLayer(L.trans.a, fa);
        this.runEffects(fa, tmp, L.trans.a.effects);
        this.drawLayer(L.trans.b, fb);
        this.runEffects(fb, tmp, L.trans.b.effects);
        const P = this.progs.trans;
        this.target(layerF); gl.useProgram(P.p); this.full(P);
        this.bindTex(0, fa.tex); this.bindTex(1, fb.tex);
        gl.uniform1i(P.u.u_a, 0); gl.uniform1i(P.u.u_b, 1);
        gl.uniform1f(P.u.u_p, L.trans.p); gl.uniform1i(P.u.u_n, L.trans.n); gl.uniform2f(P.u.u_res, this.w, this.h);
        this.draw();
      } else {
        this.drawLayer(L, layerF);
        this.runEffects(layerF, tmp, L.effects);
      }
      this.composite(acc, layerF, other, L.blend || 0);
      [acc, other] = [other, acc];
    }
    for (const fx of scene.post || []) {
      if (fx.adj) {
        // global filter/adjust: the accumulator itself is the "layer"
        this.clear(other);
        this.drawLayer({ tex: acc.tex, quad: [2, 0, 0, 0, -2, 0, -1, 1, 1], flipY: true, crop: [0, 1, 1, 0], adj: fx.adj, tone: fx.tone, opacity: 1, srcW: this.w, srcH: this.h }, other);
      } else this.effectPass(acc, other, fx);
      [acc, other] = [other, acc];
    }
    if (toScreen) {
      const P = this.progs.copy;
      this.target(null); gl.useProgram(P.p);
      gl.uniformMatrix3fv(P.u.u_m, false, [2, 0, 0, 0, 2, 0, -1, -1, 1]);
      this.bindTex(0, acc.tex); gl.uniform1i(P.u.u_tex, 0); gl.uniform1f(P.u.u_alpha, 1);
      this.draw();
    }
    this.sweep();
    return acc;
  }

  runEffects(f, tmp, effects) {
    if (!effects?.length) return;
    for (const e of effects) {
      this.effectPass(f, tmp, e);
      // copy back so `f` keeps the result
      const gl = this.gl, P = this.progs.copy;
      this.target(f); gl.useProgram(P.p); this.full(P);
      this.bindTex(0, tmp.tex); gl.uniform1i(P.u.u_tex, 0); gl.uniform1f(P.u.u_alpha, 1);
      this.draw();
    }
  }

  effectPass(src, dst, e) {
    const gl = this.gl, P = this.progs.effect;
    this.target(dst); gl.useProgram(P.p); this.full(P);
    this.bindTex(0, src.tex);
    gl.uniform1i(P.u.u_tex, 0); gl.uniform1i(P.u.u_n, e.n); gl.uniform1f(P.u.u_amt, e.amt); gl.uniform1f(P.u.u_t, e.t || 0);
    gl.uniform2f(P.u.u_res, dst.w, dst.h);
    this.draw();
  }

  composite(dst, src, out, mode) {
    const gl = this.gl, P = this.progs.comp;
    this.target(out); gl.useProgram(P.p); this.full(P);
    this.bindTex(0, dst.tex); this.bindTex(1, src.tex);
    gl.uniform1i(P.u.u_dst, 0); gl.uniform1i(P.u.u_src, 1); gl.uniform1i(P.u.u_mode, mode);
    this.draw();
  }

  drawLayer(L, f) {
    const gl = this.gl, P = this.progs.layer;
    this.target(f); gl.useProgram(P.p);
    gl.uniformMatrix3fv(P.u.u_m, false, L.quad);
    this.bindTex(0, L.tex);
    gl.uniform1i(P.u.u_tex, 0);
    const cr = L.crop || [0, 0, 1, 1];
    gl.uniform4f(P.u.u_crop, cr[0], cr[1], cr[2], cr[3]);
    gl.uniform2f(P.u.u_texel, 1 / (L.srcW || 1), 1 / (L.srcH || 1));
    gl.uniform1f(P.u.u_opacity, L.opacity ?? 1);
    gl.uniform1fv(P.u.u_adj, L.adj || ZERO13);
    gl.uniform4fv(P.u.u_tone, L.tone || [0, 0, 0, 0]);
    gl.uniform1f(P.u.u_time, L.time || 0);
    const ch = L.chroma;
    gl.uniform4f(P.u.u_chroma, ...(ch ? [...hex(ch.color), 1] : [0, 0, 0, 0]));
    gl.uniform2f(P.u.u_chromaP, ch ? ch.intensity : 0, ch ? ch.shadow : 0);
    const m = L.mask;
    gl.uniform1i(P.u.u_mask, m ? MASK_N[m.type] || 0 : 0);
    gl.uniform4f(P.u.u_maskA, m?.x || 0, m?.y || 0, m?.w || 0.5, m?.h || 0.5);
    gl.uniform4f(P.u.u_maskB, (m?.rot || 0) * Math.PI / 180, m?.feather || 0, m?.invert ? 1 : 0, m?.round || 0);
    gl.uniform2f(P.u.u_aspect, L.aspect || 1, 1);
    gl.uniform1f(P.u.u_blur, L.blur || 0);
    this.draw();
  }

  readPixels() {
    const gl = this.gl;
    const px = new Uint8Array(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  destroy() {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}

const ZERO13 = new Float32Array(13);
const MASK_N = { linear: 1, mirror: 2, circle: 3, rect: 4, heart: 5, star: 6, diamond: 7 };

export function hex(s) {
  const v = parseInt((s || "#000").replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

/**
 * Matrix mapping the unit quad to clip space for an element of size (w, h)
 * centred at (cx, cy) in output pixels, rotated `rot` degrees clockwise.
 */
export function quadMatrix(W, H, cx, cy, w, h, rot = 0, flipH = false, flipV = false) {
  const r = rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const sx = flipH ? -w : w, sy = flipV ? -h : h;
  // unit (u,v) → local ((u-0.5)*sx, (v-0.5)*sy) → rotate → + centre → clip
  const ax = c * sx, ay = s * sx; // derivative wrt u
  const bx = -s * sy, by = c * sy; // derivative wrt v
  const ox = cx - 0.5 * ax - 0.5 * bx, oy = cy - 0.5 * ay - 0.5 * by;
  // clip = (px/W*2-1, 1-py/H*2)
  return [ax * 2 / W, -ay * 2 / H, 0, bx * 2 / W, -by * 2 / H, 0, ox * 2 / W - 1, 1 - oy * 2 / H, 1];
}

function coverQuad(sw, sh, W, H) {
  const k = Math.max(W / (sw || W), H / (sh || H));
  return quadMatrix(W, H, W / 2, H / 2, (sw || W) * k, (sh || H) * k);
}
