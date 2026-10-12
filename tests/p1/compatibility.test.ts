import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BrowserUrlSchema } from '../../packages/protocol/src/browser';
import { LineDecoder } from '../../packages/protocol/src/framing';
import { UsageRpc } from '../../packages/protocol/src/usage';

it('pins ISO normalization beyond DateTimeOffset and at calendar boundaries', () => {
  for (const [from, expected] of [
    ['2026-01-01T00:00:00+15:00', '2025-12-31T09:00:00.000Z'],
    ['2026-01-01T00:00:00-23:59', '2026-01-01T23:59:00.000Z'],
    ['0000-01-01T00:00:00+23:59', '-000001-12-31T00:01:00.000Z'],
    ['9999-12-31T23:59:59.9999-23:59', '+010000-01-01T23:58:59.999Z'],
    ['0000-02-29T12:00:00.123456789Z', '0000-02-29T12:00:00.123Z'],
  ]) expect(UsageRpc['usage.summary'].parse({ filters: { from } }).filters.from).toBe(expected);
});

it('pins the Node time zone namespace and case rules', () => {
  const names = readFileSync('src/Foundry.Protocol/TimeZoneNames.txt', 'utf8').trim().split(/\r?\n/);
  const accepted = new Set(names.map(name => name.toLowerCase()));
  for (const name of names) for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) expect(() => new Intl.DateTimeFormat('en', { timeZone: variant })).not.toThrow();
  for (const name of Intl.supportedValuesOf('timeZone')) expect(accepted.has(name.toLowerCase())).toBe(true);
  expect(() => new Intl.DateTimeFormat('en', { timeZone: 'Pacific Standard Time' })).toThrow();
});

it('pins HTTP-special URL acceptance', () => {
  for (const url of ['http:example.com', 'https:\\example.com', 'http://0x7f000001', 'http://127.1', 'http://0177.0.0.1', 'http://[::1]', 'https://bücher.example', 'https://@example.com', 'http://.', 'http://' + 'a'.repeat(80) + '.com']) expect(BrowserUrlSchema.safeParse(url).success).toBe(true);
  for (const url of ['http://1.2.3.256', 'http://0x100000000', 'http://1..2', 'http://[::1%25eth0]', 'http://example.com:65536', 'http://%00.com', 'https://user@example.com', 'file:///tmp/fixture']) expect(BrowserUrlSchema.safeParse(url).success).toBe(false);
});

it('pins framing after the stdin UTF-8 decoder, CRLF, and transport boundaries', () => {
  const decoder = new LineDecoder(4);
  expect(decoder.push('1234\n1234\n1234\n')).toEqual(['1234', '1234', '1234']);
  expect(() => decoder.push('12345\n')).toThrow();
  expect(() => new LineDecoder(4).push('1234\r\n')).toThrow();
  expect(() => new LineDecoder(2).push(Buffer.from([0xff]).toString('utf8'))).toThrow();
  const fragmented = new LineDecoder(6);
  expect(fragmented.push('😀')).toEqual([]);
  expect(fragmented.push('é\n')).toEqual(['😀é']);
});
