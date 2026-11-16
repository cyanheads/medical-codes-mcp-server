/**
 * @fileoverview The caller-value echo bound (#75) at its own seam, tabled once so
 * the tool suites prove only the wiring: which values are too long to look up
 * (more than 64 Unicode code points once trimmed), and how a reply echoes a
 * caller's value — as sent at 64 characters or fewer, trimmed when only its
 * padding ran past the bound, otherwise its first 64 trimmed code points and `…`,
 * never splitting a surrogate pair. Closes with a thread-CPU check that each
 * helper stays linear on caller-sized text.
 * @module tests/services/echo.test
 */

import { describe, expect, it } from 'vitest';

import {
  ECHO_MAX_CHARS,
  echoValue,
  isOverlong,
  overlongMessage,
  overlongReason,
  quoteValue,
} from '@/services/code-index/echo.js';

const q = (count: number) => 'q'.repeat(count);
const spaces = (count: number) => ' '.repeat(count);
/** One code point, two UTF-16 units. */
const GRIN = '😀';
/** How an overlong run of `q` echoes: its first 64 characters, then `…`. */
const CUT = `${q(64)}…`;

interface Row {
  /** The value as a reply echoes it. */
  echo: string;
  overlong: boolean;
  /** The value as a message quotes it. */
  quote: string;
  /** The value as a caller sent it. */
  value: string;
}

/** Every branch of the rule, each expected echo written out by hand. */
const ROWS: Record<string, Row> = {
  'a code': { value: 'E11.9', overlong: false, echo: 'E11.9', quote: '"E11.9"' },
  'an empty value': { value: '', overlong: false, echo: '', quote: '""' },
  'a padded value of 64 characters or fewer, as sent': {
    value: ' E11.9 ',
    overlong: false,
    echo: ' E11.9 ',
    quote: '" E11.9 "',
  },
  'exactly 64 characters': { value: q(64), overlong: false, echo: q(64), quote: `"${q(64)}"` },
  '64 characters, padding included': {
    value: ` ${q(62)} `,
    overlong: false,
    echo: ` ${q(62)} `,
    quote: `" ${q(62)} "`,
  },
  'padded past 64, a code once trimmed': {
    value: `${spaces(100)}E11.9${spaces(100)}`,
    overlong: false,
    echo: 'E11.9',
    quote: '"E11.9"',
  },
  'padded past 64, exactly 64 once trimmed': {
    value: ` ${q(64)} `,
    overlong: false,
    echo: q(64),
    quote: `"${q(64)}"`,
  },
  'padded past 64 in Unicode whitespace': {
    value: ` ${'　'.repeat(70)}E11.9﻿`,
    overlong: false,
    echo: 'E11.9',
    quote: '"E11.9"',
  },
  'exactly 65 characters': {
    value: q(65),
    overlong: true,
    echo: CUT,
    quote: `"${CUT}" (65 characters)`,
  },
  'an overlong value': {
    value: q(10_000),
    overlong: true,
    echo: CUT,
    quote: `"${CUT}" (10,000 characters)`,
  },
  'an overlong value with padding': {
    value: `${spaces(100)}${q(100)}${spaces(100)}`,
    overlong: true,
    echo: CUT,
    quote: `"${CUT}" (100 characters)`,
  },
  'an overlong value with whitespace before the cut': {
    value: `q${spaces(63)}qq`,
    overlong: true,
    echo: `q${spaces(63)}…`,
    quote: `"q${spaces(63)}…" (66 characters)`,
  },
  'an overlong value with line breaks throughout': {
    value: 'q\r\n'.repeat(40),
    overlong: true,
    echo: `${'q\r\n'.repeat(21)}q…`,
    quote: `"${'q\r\n'.repeat(21)}q…" (118 characters)`,
  },
  '64 astral characters, 128 UTF-16 units': {
    value: GRIN.repeat(64),
    overlong: false,
    echo: GRIN.repeat(64),
    quote: `"${GRIN.repeat(64)}"`,
  },
  '65 astral characters': {
    value: GRIN.repeat(65),
    overlong: true,
    echo: `${GRIN.repeat(64)}…`,
    quote: `"${GRIN.repeat(64)}…" (65 characters)`,
  },
  'an astral character straddling UTF-16 unit 64': {
    value: `${q(63)}${GRIN}${GRIN}`,
    overlong: true,
    echo: `${q(63)}${GRIN}…`,
    quote: `"${q(63)}${GRIN}…" (65 characters)`,
  },
  'an astral character just past the cut': {
    value: `${q(64)}${GRIN}`,
    overlong: true,
    echo: CUT,
    quote: `"${CUT}" (65 characters)`,
  },
  'a lone high surrogate at the cut': {
    value: `${q(63)}\uD800qq`,
    overlong: true,
    echo: `${q(63)}\uD800…`,
    quote: `"${q(63)}\uD800…" (66 characters)`,
  },
  'a lone high surrogate closing the value': {
    value: `${q(64)}\uD800`,
    overlong: true,
    echo: CUT,
    quote: `"${CUT}" (65 characters)`,
  },
  'a run of lone low surrogates': {
    value: '\uDC00'.repeat(65),
    overlong: true,
    echo: `${'\uDC00'.repeat(64)}…`,
    quote: `"${'\uDC00'.repeat(64)}…" (65 characters)`,
  },
  'a short value holding a lone surrogate': {
    value: 'E11\uD800',
    overlong: false,
    echo: 'E11\uD800',
    quote: '"E11\uD800"',
  },
  'whitespace only, 64 characters or fewer': {
    value: spaces(10),
    overlong: false,
    echo: spaces(10),
    quote: `"${spaces(10)}"`,
  },
  'whitespace only, past 64': { value: spaces(10_000), overlong: false, echo: '', quote: '""' },
  'line breaks only, past 64': {
    value: '  \r\n'.repeat(1_000),
    overlong: false,
    echo: '',
    quote: '""',
  },
};

/**
 * The rule as stated, with code points counted by spreading the string, so the
 * helper is checked against the contract rather than against itself.
 */
function stated(value: string): { echo: string; overlong: boolean } {
  const points = (text: string) => [...text];
  const trimmed = value.trim();
  const overlong = points(trimmed).length > 64;
  if (points(value).length <= 64) return { overlong, echo: value };
  if (!overlong) return { overlong, echo: trimmed };
  return { overlong, echo: `${points(trimmed).slice(0, 64).join('')}…` };
}

describe('the caller-value echo bound', () => {
  it('is 64 characters', () => {
    expect(ECHO_MAX_CHARS).toBe(64);
  });

  it.each(Object.entries(ROWS))('classifies, echoes, and quotes %s', (_name, row) => {
    expect(isOverlong(row.value)).toBe(row.overlong);
    expect(echoValue(row.value)).toBe(row.echo);
    expect(quoteValue(row.value)).toBe(row.quote);
  });

  // An echo re-sent — a cut `deferred` value among them — echoes, and misses, as itself.
  it.each(Object.entries(ROWS))('echoes %s idempotently', (_name, { value }) => {
    expect(echoValue(echoValue(value))).toBe(echoValue(value));
    expect(isOverlong(echoValue(value))).toBe(isOverlong(value));
  });

  it('matches the stated rule at every length from 0 to 130, in every alphabet and padding', () => {
    const units = ['q', GRIN, '\uD800', '\uDC00', 'q ', `q${GRIN}`, '\r\n'];
    const paddings = ['', ' ', spaces(40), '\t\n'];
    for (const unit of units) {
      for (const padding of paddings) {
        for (let count = 0; count <= 130; count++) {
          const value = `${padding}${[...unit.repeat(count)].slice(0, count).join('')}${padding}`;
          const want = stated(value);
          expect(isOverlong(value), JSON.stringify(value)).toBe(want.overlong);
          expect(echoValue(value), JSON.stringify(value)).toBe(want.echo);
        }
      }
    }
  });

  it('words the not-looked-up reason with the bound alone, naming neither the value nor its length', () => {
    const reason = overlongReason();
    expect(reason).toContain(`${ECHO_MAX_CHARS} characters`);
    expect(reason.match(/\d[\d,]*/g)).toEqual(['64']);
  });

  it.each([
    ['an overlong value', q(10_000), `"${CUT}" (10,000 characters) `],
    [
      'a padded overlong value',
      `${spaces(100)}${q(100)}${spaces(100)}`,
      `"${CUT}" (100 characters) `,
    ],
    [
      'an astral character at the cut',
      `${q(63)}${GRIN}${GRIN}`,
      `"${q(63)}${GRIN}…" (65 characters) `,
    ],
    ['a value of 64 characters or fewer', 'E11.9', '"E11.9" '],
  ])(
    'leads the not-looked-up message with %s as quoted, then names the bound',
    (_name, value, lead) => {
      const message = overlongMessage(value);
      expect(message.startsWith(lead)).toBe(true);
      const rest = message.slice(lead.length);
      expect(rest).toContain(`${ECHO_MAX_CHARS} characters`);
      expect(rest).not.toContain(value.trim().slice(0, 5));
    },
  );
});

describe('echo bound timing on caller-sized text', () => {
  /** Each helper with its result folded into a number for the sink below. */
  const HELPERS = [
    ['isOverlong', (value: string) => (isOverlong(value) ? 1 : 0)],
    ['echoValue', (value: string) => echoValue(value).length],
    ['quoteValue', (value: string) => quoteValue(value).length],
  ] as const;
  /**
   * Value builders by UTF-16 length. No regex runs here, so every shape carries the
   * full 64× span; the last two are the one-long-line and breaks-throughout shapes.
   */
  const SHAPES = [
    ['a long digit run', (n: number) => '7'.repeat(n)],
    ['a code padded on both sides', (n: number) => `${spaces(n / 2)}E11.9${spaces(n / 2)}`],
    ['astral characters', (n: number) => GRIN.repeat(n / 2)],
    ['lone surrogates', (n: number) => '\uD800'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ] as const;
  const START = 5_000;
  const TRIALS = 3;
  const PAIRS = 3;
  /** Thread CPU per call at every size, in ms: far above linear work at 320k characters. */
  const MAX_CALL_MS = 20;
  /** A per-call time below this is timer noise, so growth is measured against it instead. */
  const FLOOR_MS = 0.000_5;
  /** Where every timed result lands, so an optimizer cannot drop the call. */
  const sink = { total: 0 };

  /** Thread CPU, in ms, of `reps` calls on `value`, per call. */
  function timedPerCall(helper: (value: string) => number, value: string, reps: number): number {
    const before = process.threadCpuUsage();
    for (let rep = 0; rep < reps; rep++) sink.total += helper(value);
    const spent = process.threadCpuUsage(before);
    return (spent.user + spent.system) / 1000 / reps;
  }

  /** Least thread CPU per call, in ms, over several batches: a GC pause only ever adds time. */
  function cpuPerCallMs(helper: (value: string) => number, value: string): number {
    // The first call flattens a rope and warms the helper; past the bound, it takes
    // single calls rather than a batch, so super-linear work fails in seconds.
    const reps =
      timedPerCall(helper, value, 1) >= MAX_CALL_MS
        ? 1
        : // A small input runs as a batch long enough for the timer to resolve.
          Math.min(100, Math.max(4, Math.ceil(500_000 / value.length)));
    let best = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < TRIALS; trial++) {
      best = Math.min(best, timedPerCall(helper, value, reps));
    }
    return best;
  }

  /**
   * Doubles from 5k to 320k characters. The 5k baseline is timed again beside each
   * size, so a move between a fast and a slow core cannot read as growth, and the
   * least growth across those pairs must stay below 256 — checked at every size
   * with the absolute bound, so super-linear work fails before the largest input.
   */
  it.each(
    HELPERS.flatMap(([name, helper]) =>
      SHAPES.map(([shape, make]) => [name, shape, helper, make] as const),
    ),
  )(
    'timing: %s stays linear on %s',
    (_name, _shape, helper, make) => {
      const base = make(START);
      for (let n = START * 2; n <= START * 64; n *= 2) {
        const value = make(n);
        let leastSmall = Number.POSITIVE_INFINITY;
        let leastLarge = Number.POSITIVE_INFINITY;
        let growth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < PAIRS; pair++) {
          const small = cpuPerCallMs(helper, base);
          const large = cpuPerCallMs(helper, value);
          leastSmall = Math.min(leastSmall, small);
          leastLarge = Math.min(leastLarge, large);
          growth = Math.min(growth, large / Math.max(small, FLOOR_MS));
          if (Math.max(small, large) >= MAX_CALL_MS) break;
        }
        expect(leastSmall, `${START} characters`).toBeLessThan(MAX_CALL_MS);
        expect(leastLarge, `${n} characters`).toBeLessThan(MAX_CALL_MS);
        expect(growth, `${n} characters`).toBeLessThan(256);
      }
    },
    0,
  );
});
