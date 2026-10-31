// Windows CLI resolution. npm installs global CLIs as `.cmd` shims, and Node's spawn() refuses to run
// `.cmd`/`.bat` files without `shell: true` (EINVAL since the CVE-2024-27980 fix). Instead of spawning
// the shim, read it to find the real target (a `.js` entry or a native `.exe`) and spawn that directly.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';

export function shimTarget(cmdPath) {
    try {
        const text = readFileSync(cmdPath, 'utf8');
        const dir = dirname(cmdPath);
        // Matches both `"%dp0%\node_modules\..."` (current cmd-shim) and `"%~dp0\node_modules\..."` (older).
        const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/gi)]
            .map(m => join(dir, ...m[1].split(/[\\/]/)))
            .filter(p => !/[\\/]node\.exe$/i.test(p));
        const target = targets.at(-1);
        return target && existsSync(target) ? target : null;
    } catch {
        return null;
    }
}

// Candidate paths for `name` on Windows: `<dir>\name.exe` and the target of `<dir>\name.cmd`
// for every PATH entry, plus the default npm global folder (%APPDATA%\npm).
export function windowsBinCandidates(name) {
    if (process.platform !== 'win32') return [];
    const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'));
    const out = [];
    for (const dir of dirs) {
        out.push(join(dir, `${name}.exe`));
        const target = shimTarget(join(dir, `${name}.cmd`));
        if (target) out.push(target);
    }
    return out;
}
