import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
let runsDir: string;
let previousMarker: string | undefined;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  previousMarker = process.env.LANE_MARKER;
  process.env.LANE_MARKER = 'DIGEST-TEST-MARKER';
});

afterEach(() => {
  if (previousMarker === undefined) delete process.env.LANE_MARKER;
  else process.env.LANE_MARKER = previousMarker;
  rmSync(runsDir, { recursive: true, force: true });
});

function app() {
  return createApp({ adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir });
}

function writeNight(contents: string) {
  writeFileSync(join(runsDir, `${night}.jsonl`), contents);
}

describe('digest routes', () => {
  it('serves the complete digest and the same ordered, escaped rows on the page', async () => {
    const events = [
      { at: '2026-10-28T09:00:00+02:00', job: 'z-failed', owner: 'Ada & Bob', status: 'fail', error: '<broken>' },
      { at: '2026-10-28T01:00:00-04:00', job: 'a-retried', owner: 'old', status: 'retry', error: 'first' },
      { at: '2026-10-28T02:00:00-04:00', job: 'a-retried', owner: 'old', status: 'retry' },
      { at: '2026-10-28T03:00:00-04:00', job: 'a-retried', owner: 'old', status: 'retry', error: 'latest & error' },
      { at: '2026-10-28T04:00:00-04:00', job: 'a-retried', owner: null, status: 'ok' },
      { at: '2026-10-28T10:00:00+02:00', job: 'm-<safe>', owner: 'owner', status: 'ok' },
    ];
    writeNight(`${events.map((event) => JSON.stringify(event)).join('\n')}\nnot json\n\n`);
    const expected: NightDigest = {
      night,
      rows: [
        { job: 'a-retried', owner: null, runs: 4, retries: 3, lastStatus: 'ok', lastError: 'latest & error', firstAt: '2026-10-28T01:00:00-04:00', lastAt: '2026-10-28T04:00:00-04:00' },
        { job: 'm-<safe>', owner: 'owner', runs: 1, retries: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-28T10:00:00+02:00', lastAt: '2026-10-28T10:00:00+02:00' },
        { job: 'z-failed', owner: 'Ada & Bob', runs: 1, retries: 0, lastStatus: 'fail', lastError: '<broken>', firstAt: '2026-10-28T09:00:00+02:00', lastAt: '2026-10-28T09:00:00+02:00' },
      ],
      badLines: 1,
      counts: { ok: 2, retry: 3, fail: 1 },
    };
    const application = app();
    const page = await application.request(`/digest/${night}`);
    const json = await application.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual(expected);
    const html = await page.text();
    expect(html).toContain('DIGEST-TEST-MARKER');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('m-&lt;safe&gt;');
    expect(html).toContain('Ada &amp; Bob');
    expect(html).toContain('&lt;broken&gt;');
    expect(html).not.toContain('<broken>');
    expect(html).toMatch(/(?:bad|malformed|invalid)[\s\S]{0,80}1|1[\s\S]{0,80}(?:bad|malformed|invalid)/i);

    const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
    const dataRows = rows.filter((row) => /a-retried|m-&lt;safe&gt;|z-failed/.test(row));
    expect(dataRows).toHaveLength(3);
    expect(dataRows[0]).toContain('a-retried');
    expect(dataRows[1]).toContain('m-&lt;safe&gt;');
    expect(dataRows[2]).toContain('z-failed');
    for (const value of ['—', '4', '3', 'ok', 'latest &amp; error', '2026-10-28T01:00:00-04:00', '2026-10-28T04:00:00-04:00']) {
      expect(dataRows[0]).toContain(value);
    }
    for (const value of ['Ada &amp; Bob', '1', '0', 'fail', '&lt;broken&gt;', '2026-10-28T09:00:00+02:00']) {
      expect(dataRows[2]).toContain(value);
    }
    expect(dataRows[0]).toMatch(/class="[^"]*\bwarn\b/);
    expect(dataRows[2]).toMatch(/class="[^"]*\bwarn\b/);
    expect(dataRows[1]).not.toMatch(/class="[^"]*\bwarn\b/);
  });

  it('distinguishes an empty night from a missing night', async () => {
    writeNight(' \n\n');
    const application = app();
    const page = await application.request(`/digest/${night}`);
    const json = await application.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/nothing ran/i);
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    for (const path of ['/digest/2026-10-27', '/api/digest/2026-10-27']) {
      expect((await application.request(path)).status).toBe(404);
    }
  });

  it('rejects invalid dates and traversal attempts on both routes', async () => {
    writeNight('');
    const application = app();
    for (const invalid of ['2026-02-30', '2026-10-28.jsonl', 'not-a-night', '..%2F2026-10-28', '%2E%2E%2F2026-10-28']) {
      for (const prefix of ['/digest/', '/api/digest/']) {
        expect((await application.request(`${prefix}${invalid}`)).status).toBe(404);
      }
    }
  });
});
