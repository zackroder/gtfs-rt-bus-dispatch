/**
 * Bake the GTFS static schedule into a standalone SQLite file (`baked.db` at the repo root) for
 * the deploy image. Run with `npx tsx server/scripts/bake-static.ts` in CI before `flyctl
 * deploy`; the runtime then copies these static tables into the volume DB (Phase 7b) so the
 * ~3.5 GB parse never runs on the Fly machine. The static zip URL is public — no CTA_API_KEY.
 *
 * The produced file carries the full schema (createDatabase) with only the static tables filled
 * plus the static markers (`staticLoadedAt`, `serviceDayStartSeconds`); operational tables stay
 * empty and are never copied to the volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../src/db/schema';
import { loadStatic } from '../src/db/staticLoader';
import { downloadStatic, parseStatic } from '../src/gtfs/static';

const repoRoot = path.resolve(__dirname, '../..');
const outputPath = process.argv[2] ?? path.resolve(repoRoot, 'baked.db');
const staticUrl =
  process.env.CTA_STATIC_URL ?? 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';

async function main(): Promise<void> {
  // Always rebuild from scratch so a stale artifact can never be shipped.
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${outputPath}${suffix}`;
    if (fs.existsSync(candidate)) fs.rmSync(candidate);
  }

  const startedAt = Date.now();
  console.log(`[bake] download ${staticUrl}`);
  const buffer = await downloadStatic(staticUrl);
  const gtfs = parseStatic(buffer);
  console.log(
    `[bake] parsed stops=${gtfs.stops.length} routes=${gtfs.routes.length} ` +
      `trips=${gtfs.trips.length} stop_times=${gtfs.stopTimes.length} ` +
      `duration_ms=${Date.now() - startedAt}`,
  );

  const db = createDatabase(outputPath);
  try {
    loadStatic(db, gtfs);
    // Fold the WAL back into the main file so the artifact is a single self-contained file.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  console.log(
    `[bake] wrote ${outputPath} bytes=${fs.statSync(outputPath).size} total_ms=${Date.now() - startedAt}`,
  );
}

main().catch((error: unknown) => {
  console.error(`[bake] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
