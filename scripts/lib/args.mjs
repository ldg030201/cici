/**
 * `--flag 값` 형태의 인자를 하나 읽는다.
 *
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string|null} 플래그가 없거나 뒤에 값이 없으면 null
 */
export function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
