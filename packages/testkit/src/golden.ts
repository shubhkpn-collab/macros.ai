import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Load a golden vector file from data/golden. Test infrastructure only. */
export function loadGolden<T>(name: string): T {
  const path = resolve(here, '../../../data/golden', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
