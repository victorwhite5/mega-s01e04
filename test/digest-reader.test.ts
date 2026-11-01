import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read-night.js';

const night = '2026-10-28';
const baseEvent = { at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: 'first' };
const temporaryDirs: string[] = [];

function makeRuns(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-reader-'));
  temporaryDirs.push(dir);
  if (contents !== undefined) writeFileSync(join(dir, `${night}.jsonl`), contents);
  return dir;
}

function jsonl(events: unknown[]): string {
  return events.map(event => JSON.stringify(event)).join('\n');
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readNight real read-only fixture', () => {
  it('returns all five jobs, one bad line, event totals and original offsets', () => {
    expect(readNight('runs', night)).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
  });
});

describe('readNight input and filesystem boundaries', () => {
  it('distinguishes missing files/directories from existing empty nights', () => {
    const dir = makeRuns();
    expect(readNight(dir, night)).toBeNull();
    expect(readNight(join(dir, 'missing'), night)).toBeNull();
    for (const contents of ['', ' \n\t\r\n\n']) {
      writeFileSync(join(dir, `${night}.jsonl`), contents);
      expect(readNight(dir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    }
  });

  it('counts bad-only files without turning them into missing nights', () => {
    expect(readNight(makeRuns('not json\nnull\n[]\n{}\n'), night)).toEqual({
      night, rows: [], badLines: 4, counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('ignores blank lines and trailing newlines, including CRLF', () => {
    const dir = makeRuns(`\r\n  \r\n${JSON.stringify(baseEvent)}\r\n\t\r\n${JSON.stringify(baseEvent)}\r\n`);
    const digest = readNight(dir, night);
    expect(digest?.badLines).toBe(0);
    expect(digest?.counts).toEqual({ ok: 2, retry: 0, fail: 0 });
    expect(digest?.rows).toEqual([{
      job: 'job', owner: 'first', runs: 2, retries: 0, lastStatus: 'ok', lastError: null,
      firstAt: baseEvent.at, lastAt: baseEvent.at,
    }]);
  });

  it.each([
    '', '../2026-10-28', '..', '/2026-10-28', '2026/10/28', '2026\\10\\28',
    '2026-10-28.jsonl', '2026-10-28/../2026-10-28', '%2e%2e%2f2026-10-28',
    '2026-10-28\0', '2026-10-28\n', ' 2026-10-28', '2026-1-28', '２０２６-１０-２８',
    '2026-00-28', '2026-13-28', '2026-10-00', '2026-10-32', '2026-04-31', '2026-02-29', '1900-02-29',
  ])('rejects invalid night %j before attempting I/O', invalidNight => {
    const dir = makeRuns('');
    // A valid read through this non-directory would throw ENOTDIR, not return null.
    expect(readNight(join(dir, `${night}.jsonl`), invalidNight)).toBeNull();
  });

  it.each(['2000-02-29', '2024-02-29', '0000-02-29', '0099-01-01'])('accepts real calendar night %s', validNight => {
    const dir = makeRuns();
    writeFileSync(join(dir, `${validNight}.jsonl`), '');
    expect(readNight(dir, validNight)?.night).toBe(validNight);
  });

  it('propagates unexpected I/O failures instead of reporting a missing night', () => {
    const dir = makeRuns('');
    expect(() => readNight(join(dir, `${night}.jsonl`), night)).toThrowError(expect.objectContaining({ code: 'ENOTDIR' }));
    rmSync(join(dir, `${night}.jsonl`));
    mkdirSync(join(dir, `${night}.jsonl`));
    expect(() => readNight(dir, night)).toThrowError(expect.objectContaining({ code: 'EISDIR' }));
  });

  it.each([
    null, [], true, 3, 'event', {},
    { ...baseEvent, at: undefined }, { ...baseEvent, at: 1 },
    { ...baseEvent, job: undefined }, { ...baseEvent, job: null }, { ...baseEvent, job: '' },
    { ...baseEvent, status: 'OK' }, { ...baseEvent, status: 'unknown' }, { ...baseEvent, status: undefined },
    { ...baseEvent, owner: undefined }, { ...baseEvent, owner: 0 }, { ...baseEvent, owner: {} },
    { ...baseEvent, error: false }, { ...baseEvent, error: [] },
  ])('counts invalid schema %j once and does not aggregate it', invalid => {
    const dir = makeRuns(`${jsonl([invalid, baseEvent])}\n{"truncated":\n`);
    const digest = readNight(dir, night);
    expect(digest?.badLines).toBe(2);
    expect(digest?.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0].runs).toBe(1);
  });

  it.each([
    '', 'yesterday', '2026-10-28', '2026-10-28T12:00:00', '2026-10-28 12:00:00Z',
    '2026-02-30T12:00:00Z', '1900-02-29T12:00:00Z', '2026-13-01T12:00:00Z',
    '2026-00-01T12:00:00Z', '2026-01-00T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-10-28T25:00:00Z', '2026-10-28T12:60:00Z', '2026-10-28T12:00:60Z',
    '2026-10-28T12:00:00+24:00', '2026-10-28T12:00:00-01:60',
    '2026-10-28T12:00:00+0100', '2026-10-28T12:00:00.Z', '2026-10-28T12:00:00Zjunk',
  ])('rejects invalid timestamp %j without throwing', at => {
    expect(readNight(makeRuns(jsonl([{ ...baseEvent, at }])), night)).toEqual({
      night, rows: [], badLines: 1, counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('accepts null/empty owners, empty string errors and extra properties verbatim', () => {
    const events = [
      { ...baseEvent, owner: null, error: null, extra: { nested: true } },
      { ...baseEvent, job: ' ', owner: '', error: '' },
      { ...baseEvent, job: '__proto__', at: '2000-02-29T00:00:00.001-05:30' },
    ];
    const digest = readNight(makeRuns(jsonl(events)), night);
    expect(digest?.badLines).toBe(0);
    expect(digest?.rows.map(row => [row.job, row.owner, row.lastError])).toEqual([
      [' ', '', ''], ['__proto__', 'first', null], ['job', null, null],
    ]);
  });
});

describe('readNight chronological aggregation', () => {
  it('orders by instant, keeps offsets, and retains the latest non-null error through success', () => {
    const firstAt = '2026-10-29T02:00:00+03:00'; // 23:00Z on the previous date
    const lastAt = '2026-10-28T23:30:00-02:00'; // 01:30Z on the next date
    const events = [
      { ...baseEvent, at: lastAt, owner: null, error: null },
      { ...baseEvent, at: '2026-10-29T00:45:00Z', status: 'retry', owner: 'new', error: 'latest error' },
      { ...baseEvent, at: firstAt, status: 'fail', error: 'oldest error' },
      { ...baseEvent, at: '2026-10-29T01:00:00Z', owner: 'another' },
      { ...baseEvent, at: '2026-10-29T00:00:00Z', status: 'retry', error: 'middle error' },
    ];
    expect(readNight(makeRuns(jsonl(events)), night)).toEqual({
      night, badLines: 0, counts: { ok: 2, retry: 2, fail: 1 },
      rows: [{ job: 'job', owner: null, runs: 5, retries: 2, lastStatus: 'ok', lastError: 'latest error', firstAt, lastAt }],
    });
  });

  it('uses input order for equal instants, counts duplicates, and allows owner reassignment', () => {
    const events = [
      { ...baseEvent, status: 'retry', error: 'first error' },
      { ...baseEvent, at: '2026-10-28T22:00:00Z', owner: null, status: 'fail', error: 'second error' },
      { ...baseEvent, at: '2026-10-28T17:00:00-05:00', owner: 'last' },
      { ...baseEvent, at: '2026-10-28T17:00:00-05:00', owner: 'last' },
    ];
    expect(readNight(makeRuns(jsonl(events)), night)?.rows).toEqual([{
      job: 'job', owner: 'last', runs: 4, retries: 1, lastStatus: 'ok', lastError: 'second error',
      firstAt: baseEvent.at, lastAt: '2026-10-28T17:00:00-05:00',
    }]);
  });

  it('does not collapse distinct fractional instants to millisecond ties', () => {
    const firstAt = '2026-10-28T22:00:00.00001Z';
    const lastAt = '2026-10-28T22:00:00.10010Z';
    const events = [
      { ...baseEvent, at: lastAt, owner: 'latest' },
      { ...baseEvent, at: '2026-10-28T22:00:00.100Z', status: 'retry', error: 'fractional error' },
      { ...baseEvent, at: firstAt, status: 'fail' },
    ];
    expect(readNight(makeRuns(jsonl(events)), night)?.rows[0]).toEqual({
      job: 'job', owner: 'latest', runs: 3, retries: 1, lastStatus: 'ok', lastError: 'fractional error', firstAt, lastAt,
    });
  });

  it('treats equivalent fractional representations as ties and retains an empty error string', () => {
    const events = [
      { ...baseEvent, at: '2026-10-28T22:00:00.100Z', error: 'old' },
      { ...baseEvent, at: '2026-10-28T23:00:00.1+01:00', owner: null, error: '' },
      { ...baseEvent, at: '2026-10-28T22:00:00.1000Z', owner: 'final', error: null },
    ];
    const row = readNight(makeRuns(jsonl(events)), night)?.rows[0];
    expect(row).toMatchObject({
      owner: 'final', lastError: '', firstAt: events[0].at, lastAt: events[2].at,
    });
  });

  it('returns deterministic exact-string job order rather than locale or input order', () => {
    const jobs = ['ä', 'z', 'a', '__proto__', 'Z', 'A'];
    const events = jobs.map(job => ({ ...baseEvent, job }));
    expect(readNight(makeRuns(jsonl(events)), night)?.rows.map(row => row.job)).toEqual(['A', 'Z', '__proto__', 'a', 'z', 'ä']);
    expect(readNight(makeRuns(jsonl(events.reverse())), night)?.rows.map(row => row.job)).toEqual(['A', 'Z', '__proto__', 'a', 'z', 'ä']);
  });
});
