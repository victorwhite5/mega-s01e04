/** Status of one valid input event, not a summary of a job's whole night. */
export type DigestStatus = 'ok' | 'retry' | 'fail';

/** One job, aggregated from all of its valid events in this night. */
export type DigestRow = {
  /** Exact job name from the log; jobs are grouped by this string. */
  job: string;
  /** Owner on the latest chronological event, including an explicit null. */
  owner: string | null;
  /** Total valid input events for this job (including retry and fail events). */
  runs: number;
  /** Number of this job's input events whose status is retry. */
  retries: number;
  /** Status on the latest chronological event. */
  lastStatus: DigestStatus;
  /**
   * Most recent non-null error in chronological order, or null if none.
   * A later event without an error (including success) does not clear it.
   */
  lastError: string | null;
  /** Earliest event's original timestamp string, retaining its logged offset. */
  firstAt: string;
  /** Latest event's original timestamp string, retaining its logged offset. */
  lastAt: string;
};

/** Counts of valid input events, NOT counts of jobs or their final statuses. */
export type DigestCounts = Record<DigestStatus, number>;

/** The shared data returned to the HTML page, JSON endpoint and status board. */
export type NightDigest = {
  night: string;
  /**
   * One row per job, ascending by exact job string using JS string comparison
   * (`<` / `>`), not locale-sensitive sorting. HTML and JSON keep this order.
   */
  rows: DigestRow[];
  /** Nonblank lines rejected as malformed JSON or invalid event data. */
  badLines: number;
  /** Always includes ok, retry and fail, with zero for an absent status. */
  counts: DigestCounts;
};

/**
 * Synchronously read the UTF-8 JSONL file runsDir/<night>.jsonl.
 *
 * Implementation belongs in src/digest/read-night.ts, exporting readNight
 * with this type. This module defines the contract only; it performs no I/O.
 *
 * Night / I/O:
 * - Validate night BEFORE constructing or reading a path: exactly YYYY-MM-DD
 *   (ASCII digits), representing a real calendar date. Reject path separators,
 *   traversal, suffixes and all other forms; do not normalize or URL-decode it.
 * - Invalid night or a missing file/directory (ENOENT) returns null, never an
 *   empty digest. Other filesystem errors propagate to the caller.
 * - An existing empty or whitespace-only file returns a digest with rows: [],
 *   badLines: 0 and all counts zero. A file with only bad lines also has no rows,
 *   but retains its badLines count. Neither case is a missing night.
 *
 * Input / aggregation:
 * - Ignore blank/whitespace-only lines (including a trailing newline).
 * - Each other line must be a JSON object with a nonempty string job, a valid
 *   ISO 8601 timestamp at with an explicit offset (Z or +/-HH:MM), status equal
 *   to ok/retry/fail, and owner a string or null. error may be absent, null or a
 *   string. Extra properties are ignored. Invalid JSON or invalid event fields
 *   increment badLines once for that line; rejected lines affect nothing else.
 * - Every accepted line counts once, including duplicate events. runs counts
 *   all events for a job; retries counts only retry events. Night counts tally
 *   all accepted events by their input status, independent of final statuses.
 * - Order events by timestamp instant, not timestamp text or file order. For
 *   equal instants, earlier input lines come first. This order determines
 *   firstAt, lastAt, lastStatus, owner and lastError as described above.
 * - Preserve firstAt/lastAt verbatim, including their original UTC offsets;
 *   never replace them with normalized UTC display values.
 * - Return rows in the single canonical job order documented on NightDigest;
 *   HTML and JSON consume the same digest without independently reordering it.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
