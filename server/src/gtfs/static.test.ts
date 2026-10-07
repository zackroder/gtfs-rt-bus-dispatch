import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadStatic } from './static';

// Minimal PK-prefixed buffers pass the zip signature check; downloadStatic's cache policy is
// what is under test here, not CSV parsing (covered by staticLoader.test.ts).
const ZIP_A = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('cached-bytes')]);
const ZIP_B = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fresh-bytes')]);

function mockFetchReturning(buffer: Buffer) {
  // fetchZip reads ok/status/statusText/arrayBuffer, so a lightweight Response stand-in suffices.
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => buffer,
  }));
}

describe('downloadStatic cache policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses a valid cache without fetching, and force replaces the cache bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-static-'));
    const cachePath = path.join(dir, 'gtfs.zip');
    try {
      fs.writeFileSync(cachePath, ZIP_A);
      const fetchMock = mockFetchReturning(ZIP_B);
      vi.stubGlobal('fetch', fetchMock);

      // Non-force: a valid cache short-circuits the download.
      const cached = await downloadStatic('http://example.test/gtfs.zip', cachePath);
      expect(cached.equals(ZIP_A)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      // Force: skip the cache read, fetch, and write the fresh bytes back.
      const forced = await downloadStatic('http://example.test/gtfs.zip', cachePath, { force: true });
      expect(forced.equals(ZIP_B)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(cachePath).equals(ZIP_B)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downloads and writes the cache when no cache is present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-static-'));
    const cachePath = path.join(dir, 'nested', 'gtfs.zip');
    const fetchMock = mockFetchReturning(ZIP_B);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const buffer = await downloadStatic('http://example.test/gtfs.zip', cachePath);
      expect(buffer.equals(ZIP_B)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(cachePath).equals(ZIP_B)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
