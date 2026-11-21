// Antigravity's OAuth client belongs to Google and ships inside the agy binary, so this
// extension never carries a copy. Token refresh gets it from, in order:
//   1. AGY_OAUTH_CLIENT_ID + AGY_OAUTH_CLIENT_SECRET in the environment;
//   2. the installed agy binary (AGY_BIN_PATH, else the binary resolveAgyBinary finds).
// A binary holds several Google clients, so every id/secret pair found is a candidate and
// the refresh keeps whichever one Google accepts.
import { openSync, readSync, closeSync, statSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAgyBinary } from './agy-executable.js';

const ID_RE = /\d{6,20}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g;
// Go packs strings back to back, so a secret is often followed directly by the next one.
const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{28}/g;
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 256;

function startsWithShebang(path) {
    const fd = openSync(path, 'r');
    try {
        const buf = Buffer.alloc(2);
        return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString('latin1') === '#!';
    } finally { closeSync(fd); }
}

/** The file that holds agy's code: the binary itself, or agy.bin beside the Termux launcher script. */
export function agyBinaryFile(resolved = resolveAgyBinary()) {
    if (process.env.AGY_BIN_PATH) return process.env.AGY_BIN_PATH;
    if (!resolved?.path) return null;
    try {
        const real = realpathSync(resolved.path);
        if (!startsWithShebang(real)) return real;
        const sibling = join(dirname(real), 'agy.bin');
        return existsSync(sibling) ? sibling : null;
    } catch { return null; }
}

let scanCache = null;

/** Every distinct OAuth client id and secret string inside a file, read in chunks. */
export function scanForClients(file) {
    const { size, mtimeMs } = statSync(file);
    if (scanCache?.file === file && scanCache.size === size && scanCache.mtimeMs === mtimeMs) return scanCache.found;
    const ids = new Set();
    const secrets = new Set();
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(CHUNK);
        let tail = '';
        let pos = 0;
        for (;;) {
            const n = readSync(fd, buf, 0, CHUNK, pos);
            if (n === 0) break;
            pos += n;
            const text = tail + buf.toString('latin1', 0, n);
            for (const m of text.matchAll(ID_RE)) ids.add(m[0]);
            for (const m of text.matchAll(SECRET_RE)) secrets.add(m[0]);
            tail = text.slice(-OVERLAP);
        }
    } finally { closeSync(fd); }
    const found = { ids: [...ids], secrets: [...secrets] };
    scanCache = { file, size, mtimeMs, found };
    return found;
}

/** Candidate { id, secret } pairs; the environment's pair alone when it is set. */
export function agyClientCandidates() {
    const id = process.env.AGY_OAUTH_CLIENT_ID;
    const secret = process.env.AGY_OAUTH_CLIENT_SECRET;
    if (id && secret) return [{ id, secret }];
    const file = agyBinaryFile();
    if (!file) return [];
    try {
        const { ids, secrets } = scanForClients(file);
        return ids.flatMap(i => secrets.map(s => ({ id: i, secret: s })));
    } catch { return []; }
}
