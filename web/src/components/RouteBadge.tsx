/** Route badge that honors GTFS colors while retaining readable fallback contrast. */
function readableOn(hex: string): string {
  // This weighted luma approximation is sufficient for choosing black or white text
  // on the six-digit GTFS route colors used by the server.
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 150 ? '#1c2330' : '#ffffff';
}

export function RouteBadge({
  shortName,
  color,
  textColor,
}: {
  shortName: string;
  color?: string;
  textColor?: string;
}) {
  // GTFS colors may arrive with or without '#'; normalize both forms for inline CSS.
  const background = color ? `#${color.replace('#', '')}` : undefined;
  const foreground = textColor
    ? `#${textColor.replace('#', '')}`
    : background
      ? readableOn(background)
      : undefined;
  return (
    <span className="route-badge" style={{ backgroundColor: background, color: foreground }}>
      {shortName}
    </span>
  );
}
