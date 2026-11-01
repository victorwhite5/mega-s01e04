import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, NightDigest, ReadNight } from './types.js';

type Event = {
  at: string;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error: string | null;
  /** Whole-second instant plus exact decimal fraction (without trailing zeroes). */
  instant: number;
  fraction: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function parseEvent(value: unknown): Event | null {
  if (!isRecord(value)) return null;
  const { at, job, status, owner, error } = value;
  if (
    typeof at !== 'string' || typeof job !== 'string' || job.length === 0 ||
    (status !== 'ok' && status !== 'retry' && status !== 'fail') ||
    (typeof owner !== 'string' && owner !== null) ||
    (error !== undefined && error !== null && typeof error !== 'string')
  ) return null;

  // Validate calendar and clock components explicitly: Date.parse alone normalizes
  // impossible dates such as February 30. Require a logged, explicit UTC offset.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(at);
  if (!match || !isCalendarDate(match[1])) return null;
  const [, date, hour, minute, second, fraction = '', offset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null;
  const instant = Date.parse(`${date}T${hour}:${minute}:${second}${offset}`);
  if (!Number.isFinite(instant)) return null;

  return { at, job, status, owner, error: error ?? null, instant, fraction: fraction.replace(/0+$/, '') };
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!isCalendarDate(night)) return null;

  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  const digest: NightDigest = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const events: Event[] = [];
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      digest.badLines++;
      continue;
    }
    const event = parseEvent(value);
    if (event === null) {
      digest.badLines++;
      continue;
    }
    events.push(event);
    digest.counts[event.status]++;
  }

  // Stable sort preserves input-line order for equal instants. Compare fractional
  // seconds separately so sub-millisecond timestamps do not become false ties.
  events.sort((a, b) => a.instant - b.instant || (a.fraction < b.fraction ? -1 : a.fraction > b.fraction ? 1 : 0));
  const rows = new Map<string, DigestRow>();
  for (const event of events) {
    const row = rows.get(event.job);
    if (row) {
      row.runs++;
      row.retries += Number(event.status === 'retry');
      row.owner = event.owner;
      row.lastStatus = event.status;
      if (event.error !== null) row.lastError = event.error;
      row.lastAt = event.at;
    } else {
      rows.set(event.job, {
        job: event.job,
        owner: event.owner,
        runs: 1,
        retries: Number(event.status === 'retry'),
        lastStatus: event.status,
        lastError: event.error,
        firstAt: event.at,
        lastAt: event.at,
      });
    }
  }
  digest.rows = [...rows.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return digest;
};
