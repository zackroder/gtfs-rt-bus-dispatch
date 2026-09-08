/**
 * GTFS route-color helpers shared by the route badge and the block strip. Colors arrive as
 * six-digit hex with or without a leading '#', so every consumer normalizes through these.
 */

// Strip '#' and lowercase a six-digit hex color; anything else is not a usable GTFS color.
export function normalizeGtfsColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean.toLowerCase()}` : undefined;
}

function parseChannels(hex: string): { r: number; g: number; b: number } | undefined {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return undefined;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

// Weighted luma approximation; sufficient for choosing black/white text on agency route colors.
export function relativeLuma(hex: string): number {
  const channels = parseChannels(hex);
  if (!channels) return 0;
  return 0.299 * channels.r + 0.587 * channels.g + 0.114 * channels.b;
}

// Pick a readable foreground (dark or white) for the given background color.
export function readableOn(hex: string): string {
  // The badge/strip ink palette matches the app's base text (#1c2330) over a white card.
  return relativeLuma(hex) > 150 ? '#1c2330' : '#ffffff';
}

/**
 * Deterministic direction shading for the block strip: direction 1 tints the route color toward
 * white so same-hue routes read as different trips once direction differs. An already very light
 * base (luma > 200) tints toward black instead, keeping the label legible. Direction 0 (or an
 * absent direction) returns the route color unchanged.
 */
export function shadeForDirection(hex: string, directionId?: number): string {
  const channels = parseChannels(hex);
  if (!channels) return '#6b7280';
  if (directionId === undefined || directionId === 0) return normalizeGtfsColor(hex)!;
  const tintTowardDark = relativeLuma(hex) > 200;
  const target = tintTowardDark ? 0 : 255;
  const mix = tintTowardDark ? 0.25 : 0.4;
  const mixChannel = (component: number): number =>
    Math.round(component + (target - component) * mix);
  const r = mixChannel(channels.r);
  const g = mixChannel(channels.g);
  const b = mixChannel(channels.b);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}