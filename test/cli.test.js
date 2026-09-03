// Tests for src/cli.js. Deliberately does NOT import src/index.js so the suite
// runs even when the scanner modules are missing: cli.js loads them lazily.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  formatTable,
  formatJson,
  helpText,
  main,
  displayWidth,
  stripAnsi,
  resolveColor,
  packageVersion,
} from '../src/cli.js';

const EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ANSI = /\x1b\[[0-9;]*m/;

/** @returns {import('../src/index.js').Row} */
function row(overrides = {}) {
  return {
    browser: 'chrome',
    browserName: 'Chrome',
    userDataDir: '/home/u/.config/google-chrome',
    profileDir: '/home/u/.config/google-chrome/Default',
    profileDirName: 'Default',
    profileName: 'John',
    email: 'john@example.com',
    gaiaName: 'John Doe',
    extensionId: EXT_ID,
    extensionVersion: '1.0.90',
    deviceId: UUID,
    displayName: 'Work laptop',
    warnings: [],
    ...overrides,
  };
}

function captureIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...extra },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('parseArgs', () => {
  test('defaults', () => {
    assert.deepEqual(parseArgs([]), {
      json: false,
      all: false,
      userDataDirs: [],
      extensionIds: [],
      color: true,
      help: false,
      version: false,
      quiet: false,
      errors: [],
    });
  });

  test('tolerates a missing argv', () => {
    assert.deepEqual(parseArgs(undefined).errors, []);
  });

  test('boolean flags', () => {
    assert.equal(parseArgs(['--json']).json, true);
    assert.equal(parseArgs(['--all']).all, true);
    assert.equal(parseArgs(['--no-color']).color, false);
    assert.equal(parseArgs(['--quiet']).quiet, true);
    assert.equal(parseArgs(['-q']).quiet, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  test('all flags together', () => {
    const args = parseArgs(['--json', '--all', '--no-color', '-q', '--user-data-dir', '/a', '--ext-id', EXT_ID]);
    assert.equal(args.json, true);
    assert.equal(args.all, true);
    assert.equal(args.color, false);
    assert.equal(args.quiet, true);
    assert.deepEqual(args.userDataDirs, ['/a']);
    assert.deepEqual(args.extensionIds, [EXT_ID]);
    assert.deepEqual(args.errors, []);
  });

  test('--user-data-dir is repeatable and accepts --flag=value', () => {
    const args = parseArgs(['--user-data-dir', '/a/b', '--user-data-dir=/c d/e', '--user-data-dir', 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data']);
    assert.deepEqual(args.userDataDirs, ['/a/b', '/c d/e', 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data']);
    assert.deepEqual(args.errors, []);
  });

  test('--user-data-dir value containing "=" keeps everything after the first "="', () => {
    const args = parseArgs(['--user-data-dir=/tmp/a=b']);
    assert.deepEqual(args.userDataDirs, ['/tmp/a=b']);
  });

  test('--ext-id is repeatable and accepts --flag=value', () => {
    const other = 'dihbgbndebgnbjfmelmegjepbnkhlgni';
    const args = parseArgs(['--ext-id', EXT_ID, `--ext-id=${other}`]);
    assert.deepEqual(args.extensionIds, [EXT_ID, other]);
    assert.deepEqual(args.errors, []);
  });

  test('--ext-id rejects values that cannot be a Chrome extension id', () => {
    const args = parseArgs(['--ext-id', 'not-an-id']);
    assert.deepEqual(args.extensionIds, []);
    assert.equal(args.errors.length, 1);
    assert.match(args.errors[0], /invalid extension id/);
  });

  test('missing values are errors', () => {
    assert.match(parseArgs(['--user-data-dir']).errors[0], /--user-data-dir requires a value/);
    assert.match(parseArgs(['--ext-id']).errors[0], /--ext-id requires a value/);
    assert.match(parseArgs(['--user-data-dir=']).errors[0], /non-empty/);
  });

  test('a following option is not swallowed as a value', () => {
    const a = parseArgs(['--user-data-dir', '--json']);
    assert.deepEqual(a.userDataDirs, [], 'must not scan a directory called "--json"');
    assert.equal(a.json, true, 'the next argument is still parsed as the option it is');
    assert.equal(a.errors.length, 1);
    assert.match(a.errors[0], /--user-data-dir requires a value/);
    assert.match(a.errors[0], /--user-data-dir=<value>/, 'the error explains the escape hatch');

    const b = parseArgs(['--user-data-dir', '-q']);
    assert.deepEqual(b.userDataDirs, []);
    assert.equal(b.quiet, true);
    assert.equal(b.errors.length, 1);

    const c = parseArgs(['--ext-id', '--all']);
    assert.deepEqual(c.extensionIds, []);
    assert.equal(c.all, true);
    assert.match(c.errors[0], /--ext-id requires a value/);

    // A directory whose name starts with "-" is still reachable inline.
    const d = parseArgs(['--user-data-dir=-weird']);
    assert.deepEqual(d.userDataDirs, ['-weird']);
    assert.deepEqual(d.errors, []);
  });

  test('"--" ends option parsing', () => {
    const bare = parseArgs(['--json', '--']);
    assert.equal(bare.json, true);
    assert.deepEqual(bare.errors, []);

    const after = parseArgs(['--', '--json']);
    assert.equal(after.json, false, 'after "--" nothing is an option any more');
    assert.deepEqual(after.errors, ['unexpected argument: --json']);
  });

  test('unknown flags are errors, not exceptions', () => {
    const args = parseArgs(['--bogus', '-x', '--json']);
    assert.equal(args.json, true);
    assert.deepEqual(args.errors, ['unknown option: --bogus', 'unknown option: -x']);
  });

  test('positional arguments are errors', () => {
    const args = parseArgs(['something']);
    assert.deepEqual(args.errors, ['unexpected argument: something']);
  });

  test('boolean flags do not take values', () => {
    const args = parseArgs(['--json=yes']);
    assert.equal(args.json, false);
    assert.match(args.errors[0], /--json does not take a value/);
  });
});

describe('displayWidth', () => {
  test('ASCII counts one cell per character', () => {
    assert.equal(displayWidth(''), 0);
    assert.equal(displayWidth('Default'), 7);
  });

  test('Korean syllables count two cells', () => {
    assert.equal(displayWidth('홍길동 테스트'), 13);
    assert.equal(displayWidth('日本語'), 6);
    assert.equal(displayWidth('Ａ'), 2);
  });

  test('ANSI escapes and combining marks are free', () => {
    assert.equal(displayWidth('\x1b[1;36mabc\x1b[0m'), 3);
    assert.equal(displayWidth('e\u0301'), 1);
    assert.equal(displayWidth('a\u200bb'), 2);
  });

  test('stripAnsi removes SGR sequences only', () => {
    assert.equal(stripAnsi('\x1b[2m-\x1b[0m'), '-');
    assert.equal(stripAnsi('plain'), 'plain');
  });
});

describe('formatTable', () => {
  const rows = [
    row(),
    row({
      profileDirName: 'Profile 1',
      profileName: '홍길동 테스트',
      email: 'you@example.com',
      gaiaName: '홍길동 테스트',
      deviceId: UUID2,
      displayName: 'Mac Studio',
    }),
    row({
      profileDirName: 'Profile 2',
      profileName: 'Paired-less',
      email: null,
      gaiaName: null,
      deviceId: null,
      displayName: null,
    }),
    row({
      browser: 'brave',
      browserName: 'Brave',
      profileDirName: 'Default',
      profileName: 'Nobody',
      email: null,
      gaiaName: null,
      extensionId: null,
      extensionVersion: null,
      deviceId: null,
      displayName: null,
    }),
  ];

  test('has the expected header columns and legend', () => {
    const out = formatTable(rows, { color: false });
    const lines = out.split('\n');
    assert.match(lines[0], /^Browser\s+Profile\s+Name\s+Email\s+Paired name\s+bridgeDeviceId\s+Ext$/);
    assert.match(lines[1], /^-+(\s+-+)+$/);
    assert.ok(out.endsWith('\n'));
    assert.match(out, /bridgeDeviceId is the id Claude Code shows in its browser picker/);
  });

  test('columns stay aligned with East Asian wide characters', () => {
    const out = formatTable(rows, { color: false });
    const lines = out.split('\n').filter((l) => l.length > 0);
    const header = lines[0];
    const headerOffset = displayWidth(header.slice(0, header.indexOf('bridgeDeviceId')));
    const dataLines = lines.slice(2, 2 + rows.length);
    assert.equal(dataLines.length, rows.length);
    const idCells = [UUID, UUID2, 'not paired', 'not installed'];
    dataLines.forEach((line, i) => {
      const idx = line.indexOf(idCells[i]);
      assert.notEqual(idx, -1, `row ${i} should contain ${idCells[i]}`);
      assert.equal(displayWidth(line.slice(0, idx)), headerOffset, `row ${i} bridgeDeviceId column misaligned`);
    });

    // The Korean name occupies fewer JS characters but the same terminal cells as its padding implies.
    const koreanLine = dataLines[1];
    const johnLine = dataLines[0];
    assert.notEqual(koreanLine.indexOf('you@example.com'), johnLine.indexOf('john@example.com'));
    assert.equal(
      displayWidth(koreanLine.slice(0, koreanLine.indexOf('you@example.com'))),
      displayWidth(johnLine.slice(0, johnLine.indexOf('john@example.com'))),
    );
  });

  test('shows "not paired" for an installed but unpaired extension and "not installed" otherwise', () => {
    const out = formatTable(rows, { color: false });
    const lines = out.split('\n');
    const profile2 = lines.find((l) => l.includes('Profile 2'));
    const brave = lines.find((l) => l.startsWith('Brave'));
    assert.match(profile2, /not paired/);
    assert.doesNotMatch(profile2, /not installed/);
    assert.match(brave, /not installed/);
    assert.doesNotMatch(brave, /not paired/);
  });

  test('fills missing name/email/paired name/version with "-"', () => {
    const out = formatTable(rows, { color: false });
    const brave = out.split('\n').find((l) => l.startsWith('Brave'));
    assert.match(brave, /^Brave\s+Default\s+Nobody\s+-\s+-\s+not installed\s+-$/);
  });

  test('no ANSI codes when color is off', () => {
    const out = formatTable(rows, { color: false });
    assert.doesNotMatch(out, ANSI);
  });

  test('device ids are bold cyan and placeholders dimmed when color is on', () => {
    const out = formatTable(rows, { color: true });
    assert.match(out, ANSI);
    assert.ok(out.includes(`\x1b[1m\x1b[36m${UUID}\x1b[0m`), 'deviceId should be bold cyan');
    assert.ok(out.includes('\x1b[2mnot paired\x1b[0m'), '"not paired" should be dim');
    assert.ok(out.includes('\x1b[2mnot installed\x1b[0m'), '"not installed" should be dim');
    assert.doesNotMatch(out, /\x1b\[[0-9;]*mjohn@example\.com/);
  });

  test('colored output is the plain output plus escapes', () => {
    assert.equal(stripAnsi(formatTable(rows, { color: true })), formatTable(rows, { color: false }));
  });

  test('color defaults to off', () => {
    assert.equal(formatTable(rows), formatTable(rows, { color: false }));
  });

  test('empty input still prints a header and a placeholder', () => {
    const out = formatTable([], { color: false });
    assert.match(out, /^Browser\s+Profile/);
    assert.match(out, /\(no profiles found\)/);
    assert.match(out, /bridgeDeviceId is the id/);
  });

  test('an empty table says so differently when profiles exist but lack the extension', () => {
    const out = formatTable([], { color: false, profileCount: 2 });
    assert.doesNotMatch(out, /\(no profiles found\)/, 'two profiles were found, so this would be wrong');
    assert.match(out, /\(2 profiles found, none with the Claude in Chrome extension; use --all to list them\)/);
    assert.match(formatTable([], { color: false, profileCount: 1 }), /\(1 profile found,/);
  });

  test('control characters in untrusted names are neutralised', () => {
    const cases = [
      { field: 'profileName', value: 'evil\x1b]0;PWNED\x07name' },
      { field: 'displayName', value: 'x\x1b[31mRED' },
      { field: 'profileName', value: 'multi\nline' },
      { field: 'profileName', value: 'tab\there' },
      { field: 'email', value: 'a\rb' },
      { field: 'deviceId', value: `${UUID}\x1b[2A` },
      { field: 'extensionVersion', value: '1.0\u2028x' },
    ];
    for (const { field, value } of cases) {
      const out = formatTable([row({ [field]: value })], { color: false });
      assert.doesNotMatch(out, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, `${field}: control characters reached stdout`);
      assert.equal(out.split('\n').length, 6, `${field}: the row must stay on one line`);
      assert.doesNotMatch(out, ANSI, `${field}: escape sequence reached stdout`);
    }
  });

  test('a name with control characters keeps the columns aligned', () => {
    const rows2 = [row(), row({ profileDirName: 'Profile 1', profileName: 'evil\x1b]0;PWNED\x07name' })];
    const lines = formatTable(rows2, { color: false }).split('\n');
    const idx = lines.map((l) => l.indexOf(UUID));
    assert.equal(displayWidth(lines[2].slice(0, idx[2])), displayWidth(lines[3].slice(0, idx[3])));
  });

  test('lines never end in trailing whitespace', () => {
    for (const line of formatTable(rows, { color: true }).split('\n')) {
      assert.equal(line, line.trimEnd());
    }
  });
});

describe('formatJson', () => {
  test('round-trips rows with the documented shape', () => {
    const rows = [row(), row({ deviceId: null, displayName: null, extensionId: null, extensionVersion: null })];
    const text = formatJson(rows);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed, rows);
    assert.deepEqual(Object.keys(parsed[0]), [
      'browser',
      'browserName',
      'userDataDir',
      'profileDir',
      'profileDirName',
      'profileName',
      'email',
      'gaiaName',
      'extensionId',
      'extensionVersion',
      'deviceId',
      'displayName',
      'warnings',
    ]);
    assert.equal(parsed[1].deviceId, null);
    assert.equal(text, JSON.stringify(rows, null, 2));
  });

  test('empty list is "[]"', () => {
    assert.equal(formatJson([]), '[]');
  });
});

describe('helpText', () => {
  test('mentions every option and exit code', () => {
    const help = helpText();
    for (const flag of ['--json', '--all', '--user-data-dir', '--ext-id', '--no-color', '--quiet', '-q', '--help', '-h', '--version', '-v']) {
      assert.ok(help.includes(flag), `help should mention ${flag}`);
    }
    assert.match(help, /Usage:/);
    assert.match(help, /bridgeDeviceId/);
    assert.match(help, /Exit codes:/);
    assert.ok(help.endsWith('\n'));
  });
});

describe('resolveColor', () => {
  const on = parseArgs([]);
  const off = parseArgs(['--no-color']);

  test('on for a TTY without NO_COLOR', () => {
    assert.equal(resolveColor(on, { env: {}, isTTY: true }), true);
  });

  test('off when stdout is not a TTY', () => {
    assert.equal(resolveColor(on, { env: {}, isTTY: false }), false);
  });

  test('NO_COLOR disables color even on a TTY', () => {
    assert.equal(resolveColor(on, { env: { NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(resolveColor(on, { env: { NO_COLOR: '' }, isTTY: true }), true, 'empty NO_COLOR is ignored');
  });

  test('--no-color wins over everything', () => {
    assert.equal(resolveColor(off, { env: { FORCE_COLOR: '1' }, isTTY: true }), false);
  });

  test('FORCE_COLOR enables color without a TTY, TERM=dumb disables it', () => {
    assert.equal(resolveColor(on, { env: { FORCE_COLOR: '1' }, isTTY: false }), true);
    assert.equal(resolveColor(on, { env: { TERM: 'dumb' }, isTTY: true }), false);
  });

  test('FORCE_COLOR=0 disables color even on a TTY (supports-color convention)', () => {
    assert.equal(resolveColor(on, { env: { FORCE_COLOR: '0' }, isTTY: true }), false);
    assert.equal(resolveColor(on, { env: { FORCE_COLOR: 'false' }, isTTY: true }), false);
    assert.equal(resolveColor(on, { env: { FORCE_COLOR: '0' }, isTTY: false }), false);
    assert.equal(resolveColor(on, { env: { FORCE_COLOR: '' }, isTTY: true }), true, 'empty FORCE_COLOR is ignored');
  });
});

describe('main (paths that do not touch the scanner)', () => {
  test('usage error exits 2 with the message on stderr only', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--nope'], io), 2);
    assert.equal(stdout(), '');
    assert.match(stderr(), /unknown option: --nope/);
    assert.match(stderr(), /--help/);
  });

  test('missing option value exits 2', async () => {
    const { io, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir'], io), 2);
    assert.match(stderr(), /requires a value/);
  });

  test('--help exits 0 and prints help on stdout', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--help'], io), 0);
    assert.equal(stdout(), helpText());
    assert.equal(stderr(), '');
  });

  test('--version exits 0 and prints the package version', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['-v'], io), 0);
    assert.equal(stdout(), `${packageVersion()}\n`);
    assert.match(stdout(), /^\d+\.\d+\.\d+/);
    assert.equal(stderr(), '');
  });
});
