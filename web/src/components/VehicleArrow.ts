import L from 'leaflet';

/**
 * The rotated-SVG arrow used by the terminal map and the vehicle card mini map. Kept in one
 * module so the two maps never drift: a heading-degrees rotation over a filled arrow glyph with
 * an OPTIONAL adjacent label (the mini map renders the arrow alone).
 */

export function arrowSvg(fill: string, headingDegrees: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" ` +
    `style="transform: rotate(${headingDegrees}deg)">` +
    `<path d="M12 2 L20 22 L12 17 L4 22 Z" fill="${fill}" stroke="#ffffff" stroke-width="1.5"/>` +
    `</svg>`
  );
}

// A rotated-SVG arrow is closer in spirit to a map cursor than Leaflet's marker icons and keeps
// the label rendered as an adjacent text node that never distorts with rotation.
export function arrowDivIcon({
  fill,
  headingDegrees,
  label,
}: {
  fill: string;
  headingDegrees: number;
  label?: string;
}): L.DivIcon {
  const labelMarkup =
    label !== undefined ? `<div class="map-arrow-label">${escapeHtml(label)}</div>` : '';
  return L.divIcon({
    className: 'map-arrow',
    html: `${arrowSvg(fill, headingDegrees)}${labelMarkup}`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// Labels are operator-generated (vehicle ids), so escape before they land in innerHTML.
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}