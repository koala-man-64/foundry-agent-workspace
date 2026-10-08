/**
 * Tagged JSON for JavaScript values that JSON text cannot carry, so the C# port can rebuild exact inputs
 * and compare exact outputs. The tags never collide with real data: no protocol key starts with "$".
 *
 * - { "$undefined": true }                    undefined (an absent value inside arrays or objects)
 * - { "$number": "-0" | "NaN" | "Infinity" | "-Infinity" }
 * - { "$utf16": [code units] }                a string containing a lone surrogate
 * - { "$object": [[key, value], ...] }        an object built from entries in authored order (JavaScript
 *                                             then moves array-index keys first, which JsJson must match)
 * - { "$repeat": [unit, count] }              a long string of one repeated unit (keeps boundary cases small)
 */
export type Tagged =
  | null | boolean | number | string | Tagged[]
  | { $undefined: true }
  | { $number: '-0' | 'NaN' | 'Infinity' | '-Infinity' }
  | { $utf16: number[] }
  | { $object: [string, Tagged][] }
  | { $repeat: [string, number] }
  | { [key: string]: Tagged };

const REPEAT_THRESHOLD = 64;

const hasLoneSurrogate = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

/** Encode a JavaScript value. Plain objects stay plain JSON objects; use authored {$object} inputs where order matters. */
export function encode(value: unknown): Tagged {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: 'Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
    return value;
  }
  if (typeof value === 'string') {
    if (value.length >= REPEAT_THRESHOLD && value === value[0]!.repeat(value.length) && !hasLoneSurrogate(value[0]!)) return { $repeat: [value[0]!, value.length] };
    return hasLoneSurrogate(value) ? { $utf16: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) } : value;
  }
  if (Array.isArray(value)) return Array.from(value, item => encode(item));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  throw new Error(`Cannot encode a ${typeof value} value.`);
}

/** Build the JavaScript value an authored tagged input describes. */
export function build(input: Tagged): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(build);
  if ('$undefined' in input) return undefined;
  if ('$number' in input) return input.$number === '-0' ? -0 : Number(input.$number);
  if ('$utf16' in input) return String.fromCharCode(...(input.$utf16 as number[]));
  if ('$repeat' in input) { const [unit, count] = input.$repeat as [string, number]; return unit.repeat(count); }
  if ('$object' in input) return Object.fromEntries((input.$object as [string, Tagged][]).map(([key, item]) => [key, build(item)]));
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, build(item as Tagged)]));
}
