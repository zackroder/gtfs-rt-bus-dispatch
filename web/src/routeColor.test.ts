import { describe, expect, it } from 'vitest';
import {
  normalizeGtfsColor,
  readableOn,
  relativeLuma,
  shadeForDirection,
} from './routeColor';

describe('normalizeGtfsColor', () => {
  it('accepts with or without a leading hash', () => {
    expect(normalizeGtfsColor('FFB81C')).toBe('#ffb81c');
    expect(normalizeGtfsColor('#C8102E')).toBe('#c8102e');
  });

  it('returns undefined for malformed colors', () => {
    expect(normalizeGtfsColor('xyz')).toBeUndefined();
    expect(normalizeGtfsColor('FFF')).toBeUndefined();
    expect(normalizeGtfsColor(undefined)).toBeUndefined();
  });
});

describe('readableOn', () => {
  it('uses white text on dark colors and dark text on light colors', () => {
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#FFFFFF')).toBe('#1c2330');
    // CTA's yellow 4/14 is bright enough for dark text; a red is dark enough for white text.
    expect(readableOn('FFB81C')).toBe('#1c2330');
    expect(readableOn('#C8102E')).toBe('#ffffff');
  });

  it('accepts hash-less input like the GTFS value as stored', () => {
    expect(readableOn('FFB81C')).toBe(readableOn('#ffb81c'));
  });
});

describe('shadeForDirection', () => {
  it('renders direction 0 (and unknown) as the route color unchanged', () => {
    expect(shadeForDirection('#C8102E', 0)).toBe('#c8102e');
    expect(shadeForDirection('#C8102E', undefined)).toBe('#c8102e');
  });

  it('tints direction 1 toward white for a normal saturated color', () => {
    // C8102E -> each channel moves 40% of the way to 255.
    expect(shadeForDirection('#C8102E', 1)).toBe('#de7082');
  });

  it('tints a very light base toward black instead of white', () => {
    // FFFFFF (luma > 200) moves 25% of the way to 0 on every channel.
    expect(shadeForDirection('#FFFFFF', 1)).toBe('#bfbfbf');
  });

  it('keeps same-hue opposite directions visibly distinct', () => {
    const base = shadeForDirection('#C8102E', 0);
    const shaded = shadeForDirection('#C8102E', 1);
    expect(shaded).not.toBe(base);
    // The text color is recomputed on the FINAL shaded background.
    expect(readableOn(shaded)).toBe('#ffffff');
    expect(readableOn(base)).toBe('#ffffff');
  });

  it('falls back to a neutral gray for malformed input', () => {
    expect(shadeForDirection('nope', 1)).toBe('#6b7280');
  });
});

describe('relativeLuma', () => {
  it('measures a weighted luma across channels', () => {
    expect(relativeLuma('#FF0000')).toBeCloseTo(0.299 * 255);
    expect(relativeLuma('#FFFFFF')).toBe(255);
    expect(relativeLuma('#000000')).toBe(0);
  });
});