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
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// PNG 인코더
// ─────────────────────────────────────────────────────────────────────────────

/** CRC-32 (PNG 사양 Annex D) 테이블. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 타입 + 데이터를 길이/CRC 로 감싼 PNG 청크 하나로 만든다. */
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
export function encodePng(width, height, rgba, opts = {}) {
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
export function hex(value, alpha = 1) {
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
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

/** 모서리가 둥근 사각형. (cx,cy) 중심, hw/hh 반너비·반높이. */
const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;
  const inner = Math.min(Math.max(qx, qy), 0);
  return Math.hypot(ax, ay) + inner - r;
};

/**
 * 각도 구간이 제한된 링 = 둥근 끝을 가진 호.
 * 각도는 도(degree), 수학 관례(동쪽 0, 반시계 방향, 화면 y 는 아래로 증가하므로 뒤집는다).
 */
const sdArc = (cx, cy, r, w, startDeg, endDeg) => {
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = (endDeg * Math.PI) / 180;
  const span = a1 - a0;
  const e0x = cx + r * Math.cos(a0);
  const e0y = cy - r * Math.sin(a0);
  const e1x = cx + r * Math.cos(a1);
  const e1y = cy - r * Math.sin(a1);
  return (x, y) => {
    let a = Math.atan2(-(y - cy), x - cx) - a0;
    a -= Math.floor(a / TAU) * TAU; // [0, TAU)
    if (a <= span) return Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
    return Math.min(Math.hypot(x - e0x, y - e0y), Math.hypot(x - e1x, y - e1y)) - w / 2;
  };
};

/** 둥근 끝 선분(캡슐). w 는 전체 두께. */
const sdSegment = (x0, y0, x1, y1, w) => (x, y) => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)) - w / 2;
};

/** 여러 SDF 의 합집합. */
const sdUnion = (...fns) => (x, y) => {
  let m = Infinity;
  for (const f of fns) {
    const d = f(x, y);
    if (d < m) m = d;
  }
  return m;
};

/** a 에서 b 를 뺀다. */
const sdSubtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));

/** a 와 b 의 교집합. */
const sdIntersect = (a, b) => (x, y) => Math.max(a(x, y), b(x, y));

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
   * SDF 모양을 페인트로 채운다. 소스-오버 합성.
   * @param {(x:number,y:number)=>number} sdf 최종 픽셀 좌표에서의 부호 있는 거리
   * @param {[number,number,number,number]|((x:number,y:number)=>number[])} paint
   * @param {{softness?: number}} [opts] softness: 경계 램프 폭(최종 픽셀 단위)
   */
  fill(sdf, paint, opts = {}) {
    const paintFn = typeof paint === 'function' ? paint : solid(paint);
    const { ss, sw, sh, buf } = this;
    // 램프 폭 기본값은 슈퍼샘플 한 칸. 여기에 박스 필터가 더해져 부드러워진다.
    const soft = opts.softness ?? 1 / ss;
    const half = soft / 2;
    for (let sy = 0; sy < sh; sy += 1) {
      const y = (sy + 0.5) / ss;
      for (let sx = 0; sx < sw; sx += 1) {
        const x = (sx + 0.5) / ss;
        const d = sdf(x, y);
        if (d > half) continue;
        let cov = soft === 0 ? (d <= 0 ? 1 : 0) : (half - d) / soft;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        const c = paintFn(x, y);
        const sa = c[3] * cov;
        if (sa <= 0) continue;
        const i = (sy * sw + sx) * 4;
        const da = buf[i + 3];
        const outA = sa + da * (1 - sa);
        if (outA <= 0) continue;
        for (let k = 0; k < 3; k += 1) {
          buf[i + k] = (c[k] * sa + buf[i + k] * da * (1 - sa)) / outA;
        }
        buf[i + 3] = outA;
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
        const di = (ty * this.sw + tx) * 4;
        const da = this.buf[di + 3];
        const outA = sa + da * (1 - sa);
        for (let k = 0; k < 3; k += 1) {
          this.buf[di + k] = (other.buf[si + k] * sa + this.buf[di + k] * da * (1 - sa)) / outA;
        }
        this.buf[di + 3] = outA;
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

// ─────────────────────────────────────────────────────────────────────────────
// 브랜드 팔레트
//
// Claude 브랜드(주황 계열)도, 크롬 기본 4색도 아닌 축: 청록 × 로즈.
// 두 색의 명도를 일부러 어긋나게 잡았다. 아이콘 색 하나로 밝은 툴바와 어두운
// 툴바 양쪽에서 3.52:1 을 넘기는 건 수학적으로 불가능하다(두 배경의 명도가
// 0.898 / 0.0263 이라 균형점이 정확히 3.52). 그래서 밝은 툴바에서는 청록이,
// 어두운 툴바에서는 로즈가 각각 앞장서게 나눠 맡겼다.
//
// 실측 대비(WCAG 상대명도):
//                   밝은 툴바 #f1f3f4   어두운 툴바 #292a2d
//   dim  #0C8285          4.15                3.11
//   lit  #EC3F87          3.35                3.85
// 어느 툴바에서도 모든 요소가 3.1 이상이고, 최대 대비는 4.15 / 3.85 다.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = {
  dim: '#0C8285', // 청록 — 꺼져 있는 프로필 셋
  lit: '#EC3F87', // 로즈 — 지금 켜져 있는 이 프로필 하나
  ink: '#0A2124', // 짙은 청록먹(스토어 이미지 텍스트/테두리)
};

// ─────────────────────────────────────────────────────────────────────────────
// 마크 — "켜진 하나"
//
// 프로필 넷을 격자에 놓고 지금 이 프로필만 켜 둔다. 꺼진 셋은 같은 크기·같은 색의
// 둥근 사각, 켜진 하나는 형태(사각→원)·색(청록→로즈)·크기(5→7)가 동시에 달라진다.
// 세 축이 한꺼번에 바뀌니 16px 로 줄여도 "여럿 중 이것 하나"가 남는다.
//
// 배경 타일(둥근 사각형)은 쓰지 않는다. 타일은 어느 툴바에서나 안전하지만 크롬
// 확장 아이콘 대부분이 그렇게 생겨서 옆 아이콘 사이에서 구별되지 않는다. 대신 두
// 색 모두 밝은/어두운 툴바에서 3.1:1 이상 나오게 잡았다(BRAND 주석).
//
// 탈락한 방향들(전부 16px 로 실제 렌더해서 눈으로 떨어뜨렸다):
//   동심 호(지문)  — 호 사이 1px 간격이 16px 에서 회색으로 뭉개진다.
//   구멍 뚫린 태그 — 카운터가 메워져 정체불명의 덩어리가 된다.
//   점 3개         — 얼굴로 읽힌다. 지도 핀은 지도 앱, 사람 실루엣은 주소록.
//   카드 3장 스택  — 문단 정렬/목록 버튼으로 읽힌다.
//   기울인 획 2개  — 128px 에서도 일시정지 버튼이다.
//   그라디언트 타일+흰 'C' — 작은 크기에서 색이 탁하고 흔한 앱 아이콘 실루엣이다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 치수는 전부 16px 격자에서 정하고 u = size/16 을 곱한다. 16px 에서 정수에
 * 떨어지므로 32/48/128 도 자동으로 정수·반정수에 떨어져 어느 크기에서나 또렷하다.
 * 큰 크기에서 비율을 정하고 축소하면 16px 에서 무너진다 — 반대로 잡아야 한다.
 *
 *        0   1       6  7  8      13 14 15
 *        ┌───┬────────┬──┬─────────┬──────┐
 *   꺼진 사각 5x5  : 중심 3.5 / 10.5, 반너비 2.5 → [1,6] 과 [8,13]
 *   켜진 원 지름 7 : 중심 (11.5, 11.5), 반지름 3.5 → [8,15]
 *
 * 지켜야 하는 값 셋:
 *   - 요소 사이 간격이 전부 정확히 2px(6→8). 1px 간격은 16px 에서 회색으로 뭉개진다.
 *   - 글리프 bbox 가 [1,15] 라 상하좌우 여백이 1px 로 같다. 툴바에서 쏠려 보이지 않는다.
 *   - 원 지름 7 = 사각 변 5 + 간격 2, 그리고 사각 대각선 5√2 ≈ 7.07 에 가깝다.
 *     켜진 칸이 자기 칸을 넘어선 게 정렬 실수가 아니라 규칙으로 읽히게 하는 치수다.
 */
const G = {
  half: 2.5, // 꺼진 사각의 반너비
  radius: 1.25, // 그 모서리 반경(변의 25%)
  near: 3.5, // 가까운 쪽 칸 중심
  far: 10.5, // 먼 쪽 칸 중심
  litAt: 11.5, // 켜진 원의 중심
  litR: 3.5, // 켜진 원의 반지름
};

/**
 * 확장 아이콘 한 장.
 * @param {number} size
 * @param {{ss?: number}} [opts]
 */
export function renderIcon(size, opts = {}) {
  const c = new Canvas(size, size, opts.ss ?? 4);
  const u = size / 16;
  const cell = (x, y) => sdRoundRect(x * u, y * u, G.half * u, G.half * u, G.radius * u);
  for (const [x, y] of [
    [G.near, G.near],
    [G.far, G.near],
    [G.near, G.far],
  ]) {
    c.fill(cell(x, y), hex(BRAND.dim));
  }
  c.fill(sdCircle(G.litAt * u, G.litAt * u, G.litR * u), hex(BRAND.lit));
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
      [0, hex('#F6FAFA')],
      [0.55, hex('#E7F1F1')],
      [1, hex('#D3E5E6')],
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
      [0, hex('#F0F7F7')],
      [1, hex('#D9E9EA')],
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
    hex('#EFF5F5'),
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

/** 밑변이 y0 인 이등변 삼각형 비슷한 모양. */
const sdTriangleish = (cx, y0, halfBase, height) => (x, y) => {
  if (y > y0) return y - y0;
  const t = (y0 - y) / height;
  if (t > 1) return t - 1;
  const w = halfBase * (1 - t);
  return Math.abs(x - cx) - w;
};

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
      blitRgba(c, canvas, x, Math.round(yMid - size / 2), 1);
      x += size + 20;
    }
    // 16px 과 32px 을 최근접 확대 — 16px 에서 형태가 남는지 보려는 것
    x += 16;
    blitRgba(c, icons[0].canvas, x, Math.round(yMid - 64), 8);
    x += 128 + 20;
    blitRgba(c, icons[1].canvas, x, Math.round(yMid - 64), 4);
  }
  return c;
}

/** 완성된 캔버스를 최근접 이웃으로 확대해 다른 캔버스에 찍는다(1x 캔버스 전용). */
function blitRgba(dst, src, x, y, scale) {
  const rgba = src.toRgba();
  for (let sy = 0; sy < src.height; sy += 1) {
    for (let sx = 0; sx < src.width; sx += 1) {
      const si = (sy * src.width + sx) * 4;
      const a = rgba[si + 3] / 255;
      if (a <= 0) continue;
      for (let j = 0; j < scale; j += 1) {
        for (let i = 0; i < scale; i += 1) {
          const tx = x + sx * scale + i;
          const ty = y + sy * scale + j;
          if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
          const di = (ty * dst.sw * 1 + tx) * 4; // dst.ss === 1 전제
          const da = dst.buf[di + 3];
          const outA = a + da * (1 - a);
          for (let k = 0; k < 3; k += 1) {
            dst.buf[di + k] = ((rgba[si + k] / 255) * a + dst.buf[di + k] * da * (1 - a)) / outA;
          }
          dst.buf[di + 3] = outA;
        }
      }
    }
  }
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
  const out = { out: join(REPO, 'extension', 'icons'), store: null, preview: null };
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

// 심볼릭 링크를 지나는 절대 경로로 불러도 돌아야 한다. ESM 로더는 진입점을
// realpath 로 풀어서 import.meta.url 을 만들지만 resolve() 는 링크를 안 푼다
// (macOS 의 /tmp 가 바로 그런 링크다). scripts/build-extension.mjs 와 같은 이유.
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main(process.argv.slice(2));
}

export { Canvas, renderIcon as icon, renderPromoTile, renderScreenshotFrame, renderPreview, BRAND };
