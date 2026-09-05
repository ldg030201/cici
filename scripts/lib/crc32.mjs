/**
 * CRC-32 (IEEE 802.3, 반사된 다항식 0xedb88320).
 *
 * ZIP 의 로컬/중앙 디렉터리 헤더와 PNG 의 청크 트레일러가 **같은** CRC-32 를 쓴다.
 * 그래서 pack-extension.mjs 와 make-icons.mjs 가 이 한 벌을 나눠 쓴다.
 *
 * 직접 만드는 이유: `zlib.crc32` 는 Node 20.15+ 인데 package.json 의 engines 는
 * 18.17 이다. 런타임 의존성 0개라는 약속도 있다.
 *
 * ⚠️ `src/leveldb-core.js` 와 `test/helpers/leveldb-writer.js` 의 CRC32**C**
 * (Castagnoli, 다항식 0x82f63b78) 와는 **다른 것**이다. 이름이 한 글자 차이일 뿐
 * 결과값이 전혀 다르므로 "중복이네" 하고 합치면 LevelDB 로그가 통째로 깨진다.
 * 저쪽은 LevelDB 가 정한 포맷이고, 이쪽은 ZIP/PNG 가 정한 포맷이다.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number} 부호 없는 32비트
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
