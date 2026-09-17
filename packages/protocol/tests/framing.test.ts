import { describe, expect, it } from 'vitest';
import { LineDecoder } from '../src/framing';
describe('stdio framing', () => {
  it('accepts multiple individually valid messages in one larger transport chunk', () => {
    expect(new LineDecoder(2).push('{}\n{}\n{}\n')).toEqual(['{}', '{}', '{}']);
  });
  it('reassembles split messages and enforces UTF-8 byte size', () => {
    const decoder = new LineDecoder(4);
    expect(decoder.push('é')).toEqual([]);
    expect(decoder.push('é\n')).toEqual(['éé']);
    expect(() => decoder.push('ééé')).toThrow('byte limit');
  });
  it('rejects an oversized completed frame', () => {
    expect(() => new LineDecoder(4).push('12345\n')).toThrow('byte limit');
  });
});
