// Pure conversions for the comma-separated route-focus editor on the Settings page (plan Phase 10d).
// Kept dependency-free so the parse/format round-trip is unit-testable without rendering React.

/** Render the persisted focus list as the editor's comma-separated text. */
export function formatFocusRoutes(routeIds: string[] | undefined): string {
  return (routeIds ?? []).join(', ');
}

/** Parse editor text into trimmed, de-duplicated route ids; empty means "all routes". */
export function parseFocusRoutes(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const routeId = part.trim();
    if (routeId !== '') seen.add(routeId);
  }
  return Array.from(seen);
}
