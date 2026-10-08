import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { golden } from './golden-file';
import { encode } from './encoding';

// path_key lowercases with toLocaleLowerCase('en-US'), which V8 implements as ICU's full lowercase mapping in the root
// locale. Every persisted key was computed by Electron 44 (Node 24, ICU 78.2, Unicode 17.0), so the C# port ships these
// tables instead of the system ICU: keys must not change when Windows updates its ICU.
const PINNED_UNICODE = '17.0';
const tablePath = fileURLToPath(new URL('../../src/Foundry.Platform/EcmaScriptLowercase.json', import.meta.url));
const update = process.env.UPDATE_GOLDEN === '1';

const isSurrogate = (codePoint: number): boolean => codePoint >= 0xd800 && codePoint <= 0xdfff;
const codePoints = (value: string): number[] => Array.from(value, character => character.codePointAt(0)!);

function ranges(test: RegExp): number[][] {
  const found: number[][] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if (isSurrogate(codePoint) || !test.test(String.fromCodePoint(codePoint))) continue;
    const last = found.at(-1);
    if (last && last[1] === codePoint - 1) last[1] = codePoint;
    else found.push([codePoint, codePoint]);
  }
  return found;
}

/** Every code point whose lowercase differs, plus the Cased and Case_Ignorable sets that decide the final sigma. */
function caseTables(): { unicode: string; lower: number[][]; cased: number[][]; caseIgnorable: number[][] } {
  const lower: number[][] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if (isSurrogate(codePoint)) continue;
    const text = String.fromCodePoint(codePoint);
    const lowered = text.toLocaleLowerCase('en-US');
    if (lowered !== text) lower.push([codePoint, ...codePoints(lowered)]);
  }
  return { unicode: process.versions.unicode ?? '', lower, cased: ranges(/^\p{Cased}$/u), caseIgnorable: ranges(/^\p{Case_Ignorable}$/u) };
}

/** One entry per line, so a Unicode update reviews as a readable diff. */
function formatTables(tables: ReturnType<typeof caseTables>): string {
  const list = (rows: number[][]): string => `[\n${rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
  return `{\n  "unicode": ${JSON.stringify(tables.unicode)},\n  "lower": ${list(tables.lower)},\n  "cased": ${list(tables.cased)},\n  "caseIgnorable": ${list(tables.caseIgnorable)}\n}\n`;
}

/** mulberry32: a fixed seed keeps the random vectors stable across runs. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Letters, digits, separators, case-ignorable marks and punctuation, characters that are both cased and case-ignorable
// (U+0345, U+02B0), sigmas, special mappings, supplementary letters, Unicode 16 additions and lone surrogates.
const POOL = [
  0x41, 0x61, 0x5a, 0x7a, 0x30, 0x20, 0x2e, 0x27, 0x3a, 0x2d, 0x5f, 0x5c, 0x2f, 0x5e, 0x60,
  0xb7, 0x2019, 0xad, 0x200d, 0x301, 0x345, 0x2b0, 0x2c7,
  0x3a3, 0x3c3, 0x3c2, 0x391, 0x3b1, 0x386, 0x130, 0x131, 0x1e9e, 0x212a, 0x2126,
  0x10400, 0x10428, 0x13a0, 0xa7cb, 0x10d50, 0x1c89, 0x4e2d, 0xd800, 0xdc00,
];

const SIGMA_CONTEXTS = [
  '\u03a3', '\u0391\u03a3', '\u0391\u03a3.', '\u0391\u03a3.\u0391', '\u0391\u03a3\'', '\u0391\u03a3\'\u0391', '\u0391\'\u03a3',
  '\u0391\u0301\u03a3', '\u03a3\u0301', '\u0391\u03a3\u0301', '\u0391\u03a3\u0301\u0391', '1\u03a3', '\u0391\u03a31', '\u0391\u03a3 ',
  '\u0391\u03a3\u03a3', '\u0391\u03a3\u03a3\u0391', '\ud801\udc00\u03a3', '\u03a3\ud801\udc00', '\ud800\u03a3', '\u0391\u03a3\udc00',
  '\u0345\u03a3', '\u0391\u0345\u03a3', '\u0391\u03a3\u0345', '\u02b0\u03a3', '\u0391\u03a3\u00ad', '\u0391\u00ad\u03a3\u00ad\u0391',
  'C:\\\u0391\u03a3', 'C:\\\u0391\u03a3\\x', 'C:\\\u0391\u03a3.d', 'C:\\\u0130stanbul\\\u0391\u03a3',
];

function lowercaseVectors(tables: ReturnType<typeof caseTables>): { input: unknown; lower: unknown }[] {
  const inputs: string[] = [...SIGMA_CONTEXTS];
  for (let index = 0; index < tables.lower.length; index += 24) {
    inputs.push(String.fromCodePoint(...tables.lower.slice(index, index + 24).map(row => row[0]!)));
  }
  const next = random(0x5157);
  for (let count = 0; count < 1000; count++) {
    const length = 1 + Math.floor(next() * 10);
    inputs.push(Array.from({ length }, () => POOL[Math.floor(next() * POOL.length)]!).map(unit => unit <= 0xffff ? String.fromCharCode(unit) : String.fromCodePoint(unit)).join(''));
  }
  return inputs.map(input => ({ input: encode(input), lower: encode(input.toLocaleLowerCase('en-US')) }));
}

describe('ECMAScript lowercase for path_key', () => {
  const tables = caseTables();

  it('runs on the Unicode version that computed the persisted keys', () => {
    expect(process.versions.unicode, `regenerate and verify only on Node 24 with Unicode ${PINNED_UNICODE}, as in Electron 44`).toBe(PINNED_UNICODE);
  });

  it('pins the tables the C# port ships', () => {
    if (update) writeFileSync(tablePath, formatTables(tables));
    expect(JSON.parse(readFileSync(tablePath, 'utf8'))).toEqual(JSON.parse(formatTables(tables)));
  });

  it('pins toLocaleLowerCase on sigma contexts, every mapped code point and random strings', () => golden('ecmascript-lowercase', lowercaseVectors(tables)));
});
