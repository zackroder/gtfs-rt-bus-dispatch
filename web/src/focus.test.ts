import { describe, expect, it } from 'vitest';
import { formatFocusRoutes, parseFocusRoutes } from './focus';

// The Settings-page route-focus field edits focusRouteIds as comma-separated text (plan Phase 10d);
// these pure helpers are what the page uses to render and to build the PUT /api/config payload.
describe('route focus editor helpers', () => {
  it('formats a focus list as comma-separated text', () => {
    expect(formatFocusRoutes(['9', '79', '49'])).toBe('9, 79, 49');
    expect(formatFocusRoutes([])).toBe('');
    expect(formatFocusRoutes(undefined)).toBe('');
  });

  it('parses trimmed, de-duplicated route ids and treats blank input as all routes', () => {
    expect(parseFocusRoutes('9, 79 , 9,49')).toEqual(['9', '79', '49']);
    expect(parseFocusRoutes('')).toEqual([]);
    expect(parseFocusRoutes('   ')).toEqual([]);
  });

  it('round-trips a formatted list', () => {
    const ids = ['9', '79', '49'];
    expect(parseFocusRoutes(formatFocusRoutes(ids))).toEqual(ids);
  });
});
