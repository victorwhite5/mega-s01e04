import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import * as reader from '../src/digest/read-night.js';

const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };

afterEach(() => vi.restoreAllMocks());

describe('board digest links', () => {
  it('links each fixture and shows event counts, including zeroes', async () => {
    const html = await (await createApp(config).request('/')).text();
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · ok 10 / retry 4 / fail 1');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · ok 7 / retry 0 / fail 0');
  });

  it('keeps a listed night with missing counts if its file disappears', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'rig-board-'));
    const file = join(runsDir, '2026-10-28.jsonl');
    try {
      writeFileSync(file, '');
      const readNight = reader.readNight;
      vi.spyOn(reader, 'readNight').mockImplementation((dir: string, night: string) => {
        unlinkSync(file);
        return readNight(dir, night);
      });
      const html = await (await createApp({ ...config, runsDir }).request('/')).text();
      expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · ok — / retry — / fail —');
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it('preserves the empty runs presentation', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'rig-board-'));
    try {
      const html = await (await createApp({ ...config, runsDir }).request('/')).text();
      expect(html).toContain('nothing in runs/');
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
