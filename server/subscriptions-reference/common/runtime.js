// Sigma adaptation of Luka's plugin-owned runtime directory.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export function runtimeDir(sub = '') {
    const directory = join(tmpdir(), `sigma-subscriptions-${process.pid}`, sub);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
}
