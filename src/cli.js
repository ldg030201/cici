/**
 * Command-line front end for cici.
 *
 * Only argument parsing and output formatting live here; the scan itself is
 * imported lazily inside {@link main} so that this module (and its tests) can
 * load without the LevelDB / browser modules.
 *
 * @module cici/cli
 */
import { readFileSync } from 'node:fs';

/** @typedef {import('./index.js').Row} Row */

/**
 * @typedef {object} ParsedArgs
 * @property {boolean} json
 * @property {boolean} all
 * @property {string[]} userDataDirs
 * @property {string[]} extensionIds
 * @property {boolean} color        false when --no-color was given
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} quiet
 * @property {string[]} errors      usage errors; empty when the arguments are valid
 */

/**
 * @typedef {object} Io
 * @property {(s: string) => void} stdout
 * @property {(s: string) => void} stderr
 * @property {boolean} [isTTY]      whether stdout is a terminal (defaults to process.stdout.isTTY)
 * @property {Record<string, string|undefined>} [env]  environment (defaults to process.env)
 */

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Parse CLI arguments. Never throws; problems are collected in `errors`.
 *
 * @param {string[]} argv arguments without the node binary and script path
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const result = {
    json: false,
    all: false,
    userDataDirs: [],
    extensionIds: [],
    color: true,
    help: false,
    version: false,
    quiet: false,
    errors: [],
  };
  const args = Array.isArray(argv) ? argv.map(String) : [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name = arg;
    /** @type {string|undefined} */
    let inlineValue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        name = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
    }

    /** @returns {string|null} */
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      if (i + 1 < args.length) return args[++i];
      result.errors.push(`${name} requires a value`);
      return null;
    };
    /** @returns {boolean} */
    const flagOnly = () => {
      if (inlineValue === undefined) return true;
      result.errors.push(`${name} does not take a value`);
      return false;
    };

    switch (name) {
      case '--json':
        if (flagOnly()) result.json = true;
        break;
      case '--all':
        if (flagOnly()) result.all = true;
        break;
      case '--no-color':
        if (flagOnly()) result.color = false;
        break;
      case '--quiet':
      case '-q':
        if (flagOnly()) result.quiet = true;
        break;
      case '--help':
      case '-h':
        if (flagOnly()) result.help = true;
        break;
      case '--version':
      case '-v':
        if (flagOnly()) result.version = true;
        break;
      case '--user-data-dir': {
        const value = takeValue();
        if (value === null) break;
        if (value === '') result.errors.push('--user-data-dir requires a non-empty directory');
        else result.userDataDirs.push(value);
        break;
      }
      case '--ext-id': {
        const value = takeValue();
        if (value === null) break;
        if (!EXTENSION_ID_RE.test(value)) {
          result.errors.push(`invalid extension id "${value}" (expected 32 letters a-p)`);
        } else {
          result.extensionIds.push(value);
        }
        break;
      }
      default:
        if (arg.startsWith('-') && arg.length > 1) result.errors.push(`unknown option: ${arg}`);
        else result.errors.push(`unexpected argument: ${arg}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Display width (a small wcwidth)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Remove ANSI SGR escape sequences.
 *
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/**
 * Code points that take no terminal cell: combining marks, format controls,
 * variation selectors, Hangul medial/final jamo (drawn inside the preceding
 * syllable). Sorted, inclusive ranges.
 *
 * @type {Array<[number, number]>}
 */
const ZERO_WIDTH = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2],
  [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670],
  [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0900, 0x0902],
  [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0957],
  [0x0962, 0x0963], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1160, 0x11ff],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064],
  [0x20d0, 0x20ff], [0x302a, 0x302d], [0x3099, 0x309a], [0xd7b0, 0xd7ff], [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];

/**
 * East Asian Wide / Fullwidth code points (two terminal cells): CJK, Hangul
 * syllables, fullwidth forms, and the common wide emoji. Sorted, inclusive.
 *
 * @type {Array<[number, number]>}
 */
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
  [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/**
 * @param {number} cp
 * @param {Array<[number, number]>} ranges sorted, non-overlapping
 * @returns {boolean}
 */
function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Terminal cells used by one code point (0, 1 or 2).
 *
 * @param {number} cp
 * @returns {number}
 */
export function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/**
 * Terminal cells used by a string (ANSI escapes ignored, CJK counted as 2).
 *
 * @param {string} s
 * @returns {number}
 */
export function displayWidth(s) {
  let width = 0;
  for (const ch of stripAnsi(s)) width += charWidth(ch.codePointAt(0));
  return width;
}

// ---------------------------------------------------------------------------
// Table output
// ---------------------------------------------------------------------------

const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

/** @type {Record<string, string>} */
const STYLE_CODES = {
  plain: '',
  header: SGR.bold,
  id: SGR.bold + SGR.cyan,
  muted: SGR.dim,
};

const HEADERS = ['Browser', 'Profile', 'Name', 'Email', 'Paired name', 'bridgeDeviceId', 'Ext'];
const NOT_PAIRED = 'not paired';
const NOT_INSTALLED = 'not installed';
const NO_PROFILES = '(no profiles found)';
const LEGEND =
  'bridgeDeviceId is the id Claude Code shows in its browser picker when more than one browser is connected.';

/**
 * @param {string} text
 * @param {string} style key of STYLE_CODES
 * @param {boolean} color
 * @returns {string}
 */
function paint(text, style, color) {
  const code = STYLE_CODES[style] || '';
  if (!color || !code || text === '') return text;
  return code + text + SGR.reset;
}

/**
 * @param {string|null|undefined} value
 * @returns {string}
 */
function orDash(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

/**
 * @param {Row} row
 * @returns {Array<{ text: string, style: string }>}
 */
function rowCells(row) {
  const installed = row.extensionId !== null && row.extensionId !== undefined;
  /** @type {{ text: string, style: string }} */
  let idCell;
  if (row.deviceId) idCell = { text: String(row.deviceId), style: 'id' };
  else if (installed) idCell = { text: NOT_PAIRED, style: 'muted' };
  else idCell = { text: NOT_INSTALLED, style: 'muted' };

  return [
    { text: orDash(row.browserName), style: 'plain' },
    { text: orDash(row.profileDirName), style: 'plain' },
    { text: orDash(row.profileName), style: 'plain' },
    { text: orDash(row.email), style: 'plain' },
    { text: orDash(row.displayName), style: 'plain' },
    idCell,
    { text: orDash(row.extensionVersion), style: 'plain' },
  ];
}

/**
 * @param {Array<{ text: string, style: string }>} cells
 * @param {number[]} widths
 * @param {boolean} color
 * @returns {string}
 */
function renderLine(cells, widths, color) {
  const parts = cells.map((cell, i) => {
    const padding = ' '.repeat(Math.max(0, widths[i] - displayWidth(cell.text)));
    return paint(cell.text, cell.style, color) + padding;
  });
  return parts.join('  ').trimEnd();
}

/**
 * Render rows as a human-readable table followed by a one-line legend.
 *
 * @param {Row[]} rows
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
export function formatTable(rows, options = {}) {
  const color = Boolean(options.color);
  const body = (Array.isArray(rows) ? rows : []).map(rowCells);
  const widths = HEADERS.map((header, i) =>
    Math.max(displayWidth(header), ...body.map((cells) => displayWidth(cells[i].text))),
  );

  const lines = [];
  lines.push(renderLine(HEADERS.map((text) => ({ text, style: 'header' })), widths, color));
  lines.push(renderLine(widths.map((w) => ({ text: '-'.repeat(w), style: 'muted' })), widths, color));
  if (body.length === 0) lines.push(paint(NO_PROFILES, 'muted', color));
  for (const cells of body) lines.push(renderLine(cells, widths, color));
  lines.push('');
  lines.push(paint(LEGEND, 'muted', color));
  return lines.join('\n') + '\n';
}

/**
 * @param {Row[]} rows
 * @returns {string}
 */
export function formatJson(rows) {
  return JSON.stringify(rows, null, 2);
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

/**
 * @returns {string}
 */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * @returns {string}
 */
export function helpText() {
  return [
    'cici - Claude In Chrome Id',
    '',
    "Finds the Claude in Chrome extension's bridgeDeviceId for every Chromium",
    'browser profile on this machine. That UUID is the id Claude Code shows in',
    'its browser picker when more than one browser is connected. The value is',
    "read directly from each profile's extension storage on disk; the browser",
    'is never touched and nothing is written.',
    '',
    'Usage:',
    '  cici [options]',
    '',
    'Options:',
    '  --json                 Print rows as JSON instead of a table',
    '  --all                  Include profiles where the extension is not installed',
    '  --user-data-dir <dir>  Scan this browser user-data directory (repeatable);',
    '                         disables auto-discovery of installed browsers',
    '  --ext-id <id>          Extension id to look for (repeatable); defaults to the',
    '                         known Claude in Chrome ids',
    '  --no-color             Disable ANSI colors (NO_COLOR is honored as well)',
    '  -q, --quiet            Suppress warnings on stderr',
    '  -h, --help             Show this help',
    '  -v, --version          Print the version',
    '',
    'Exit codes:',
    '  0  at least one bridgeDeviceId was found',
    '  1  no bridgeDeviceId was found',
    '  2  usage error',
    '',
    'Examples:',
    '  cici',
    "  cici --json | jq '.[] | select(.deviceId) | {profileName, deviceId}'",
    '  cici --user-data-dir "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Decide whether to emit ANSI colors: never after --no-color or with NO_COLOR
 * set, always with FORCE_COLOR set, otherwise only when stdout is a TTY.
 *
 * @param {ParsedArgs} args
 * @param {Partial<Io>} [io]
 * @returns {boolean}
 */
export function resolveColor(args, io = {}) {
  if (!args.color) return false;
  const env = io.env ?? process.env;
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  if (typeof env.FORCE_COLOR === 'string' && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return io.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
}

/**
 * Explain, on stderr, where cici looked when no bridgeDeviceId was found.
 *
 * @param {import('./index.js').ScanReport} report
 * @param {ParsedArgs} args
 * @returns {string}
 */
function noResultHint(report, args) {
  const lines = ['cici: no bridgeDeviceId found.'];
  const searched = Array.isArray(report.searched) ? report.searched : [];
  const existing = searched.filter((s) => s.exists);
  const custom = args.userDataDirs.length > 0;

  const describe = (s) => {
    if (!s.exists) return `  ${s.browserName}: ${s.userDataDir} (not found)`;
    const n = s.profileCount;
    return `  ${s.browserName}: ${s.userDataDir} (${n} profile${n === 1 ? '' : 's'})`;
  };

  if (custom) {
    lines.push('Searched user-data directories:');
    for (const s of searched) lines.push(describe(s));
  } else if (existing.length > 0) {
    lines.push('Searched user-data directories:');
    for (const s of existing) lines.push(describe(s));
  } else {
    lines.push('No Chromium browser user-data directory exists at the well-known locations:');
    for (const s of searched) lines.push(describe(s));
  }

  lines.push('Hints:');
  lines.push(
    '  - bridgeDeviceId only exists after the Claude in Chrome extension has been paired',
    '    with Claude Code at least once (run /chrome in Claude Code).',
  );
  lines.push('  - Pass --user-data-dir <dir> to scan a browser that lives somewhere else.');
  if (!args.all) lines.push('  - Pass --all to also list profiles where the extension is not installed.');
  return lines.join('\n') + '\n';
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv arguments without the node binary and script path
 * @param {Io} io
 * @returns {Promise<number>} exit code: 0 found, 1 nothing found, 2 usage error
 */
export async function main(argv, io) {
  const stdout = io && typeof io.stdout === 'function' ? io.stdout : (s) => process.stdout.write(s);
  const stderr = io && typeof io.stderr === 'function' ? io.stderr : (s) => process.stderr.write(s);

  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const e of args.errors) stderr(`cici: ${e}\n`);
    stderr("Try 'cici --help' for usage.\n");
    return 2;
  }
  if (args.help) {
    stdout(helpText());
    return 0;
  }
  if (args.version) {
    stdout(`${packageVersion()}\n`);
    return 0;
  }

  // Loaded lazily so parsing/formatting stay usable without the scanner modules.
  const { scanReport } = await import('./index.js');

  let report;
  try {
    report = await scanReport({
      userDataDirs: args.userDataDirs,
      extensionIds: args.extensionIds,
      includeUninstalled: args.all,
    });
  } catch (err) {
    stderr(`cici: ${errorMessage(err)}\n`);
    return 1;
  }

  const rows = Array.isArray(report.rows) ? report.rows : [];

  if (!args.quiet) {
    for (const w of report.warnings ?? []) stderr(`cici: warning: ${w}\n`);
    for (const row of rows) {
      for (const w of row.warnings ?? []) {
        stderr(`cici: warning: ${row.browserName}/${row.profileDirName}: ${w}\n`);
      }
    }
  }

  if (args.json) stdout(`${formatJson(rows)}\n`);
  else stdout(formatTable(rows, { color: resolveColor(args, io) }));

  if (rows.some((row) => Boolean(row.deviceId))) return 0;
  stderr(noResultHint(report, args));
  return 1;
}
