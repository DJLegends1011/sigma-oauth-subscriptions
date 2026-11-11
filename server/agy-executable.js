// Sigma's existing launcher resolution, shared by legacy Direct and the CLI port.
import { accessSync, constants, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
export function resolveAgyBinary() {
    const h = homedir();
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'agy.exe' : 'agy';
    const candidates = [
        process.env.AGY_PATH,
        '/data/data/com.termux/files/usr/bin/agy',
        join(h, 'agy-termux-musl', 'agy'),
        join(h, '.local', 'bin', binName),
        join(h, '.antigravity', 'bin', binName),
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
        isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null,
        isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'agy.exe') : null,
        ...String(process.env.PATH || '')
            .split(delimiter)
            .filter(Boolean)
            .map(dir => join(dir, binName)),
    ].filter(Boolean);
    // An explicit override must fail clearly rather than run an unrelated installation.
    if (process.env.AGY_PATH) candidates.splice(1);

    for (const c of candidates) {
        try {
            accessSync(c, constants.X_OK);
            const path = realpathSync(c);
            const fd = openSync(path, 'r');
            let head;
            try {
                const buf = Buffer.alloc(160);
                head = buf.subarray(0, readSync(fd, buf, 0, 160, 0)).toString();
            } finally { closeSync(fd); }
            if (/^#!.*(?:node|\/env\s+node)/.test(head)) return { command: process.execPath, args: [path], path };
            return { command: c, args: [], path: c };
        } catch { /* Try the next executable. */ }
    }
    return null;
}

