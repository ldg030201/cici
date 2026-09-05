#!/usr/bin/env node
// cici 아이콘/스토어 이미지 생성기
//
// 외부 도구(ImageMagick, rsvg, sharp) 없이 순수 Node 로 PNG 를 만든다.
// - PNG 인코더: IHDR / IDAT / IEND, 8비트 RGBA, 필터 0(None), zlib 은 node 내장.
// - 래스터라이저: SDF(부호 있는 거리 함수) + 4x 슈퍼샘플링으로 안티앨리어싱.
//
// 사용법:
//   node scripts/make-icons.mjs                 # extension/icons/*.png 생성
//   node scripts/make-icons.mjs --store <dir>   # 스토어 등록용 이미지도 함께 생성
//   node scripts/make-icons.mjs --preview <dir> # 육안 확인용 대조 시트 생성
//
// 런타임 의존성 0개. 이 스크립트도 node 내장 모듈만 쓴다.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { crc32 } from './lib/crc32.mjs';
import { isMainEntry } from './lib/main-entry.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// PNG 인코더
// ─────────────────────────────────────────────────────────────────────────────

/** 타입 + 데이터를 길이/CRC 로 감싼 PNG 청크 하나로 만든다(CRC-32 는 사양 Annex D). */
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * 8비트 RGBA 픽셀 배열을 PNG 파일 바이트로 인코딩한다.
 *
 * rgb: true 면 알파 채널을 버리고 컬러 타입 2(24비트 RGB)로 쓴다.
 * 크롬 웹스토어의 프로모 이미지·스크린샷은 알파 없는 24비트 PNG 를 요구하므로
 * 스토어용 이미지는 이 모드로 내보낸다. 아이콘은 모서리가 투명해야 하니 RGBA 그대로.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba width*height*4 바이트, 스트레이트 알파.
 * @param {{rgb?: boolean}} [opts]
 * @returns {Buffer}
 */
function encodePng(width, height, rgba, opts = {}) {
  if (rgba.length !== width * height * 4) throw new Error('rgba 길이가 width*height*4 와 다르다');
  const channels = opts.rgb ? 3 : 4;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = opts.rgb ? 2 : 6; // 컬러 타입 2 = RGB, 6 = RGBA
  ihdr[10] = 0; // 압축: deflate
  ihdr[11] = 0; // 필터: 적응형
  ihdr[12] = 0; // 인터레이스 없음

  // 스캔라인마다 필터 바이트 0(None) 을 앞에 붙인다.
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    if (channels === 4) {
      Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, dst + 1);
    } else {
      for (let x = 0; x < width; x += 1) {
        const si = (y * width + x) * 4;
        const di = dst + 1 + x * 3;
        raw[di] = rgba[si];
        raw[di + 1] = rgba[si + 1];
        raw[di + 2] = rgba[si + 2];
      }
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 색
// ─────────────────────────────────────────────────────────────────────────────

/** '#rrggbb' 또는 '#rrggbbaa' → [r,g,b,a] (0..1). */
function hex(value, alpha = 1) {
  const s = value.replace('#', '');
  const n = (i) => parseInt(s.slice(i * 2, i * 2 + 2), 16) / 255;
  const a = s.length >= 8 ? n(3) : 1;
  return [n(0), n(1), n(2), a * alpha];
}

/** 단색 페인트. */
const solid = (rgba) => () => rgba;

/** (x0,y0)→(x1,y1) 선형 그라디언트 페인트. stops = [[t, rgba], ...] */
function linear(x0, y0, x1, y1, stops) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return (x, y) => {
    let t = ((x - x0) * dx + (y - y0) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    for (let i = 1; i < stops.length; i += 1) {
      const [t1, c1] = stops[i];
      const [t0, c0] = stops[i - 1];
      if (t <= t1 || i === stops.length - 1) {
        const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        const kk = k < 0 ? 0 : k > 1 ? 1 : k;
        return [
          c0[0] + (c1[0] - c0[0]) * kk,
          c0[1] + (c1[1] - c0[1]) * kk,
          c0[2] + (c1[2] - c0[2]) * kk,
          c0[3] + (c1[3] - c0[3]) * kk,
        ];
      }
    }
    return stops[0][1];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SDF 프리미티브 — 좌표는 전부 "최종 픽셀" 단위다.
//
// 모든 SDF 는 축 정렬 바운딩 박스 `.bounds = [x0, y0, x1, y1]` 를 달고 다닌다.
// `Canvas.fill` 이 그 상자만 훑는다(달지 않으면 캔버스 전체를 훑는다).
//
// 상자의 계약: **모양이 상자 밖으로 나가면 안 된다.** 정확히는 sdf 가 실제 거리보다
// 작은 값을 돌려주지 않는 한(정확하거나 과대평가) 기하학적 bbox 로 충분하다 —
// 상자 밖 표본은 반드시 d > softness/2 라서 어차피 건너뛰던 것들이다. 상자를
// 좁게 잡으면 결과가 조용히 잘리므로, 애매하면 넓게 잡는다.
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** 상자를 모르는(또는 못 믿을) SDF 용. fill 이 캔버스 전체를 훑는다. */
const UNBOUNDED = [-Infinity, -Infinity, Infinity, Infinity];

/** SDF 함수에 바운딩 박스를 붙인다. */
const withBounds = (bounds, fn) => Object.assign(fn, { bounds });

const sdCircle = (cx, cy, r) =>
  withBounds([cx - r, cy - r, cx + r, cy + r], (x, y) => Math.hypot(x - cx, y - cy) - r);

/** 모서리가 둥근 사각형. (cx,cy) 중심, hw/hh 반너비·반높이. */
const sdRoundRect = (cx, cy, hw, hh, r) =>
  withBounds([cx - hw, cy - hh, cx + hw, cy + hh], (x, y) => {
    const qx = Math.abs(x - cx) - (hw - r);
    const qy = Math.abs(y - cy) - (hh - r);
    const ax = qx > 0 ? qx : 0;
    const ay = qy > 0 ? qy : 0;
    const inner = Math.min(Math.max(qx, qy), 0);
    return Math.hypot(ax, ay) + inner - r;
  });

/**
 * 각도 구간이 제한된 링 = 둥근 끝을 가진 호.
 * 각도는 도(degree), 수학 관례(동쪽 0, 반시계 방향, 화면 y 는 아래로 증가하므로 뒤집는다).
 *
 * 상자는 각도를 무시한 링 전체로 잡는다. 각도 구간까지 반영한 딱 맞는 상자를
 * 만들 수도 있지만, 호가 어느 사분면을 지나는지 따지는 값만큼 잘못 잘릴 위험이
 * 늘고 아낄 수 있는 것은 링 하나 넓이의 일부뿐이다.
 */
const sdArc = (cx, cy, r, w, startDeg, endDeg) => {
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = (endDeg * Math.PI) / 180;
  const span = a1 - a0;
  const e0x = cx + r * Math.cos(a0);
  const e0y = cy - r * Math.sin(a0);
  const e1x = cx + r * Math.cos(a1);
  const e1y = cy - r * Math.sin(a1);
  const outer = r + w / 2;
  return withBounds([cx - outer, cy - outer, cx + outer, cy + outer], (x, y) => {
    let a = Math.atan2(-(y - cy), x - cx) - a0;
    a -= Math.floor(a / TAU) * TAU; // [0, TAU)
    if (a <= span) return Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
    return Math.min(Math.hypot(x - e0x, y - e0y), Math.hypot(x - e1x, y - e1y)) - w / 2;
  });
};

/** 둥근 끝 선분(캡슐). w 는 전체 두께. */
const sdSegment = (x0, y0, x1, y1, w) =>
  withBounds(
    [
      Math.min(x0, x1) - w / 2,
      Math.min(y0, y1) - w / 2,
      Math.max(x0, x1) + w / 2,
      Math.max(y0, y1) + w / 2,
    ],
    (x, y) => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)) - w / 2;
    },
  );

/** 여러 SDF 의 합집합. 상자는 상자들의 합집합. */
const sdUnion = (...fns) =>
  withBounds(
    [
      Math.min(...fns.map((f) => f.bounds[0])),
      Math.min(...fns.map((f) => f.bounds[1])),
      Math.max(...fns.map((f) => f.bounds[2])),
      Math.max(...fns.map((f) => f.bounds[3])),
    ],
    (x, y) => {
      let m = Infinity;
      for (const f of fns) {
        const d = f(x, y);
        if (d < m) m = d;
      }
      return m;
    },
  );

/** a 에서 b 를 뺀다. 결과는 a 안에만 있으므로 상자도 a 의 것. */
const sdSubtract = (a, b) => withBounds(a.bounds, (x, y) => Math.max(a(x, y), -b(x, y)));

/** a 와 b 의 교집합. 상자도 교집합 — 상자가 없는 쪽을 상자로 가두는 용도로도 쓴다. */
const sdIntersect = (a, b) =>
  withBounds(
    [
      Math.max(a.bounds[0], b.bounds[0]),
      Math.max(a.bounds[1], b.bounds[1]),
      Math.min(a.bounds[2], b.bounds[2]),
      Math.min(a.bounds[3], b.bounds[3]),
    ],
    (x, y) => Math.max(a(x, y), b(x, y)),
  );

/** 바깥으로 d 만큼 부풀린다(음수면 깎는다). */
const sdGrow = (a, d) => {
  // 깎을 때는 모양이 작아지니 상자를 그대로 둔다(줄이면 잘릴 위험만 는다).
  const pad = d > 0 ? d : 0;
  const [x0, y0, x1, y1] = a.bounds;
  return withBounds([x0 - pad, y0 - pad, x1 + pad, y1 + pad], (x, y) => a(x, y) - d);
};

// ─────────────────────────────────────────────────────────────────────────────
// 캔버스 — 4x 슈퍼샘플 버퍼 위에 그린 뒤 박스 필터로 축소한다.
// ─────────────────────────────────────────────────────────────────────────────

class Canvas {
  /**
   * @param {number} width 최종 픽셀 너비
   * @param {number} height 최종 픽셀 높이
   * @param {number} ss 슈퍼샘플 배율(기본 4 → 픽셀당 16 표본)
   */
  constructor(width, height, ss = 4) {
    this.width = width;
    this.height = height;
    this.ss = ss;
    this.sw = width * ss;
    this.sh = height * ss;
    // 스트레이트 알파 RGBA, 0..1
    this.buf = new Float64Array(this.sw * this.sh * 4);
  }

  /**
   * 슈퍼샘플 한 칸에 소스-오버 합성한다.
   *
   * @param {number} i 대상 표본의 buf 오프셋(= 표본 인덱스 * 4)
   * @param {ArrayLike<number>} src 색을 담은 배열
   * @param {number} so src 안에서 R 성분의 위치
   * @param {number} sa 소스 알파(스트레이트)
   */
  blendSample(i, src, so, sa) {
    const { buf } = this;
    const da = buf[i + 3];
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    for (let k = 0; k < 3; k += 1) {
      buf[i + k] = (src[so + k] * sa + buf[i + k] * da * (1 - sa)) / outA;
    }
    buf[i + 3] = outA;
  }

  /**
   * SDF 모양을 페인트로 채운다. 소스-오버 합성.
   * @param {(x:number,y:number)=>number} sdf 최종 픽셀 좌표에서의 부호 있는 거리
   * @param {[number,number,number,number]|((x:number,y:number)=>number[])} paint
   * @param {{softness?: number, bounds?: number[]}} [opts]
   *   softness: 경계 램프 폭(최종 픽셀 단위).
   *   bounds: 훑을 범위 [x0,y0,x1,y1]. 없으면 `sdf.bounds`, 그것도 없으면 전체.
   */
  fill(sdf, paint, opts = {}) {
    const paintFn = typeof paint === 'function' ? paint : solid(paint);
    const { ss, sw, sh } = this;
    // 램프 폭 기본값은 슈퍼샘플 한 칸. 여기에 박스 필터가 더해져 부드러워진다.
    const soft = opts.softness ?? 1 / ss;
    const half = soft / 2;
    // 모양이 닿지 않는 곳은 훑지 않는다. 상자를 램프 폭만큼 부풀리는 것은 경계
    // 바깥 half 까지가 칠해지기 때문이다. 여기서 잘려 나가는 표본은 전부 d > half
    // 라 어차피 첫 줄에서 continue 되던 것들이다 — 결과는 한 비트도 안 변한다.
    const box = opts.bounds ?? sdf.bounds;
    const [sy0, sy1] = box ? sampleRange(box[1], box[3], half, ss, sh) : [0, sh - 1];
    const [sx0, sx1] = box ? sampleRange(box[0], box[2], half, ss, sw) : [0, sw - 1];
    for (let sy = sy0; sy <= sy1; sy += 1) {
      const y = (sy + 0.5) / ss;
      for (let sx = sx0; sx <= sx1; sx += 1) {
        const x = (sx + 0.5) / ss;
        const d = sdf(x, y);
        if (d > half) continue;
        let cov = soft === 0 ? (d <= 0 ? 1 : 0) : (half - d) / soft;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        const c = paintFn(x, y);
        const sa = c[3] * cov;
        if (sa <= 0) continue;
        this.blendSample((sy * sw + sx) * 4, c, 0, sa);
      }
    }
    return this;
  }

  /** 캔버스 전체를 페인트로 덮는다(불투명 배경용). */
  fillAll(paint) {
    return this.fill(() => -1, paint, { softness: 0 });
  }

  /**
   * 다른 캔버스를 (x,y) 위치에 합성한다. 두 캔버스의 ss 는 같아야 한다.
   * 스토어 이미지 안에 아이콘을 얹을 때 쓴다.
   */
  drawCanvas(other, x, y) {
    if (other.ss !== this.ss) throw new Error('ss 가 다른 캔버스는 합성할 수 없다');
    const ox = Math.round(x * this.ss);
    const oy = Math.round(y * this.ss);
    for (let sy = 0; sy < other.sh; sy += 1) {
      const ty = sy + oy;
      if (ty < 0 || ty >= this.sh) continue;
      for (let sx = 0; sx < other.sw; sx += 1) {
        const tx = sx + ox;
        if (tx < 0 || tx >= this.sw) continue;
        const si = (sy * other.sw + sx) * 4;
        const sa = other.buf[si + 3];
        if (sa <= 0) continue;
        this.blendSample((ty * this.sw + tx) * 4, other.buf, si, sa);
      }
    }
    return this;
  }

  /**
   * 다른 캔버스를 **최종 픽셀로 축소한 뒤** 최근접 이웃으로 `scale` 배 확대해
   * (x,y) 에 찍는다. 좌표와 배율은 최종 픽셀 단위다.
   *
   * `drawCanvas` 와 나뉘어 있는 이유: 이건 "16px 아이콘이 실제로 어떻게 보이는가"
   * 를 눈으로 보려고 계단을 그대로 살려 확대하는 것이라, 원본의 슈퍼샘플 정보를
   * 쓰면 안 된다(쓰면 그냥 매끈한 큰 아이콘이 되어 볼 이유가 없다).
   *
   * 원본 픽셀 하나는 이 캔버스의 픽셀 scale×scale 을 채우고, 그 픽셀 하나는
   * 자기 슈퍼샘플 ss×ss 칸에 같은 값으로 들어간다(전부 같은 값이라 축소하면
   * 그대로 돌아온다). 그래서 이 캔버스의 ss 가 1 이 아니어도 맞다.
   */
  drawScaled(other, x, y, scale) {
    const rgba = other.toRgba();
    const { ss, sw } = this;
    const c = new Float64Array(3);
    for (let sy = 0; sy < other.height; sy += 1) {
      for (let sx = 0; sx < other.width; sx += 1) {
        const si = (sy * other.width + sx) * 4;
        const a = rgba[si + 3] / 255;
        if (a <= 0) continue;
        c[0] = rgba[si] / 255;
        c[1] = rgba[si + 1] / 255;
        c[2] = rgba[si + 2] / 255;
        for (let j = 0; j < scale; j += 1) {
          const py = y + sy * scale + j;
          if (py < 0 || py >= this.height) continue;
          for (let i = 0; i < scale; i += 1) {
            const px = x + sx * scale + i;
            if (px < 0 || px >= this.width) continue;
            for (let ty = py * ss; ty < (py + 1) * ss; ty += 1) {
              for (let tx = px * ss; tx < (px + 1) * ss; tx += 1) {
                this.blendSample((ty * sw + tx) * 4, c, 0, a);
              }
            }
          }
        }
      }
    }
    return this;
  }

  /** 슈퍼샘플 버퍼를 8비트 RGBA 로 축소한다(프리멀티플라이 후 평균). */
  toRgba() {
    const { ss, sw, width, height, buf } = this;
    const out = new Uint8Array(width * height * 4);
    const n = ss * ss;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let j = 0; j < ss; j += 1) {
          for (let i = 0; i < ss; i += 1) {
            const si = ((y * ss + j) * sw + (x * ss + i)) * 4;
            const sa = buf[si + 3];
            r += buf[si] * sa;
            g += buf[si + 1] * sa;
            b += buf[si + 2] * sa;
            a += sa;
          }
        }
        const di = (y * width + x) * 4;
        if (a <= 0) {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 0;
        } else {
          out[di] = clamp255((r / a) * 255);
          out[di + 1] = clamp255((g / a) * 255);
          out[di + 2] = clamp255((b / a) * 255);
          out[di + 3] = clamp255((a / n) * 255);
        }
      }
    }
    return out;
  }

  toPng(opts) {
    return encodePng(this.width, this.height, this.toRgba(), opts);
  }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * 최종 픽셀 구간 [lo, hi] 를 pad 만큼 넓혀 덮는 슈퍼샘플 인덱스 범위(양끝 포함).
 * 표본 중심이 (i + 0.5) / ss 이므로 i 는 (좌표 * ss − 0.5) 다. 부동소수점 경계를
 * 따지지 않으려고 양쪽에 한 칸씩 더 얹는다. 구간이 캔버스 밖이면 lo > hi 가 되어
 * 호출부 루프가 한 번도 돌지 않는다.
 *
 * @returns {[number, number]}
 */
function sampleRange(lo, hi, pad, ss, count) {
  const i0 = Math.floor((lo - pad) * ss - 0.5) - 1;
  const i1 = Math.ceil((hi + pad) * ss - 0.5) + 1;
  return [i0 < 0 ? 0 : i0, i1 > count - 1 ? count - 1 : i1];
}

// ─────────────────────────────────────────────────────────────────────────────
// 브랜드 팔레트
//
// 형태는 완전히 독자적으로 가고, 소속감은 색으로만 낸다. 두 색 모두 Claude 의 웜
// 팔레트 안이다. 같은 색의 짙은 것과 밝은 것이라 "같은 종류인데 이 하나만 앞에
// 있다"가 색만으로도 읽힌다.
//
// 실측 대비(WCAG 상대명도):
//                      밝은 툴바 #F1F3F4   어두운 툴바 #292A2D   두 색 사이
//   brick #A03D22            5.92                2.18              2.11
//   clay  #D97757            2.80                4.60
// 밝은 툴바에서는 벽돌이, 어두운 툴바에서는 터라코타가 앞장선다. 양쪽 다 두 c 가
// 남는다. 아이콘 색 하나로 두 툴바 모두에서 3.52:1 을 넘기는 건 수학적으로 불가능
// 하므로(두 배경 명도가 0.898 / 0.0263 이라 균형점이 정확히 3.52) 역할을 나눠 맡겼다.
//
// 벽돌을 더 밝게 올리지 않는 이유: clay 가 고정(Claude 터라코타)이므로 brick 을
// 올리면 두 c 사이 대비가 2.11 아래로 떨어진다. 2.11 은 16px 에서 두 c 가 하나의
// 따뜻한 얼룩으로 뭉치지 않게 버티는 하한선이다. 그래서 어두운 툴바에서의 존재감은
// 색이 아니라 획 굵기(잉크 질량)로 확보했다 — 아래 G 주석 참고.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = {
  dim: '#A03D22', // 벽돌 — 뒤로 물러난 c(나머지 프로필들)
  lit: '#D97757', // Claude 터라코타 — 앞으로 나온 c(지금 이 프로필)
  ink: '#3D2317', // 짙은 웜 먹(스토어 이미지 텍스트/테두리)
};

// ─────────────────────────────────────────────────────────────────────────────
// 마크 — "겹친 두 개의 c"
//
// 소문자 c 둘이 대각으로 물려 있다. 뒤에 물러난 것은 짙은 벽돌, 앞으로 나온 것은
// 터라코타. "프로필은 여럿이고 지금 앞에 나와 있는 건 이 하나"를 c 두 개로 말한다.
// cici 에도, Claude in Chrome Id 에도 c 가 둘이다.
//
// 방사형·별·스파클 계열은 쓰지 않는다. Claude 확장 아이콘이 그 형태라 흉내가 된다.
//
// 탈락한 방향들(전부 16px 로 실제 렌더해서 눈으로 떨어뜨렸다):
//   동심 호(지문)  — 호 사이 1px 간격이 16px 에서 회색으로 뭉개진다.
//   구멍 뚫린 태그 — 카운터가 메워져 정체불명의 덩어리가 된다.
//   점 3개         — 얼굴로 읽힌다. 지도 핀은 지도 앱, 사람 실루엣은 주소록.
//   카드 3장 스택  — 문단 정렬/목록 버튼으로 읽힌다.
//   기울인 획 2개  — 128px 에서도 일시정지 버튼이다.
//   프로필 넷 격자 — 하나만 켜 두면 뜻은 통하지만 16px 에서 점 무더기로 뭉갠다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 치수는 전부 16px 격자에서 정하고 u = size/16 을 곱한다. 큰 크기에서 비율을 정해
 * 축소하면 16px 에서 무너진다 — 반대로 잡아야 한다.
 *
 * 두 c 를 겹치는 방법 —
 *   c 는 왼쪽 보울에 살이 몰려 있고 오른쪽이 입이다. 앞 c 가 뒤 c 의 왼쪽을 물면
 *   보울이 잘려 죽고, 오른쪽 종단을 얕게 스치면 획이 칼끝처럼 빠져 c 가 아니라
 *   깨진 e 나 쉼표가 된다. 그래서 뒤 c 의 "아래 종단을 앞 c 의 음각 밖까지 끌어
 *   올린 각도"(backPull)를 수치로 풀어 두었다. 그 결과 음각은 뒤 c 의 획을 단
 *   1픽셀도 깎지 않고(검증: 깎인 면적 0.0000), 뒤 c 의 두 종단이 모두 앞 c 와
 *   똑같은 굵기의 온전한 둥근 캡으로 남는다. 겹침은 실루엣으로만 일어난다.
 *   backTilt 는 위 종단을 조금만 따라 내려 입이 한쪽으로 쏠려 보이지 않게 하는 값
 *   이다. 위 종단을 아래 종단만큼 내리면(=통째 회전) 51° 아래로 내려가 c 가 아니라
 *   e 나 a 로 읽힌다. 51° 가 위 종단이 c 자리를 지키는 하한이었다.
 *
 * 16px 에서 지킨 값:
 *   - 획 3.3, 구멍 3.7(= 2r − w). 구멍이 획보다 넓어야 c 가 o 로 읽히지 않는다.
 *   - 앞 c 의 입 2.82px, 두 c 사이 투명 간격 1.38px. 어느 것도 메워지지 않는다.
 *   - 갭은 회색 선이 아니라 투명이다. 배경이 그대로 비쳐서 밝은 툴바든 어두운
 *     툴바든 같은 폭으로 두 c 를 갈라 준다.
 *   - 글리프 bbox 가 정확히 [0,16] x [0,16] 이다. 아래 배치식이 네 변을 전부 정수
 *     격자에 맞춰 놓는다. 여백을 0.5px 만 남기면 가장자리 한 열이 알파 44% 짜리
 *     반투명 슬리버가 되어 16px 에서 뿌옇게 번진다.
 *   - 잉크 질량은 Claude 확장 아이콘(16px)의 1.06배. 어두운 툴바에서 대비 3:1 을
 *     넘는 픽셀이 52개다(Claude 는 74개). 획 2.75 에 여백 0.5 이던 초안은 35개뿐이라
 *     어두운 툴바에서 물러 보였다 — 벽돌색은 더 못 올리니 굵기로 벌었다.
 */
const G = {
  r: 3.5, // c 중심선 반지름
  w: 3.3, // 획 두께 → 바깥 지름 10.3, 구멍 3.7
  mouth: 122, // 앞 c 의 입(터진 각) → 종단이 ±61°
  backPull: 35, // 뒤 c 의 아래 종단을 음각 밖까지 끌어올리는 각
  backTilt: 10, // 뒤 c 의 위 종단을 따라 내리는 각(c 자리를 지키는 한도)
  knock: 1.3, // 앞 c 를 이만큼 부풀려 뒤 c 에서 깎아 낸다(안전망)
};

/** c 의 바깥 반지름. 네 변을 정수 격자에 붙이는 기준이 된다. */
const OUTER = G.r + G.w / 2;
/** 앞 c 의 종단 캡이 오른쪽 끝 16 에 정확히 닿는 x. */
const FRONT_X = 16 - (G.r * Math.cos((G.mouth / 2) * (Math.PI / 180)) + G.w / 2);

const MARK = {
  // 뒤 c: 보울의 서쪽·북쪽이 각각 x=0, y=0 에 닿는다.
  back: [OUTER, OUTER],
  backTop: G.mouth / 2 - G.backTilt, //  51°
  backBot: -G.mouth / 2 - G.backPull, // -96°
  // 앞 c: 종단 캡이 x=16, 보울의 남쪽이 y=16 에 닿는다.
  front: [FRONT_X, 16 - OUTER],
  frontTop: G.mouth / 2, //  61°
  frontBot: -G.mouth / 2, // -61°
};

/** 소문자 c 하나. a1(위 종단)에서 반시계로 돌아 a0(아래 종단)까지. */
const cGlyph = ([cx, cy], a1, a0, u) =>
  sdArc(cx * u, cy * u, G.r * u, G.w * u, a1, a0 + 360);

/**
 * 확장 아이콘 한 장.
 * @param {number} size
 * @param {{ss?: number}} [opts]
 */
function renderIcon(size, opts = {}) {
  const c = new Canvas(size, size, opts.ss ?? 4);
  const u = size / 16;
  const front = cGlyph(MARK.front, MARK.frontTop, MARK.frontBot, u);
  const back = cGlyph(MARK.back, MARK.backTop, MARK.backBot, u);
  // 음각은 안전망이다. 위 배치가 갭 1.38px 을 이미 보장하므로 실제로는 아무것도
  // 깎지 않는다 — 뒤 c 의 두 종단은 온전한 둥근 캡으로 남는다.
  c.fill(sdSubtract(back, sdGrow(front, G.knock * u)), hex(BRAND.dim));
  c.fill(front, hex(BRAND.lit));
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// 'cici' 워드마크 — 폰트 의존을 피하려고 기하학 도형으로 직접 그린다.
// 소문자 c = 오른쪽이 열린 호, i = 세로 막대 + 점.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Canvas} c
 * @param {number} x 왼쪽 시작 x
 * @param {number} baseY 소문자 x-height 의 아래쪽(베이스라인)
 * @param {number} h x-height
 * @param {*} paint
 * @returns {number} 그린 뒤의 오른쪽 끝 x
 */
function drawWordmarkCici(c, x, baseY, h, paint) {
  const stroke = h * 0.2;
  const r = (h - stroke) / 2;
  const gap = h * 0.17;
  let cursor = x;
  for (const ch of 'cici') {
    if (ch === 'c') {
      const cx = cursor + r + stroke / 2;
      const cy = baseY - h / 2;
      c.fill(sdArc(cx, cy, r, stroke, 48, 312), paint);
      cursor += r * 2 + stroke + gap;
    } else {
      const sx = cursor + stroke / 2;
      c.fill(sdSegment(sx, baseY - h + stroke / 2, sx, baseY - stroke / 2, stroke), paint);
      c.fill(sdCircle(sx, baseY - h - h * 0.28, stroke * 0.62), paint);
      cursor += stroke + gap;
    }
  }
  return cursor - gap;
}

// ─────────────────────────────────────────────────────────────────────────────
// 스토어 이미지
// ─────────────────────────────────────────────────────────────────────────────

/** 440x280 소형 프로모 타일. */
function renderPromoTile() {
  const W = 440;
  const H = 280;
  const c = new Canvas(W, H, 4);
  // 마크가 배경 없는 글리프라 프로모 배경은 밝게 깔고 짙은 먹색으로 글자를 쓴다.
  c.fillAll(
    linear(0, 0, W, H, [
      [0, hex('#FAF9F6')],
      [0.55, hex('#F2EEE7')],
      [1, hex('#E6DFD2')],
    ]),
  );
  // 마크 뒤 광원 + 오른쪽 위 은은한 하이라이트
  c.fill(sdCircle(112, H * 0.46, 130), hex(BRAND.dim, 0.12), { softness: 260 });
  c.fill(sdCircle(W * 0.82, H * 0.1, 150), hex('#ffffff', 0.5), { softness: 300 });

  // 아이콘
  const iconSize = 128;
  const iconX = 44;
  const iconY = (H - iconSize) / 2 - 8;
  c.drawCanvas(renderIcon(iconSize), iconX, iconY);

  // 워드마크
  const wordX = iconX + iconSize + 36;
  drawWordmarkCici(c, wordX, H * 0.47, 56, hex(BRAND.ink));

  // "여러 프로필 중 하나가 강조된" 목록 — 글자 없이 의미를 전달한다.
  const pillH = 11;
  const rowGap = 13;
  const listX = wordX + 24; // 왼쪽 24px 은 선택 표시 점 자리
  const pillY = H * 0.47 + 26;
  const rows = [
    [126, hex(BRAND.ink, 0.22), false],
    [168, hex(BRAND.lit), true],
    [104, hex(BRAND.ink, 0.22), false],
  ];
  rows.forEach(([w, paint, marked], i) => {
    const y = pillY + i * (pillH + rowGap);
    c.fill(sdRoundRect(listX + w / 2, y + pillH / 2, w / 2, pillH / 2, pillH / 2), paint);
    if (marked) c.fill(sdCircle(listX - 14, y + pillH / 2, 5.5), hex(BRAND.lit));
  });
  return c;
}

/** 1280x800 스크린샷 틀(실제 화면은 사람이 나중에 끼워 넣는다). */
function renderScreenshotFrame() {
  const W = 1280;
  const H = 800;
  const c = new Canvas(W, H, 2); // 큰 이미지라 ss=2 로 충분하다(도형이 전부 크다)
  c.fillAll(
    linear(0, 0, W, H, [
      [0, hex('#F7F5F0')],
      [1, hex('#E9E3D8')],
    ]),
  );
  // 브랜드 코너 광원
  c.fill(sdCircle(W * 0.08, H * 0.05, 420), hex(BRAND.dim, 0.16), { softness: 420 });

  // 헤더: 아이콘 + 워드마크 + 텍스트 자리(연회색 막대)
  const headX = 96;
  const headY = 74;
  c.drawCanvas(renderIcon(56, { ss: 2 }), headX, headY);
  drawWordmarkCici(c, headX + 74, headY + 42, 30, hex(BRAND.ink));

  // 헤드라인/서브헤드가 들어갈 자리
  c.fill(sdRoundRect(headX + 240, headY + 18, 200, 9, 9), hex(BRAND.ink, 0.16));
  c.fill(sdRoundRect(headX + 190, headY + 44, 150, 7, 7), hex(BRAND.ink, 0.1));

  // 스크린샷을 끼울 카드
  const cardX = 96;
  const cardY = 168;
  const cardW = W - 192;
  const cardH = 540;
  const cardCx = cardX + cardW / 2;
  const cardCy = cardY + cardH / 2;
  c.fill(sdRoundRect(cardCx, cardCy + 6, cardW / 2, cardH / 2, 20), hex(BRAND.ink, 0.12), { softness: 22 });
  c.fill(sdRoundRect(cardCx, cardCy, cardW / 2, cardH / 2, 18), hex('#FFFFFF'));

  // 카드 상단 바 + 신호등
  const barH = 44;
  c.fill(
    sdIntersect(
      sdRoundRect(cardCx, cardCy, cardW / 2, cardH / 2, 18),
      sdRoundRect(cardCx, cardY + barH / 2, cardW / 2, barH / 2, 0),
    ),
    hex('#F4F1EA'),
  );
  c.fill(sdSegment(cardX, cardY + barH, cardX + cardW, cardY + barH, 1.5), hex(BRAND.ink, 0.1));
  [0, 1, 2].forEach((i) => {
    c.fill(sdCircle(cardX + 26 + i * 22, cardY + barH / 2, 6), hex(BRAND.ink, 0.16));
  });
  // 주소 표시줄 자리
  c.fill(sdRoundRect(cardX + 140, cardY + barH / 2, 120, 9, 9), hex(BRAND.ink, 0.08));

  // 안쪽: 점선 플레이스홀더 + 이미지 아이콘
  const phX = cardX + 40;
  const phY = cardY + barH + 36;
  const phW = cardW - 80;
  const phH = cardH - barH - 76;
  c.fill(sdRoundRect(phX + phW / 2, phY + phH / 2, phW / 2, phH / 2, 14), hex(BRAND.dim, 0.05));
  dashedRoundRect(c, phX + phW / 2, phY + phH / 2, phW / 2, phH / 2, 14, 2, 14, 10, hex(BRAND.dim, 0.45));
  drawImagePlaceholderGlyph(c, phX + phW / 2, phY + phH / 2 - 18, 92, hex(BRAND.dim, 0.42));
  // 캡션 자리 막대 2줄
  c.fill(sdRoundRect(phX + phW / 2, phY + phH / 2 + 66, 150, 8, 8), hex(BRAND.dim, 0.28));
  c.fill(sdRoundRect(phX + phW / 2, phY + phH / 2 + 92, 100, 6, 6), hex(BRAND.dim, 0.2));

  // 안전 여백 가이드(모서리 표식)
  const m = 48;
  const g = hex(BRAND.ink, 0.14);
  [
    [m, m, 1, 1],
    [W - m, m, -1, 1],
    [m, H - m, 1, -1],
    [W - m, H - m, -1, -1],
  ].forEach(([x, y, sx, sy]) => {
    c.fill(sdSegment(x, y, x + 26 * sx, y, 2), g);
    c.fill(sdSegment(x, y, x, y + 26 * sy, 2), g);
  });
  return c;
}

/** 점선 둥근 사각형. 링을 각도별 조각으로 잘라 넣는 대신 둘레를 따라 캡슐을 찍는다. */
function dashedRoundRect(c, cx, cy, hw, hh, r, w, dash, gapLen, paint) {
  const seg = dash + gapLen;
  // 직선 4개
  const straight = [
    [cx - hw + r, cy - hh, cx + hw - r, cy - hh],
    [cx + hw, cy - hh + r, cx + hw, cy + hh - r],
    [cx + hw - r, cy + hh, cx - hw + r, cy + hh],
    [cx - hw, cy + hh - r, cx - hw, cy - hh + r],
  ];
  for (const [x0, y0, x1, y1] of straight) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t + dash <= len; t += seg) {
      const a = t / len;
      const b = (t + dash) / len;
      c.fill(
        sdSegment(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, w),
        paint,
      );
    }
  }
  // 모서리 호 4개
  const corners = [
    [cx + hw - r, cy - hh + r, 0],
    [cx + hw - r, cy + hh - r, 270],
    [cx - hw + r, cy + hh - r, 180],
    [cx - hw + r, cy - hh + r, 90],
  ];
  for (const [ax, ay, start] of corners) {
    c.fill(sdArc(ax, ay, r, w, start, start + 90), paint);
  }
}

/** 사진 플레이스홀더 글리프(산 + 해). 글자 없이 "여기에 이미지"를 뜻한다. */
function drawImagePlaceholderGlyph(c, cx, cy, size, paint) {
  const hw = size / 2;
  const hh = (size * 0.78) / 2;
  const frame = sdSubtract(
    sdRoundRect(cx, cy, hw, hh, 10),
    sdRoundRect(cx, cy, hw - 5, hh - 5, 6),
  );
  c.fill(frame, paint);
  c.fill(sdCircle(cx - hw * 0.42, cy - hh * 0.38, 6), paint);
  // 산 두 개
  const base = cy + hh - 12;
  c.fill(
    sdIntersect(
      sdUnion(
        sdTriangleish(cx - hw * 0.18, base, 26, 22),
        sdTriangleish(cx + hw * 0.32, base, 20, 16),
      ),
      sdRoundRect(cx, cy, hw - 6, hh - 6, 6),
    ),
    paint,
  );
}

/**
 * 밑변이 y0 인 이등변 삼각형 비슷한 모양.
 *
 * "비슷한"에 방점이 있다. 밑변 아래에서는 x 를 무시하고 `y - y0` 을, 꼭짓점 위에서는
 * 거리가 아니라 비율 `t - 1` 을 돌려준다 — 둘 다 실제 거리보다 **작다**. 그래서
 * 삼각형 밖 먼 곳까지 옅게 번지고, 지금 나오는 그림이 그 번짐까지 포함한 결과다.
 * 상자를 씌우면 그 부분이 잘려 그림이 바뀌므로 상자를 주지 않는다. 대신 호출부가
 * `sdIntersect` 로 가둬 두었고, 훑는 범위는 거기서 좁혀진다.
 */
const sdTriangleish = (cx, y0, halfBase, height) =>
  withBounds(UNBOUNDED, (x, y) => {
    if (y > y0) return y - y0;
    const t = (y0 - y) / height;
    if (t > 1) return t - 1;
    const w = halfBase * (1 - t);
    return Math.abs(x - cx) - w;
  });

// ─────────────────────────────────────────────────────────────────────────────
// 육안 확인용 대조 시트
// ─────────────────────────────────────────────────────────────────────────────

/** 밝은/어두운 툴바 배경 위에 1x 와 확대본을 나란히 놓는다. */
function renderPreview() {
  const sizes = [16, 32, 48, 128];
  const W = 640;
  const H = 360;
  const c = new Canvas(W, H, 1);
  c.fillAll(hex('#FFFFFF'));
  c.fill(sdRoundRect(W / 2, H * 0.25, W / 2, H * 0.25, 0), hex('#F1F3F4')); // 밝은 툴바
  c.fill(sdRoundRect(W / 2, H * 0.75, W / 2, H * 0.25, 0), hex('#292A2D')); // 어두운 툴바

  const icons = sizes.map((s) => ({ size: s, canvas: renderIcon(s, { ss: 4 }) }));
  for (const row of [0, 1]) {
    const yMid = row === 0 ? H * 0.25 : H * 0.75;
    let x = 24;
    // 원본 크기
    for (const { size, canvas } of icons) {
      c.drawScaled(canvas, x, Math.round(yMid - size / 2), 1);
      x += size + 20;
    }
    // 16px 과 32px 을 최근접 확대 — 16px 에서 형태가 남는지 보려는 것
    x += 16;
    c.drawScaled(icons[0].canvas, x, Math.round(yMid - 64), 8);
    x += 128 + 20;
    c.drawScaled(icons[1].canvas, x, Math.round(yMid - 64), 4);
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔트리 포인트
// ─────────────────────────────────────────────────────────────────────────────

function writePng(path, canvas, opts) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canvas.toPng(opts));
  return path;
}

function parseArgs(argv) {
  const out = { out: join(REPO_ROOT, 'extension', 'icons'), store: null, preview: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = resolve(argv[++i]);
    else if (a === '--store') out.store = resolve(argv[++i]);
    else if (a === '--preview') out.preview = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'node scripts/make-icons.mjs [--out dir] [--store dir] [--preview dir]\n',
    );
    return;
  }
  const written = [];
  for (const size of [16, 32, 48, 128]) {
    written.push(writePng(join(args.out, `icon${size}.png`), renderIcon(size)));
  }
  if (args.store) {
    written.push(writePng(join(args.store, 'promo-440x280.png'), renderPromoTile(), { rgb: true }));
    written.push(writePng(join(args.store, 'screenshot-1280x800.png'), renderScreenshotFrame(), { rgb: true }));
  }
  if (args.preview) {
    written.push(writePng(join(args.preview, 'preview.png'), renderPreview()));
  }
  for (const p of written) process.stdout.write(`${p}\n`);
}

// 라이브러리가 아니라 CLI 다. 내보내는 것이 없다 — 저장소 어디에서도 이 모듈을
// import 하지 않으므로, 쓰이지 않는 export 를 두면 "누가 쓰는지" 를 매번 확인해야
// 한다. 렌더러를 밖에서 쓰고 싶어지면 그때 골라서 내보내면 된다.
if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2));
}
