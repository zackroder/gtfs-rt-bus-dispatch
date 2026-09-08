/** Route badge that honors GTFS colors while retaining readable fallback contrast. */
import { normalizeGtfsColor, readableOn } from '../routeColor';

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
  const background = normalizeGtfsColor(color);
  const foreground = textColor
    ? normalizeGtfsColor(textColor)
    : background
      ? readableOn(background)
      : undefined;
  return (
    <span className="route-badge" style={{ backgroundColor: background, color: foreground }}>
      {shortName}
    </span>
  );
}