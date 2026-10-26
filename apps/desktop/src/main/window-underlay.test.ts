import { describe, expect, it } from 'vitest';
import { DEFAULT_UNDERLAY, underlayColor } from './window-underlay';

describe('underlayColor', () => {
  it('accepts only a six-digit hex colour', () => {
    expect(underlayColor('#e8e2d4')).toBe('#e8e2d4');
    expect(underlayColor('#141210')).toBe('#141210');
    expect(underlayColor('#ABCDEF')).toBe('#ABCDEF');
    for (const value of [null, undefined, '', 'red', '#fff', '#e8e2d4aa', 'rgb(0, 0, 0)', ' #e8e2d4', '#e8e2d4;background:red']) expect(underlayColor(value)).toBeUndefined();
  });

  it('starts from Foundry Light so the default theme never flashes a foreign colour', () => {
    expect(underlayColor(DEFAULT_UNDERLAY)).toBe(DEFAULT_UNDERLAY);
  });
});
