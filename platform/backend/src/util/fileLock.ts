import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Serializes read-modify-write cycles against a single file, and writes it atomically.
 *
 * Both matter for the files this app owns (the per-scope kubeconfigs and the JSON state
 * stores): they are read-modify-written from many concurrent request paths, and losing one
 * costs the user every imported cluster context or every registered cloud account.
 */

const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Normalize so two spellings of the same file (`a/b` vs `a\b`, differing case on Windows,
 * relative vs absolute) share one lock instead of silently running in parallel.
 */
function lockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Run `fn` with exclusive access to `filePath`, chaining onto any in-flight holder.
 *
 * A rejecting holder does not wedge the chain: the stored promise is one whose rejection is
 * already handled, and the next waiter runs via both branches of `then`.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(filePath);
  const prior = fileLocks.get(key) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  const guard = settled.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(key, guard);
  // Drop the entry once this is the last waiter, so the map doesn't grow without bound
  // across per-user/per-scope paths.
  void guard.then(() => {
    if (fileLocks.get(key) === guard) fileLocks.delete(key);
  });
  return settled;
}

/**
 * Write via a temp file in the same directory plus a rename, so a crash/kill mid-write can
 * never leave a truncated file behind - a plain `writeFile` truncates in place, and a
 * half-written kubeconfig loses every context in it.
 *
 * `mode` defaults to 0600 because these files hold bearer tokens and client keys.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fsp.writeFile(tempPath, data, { encoding: 'utf8', mode: options.mode ?? 0o600 });
    // rename is atomic within a filesystem, and replaces the destination on both POSIX and
    // Windows (libuv uses MoveFileEx with MOVEFILE_REPLACE_EXISTING).
    await fsp.rename(tempPath, filePath);
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
