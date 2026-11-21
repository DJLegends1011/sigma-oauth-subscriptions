import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agyBinaryFile, agyClientCandidates, scanForClients } from '../server/agy-oauth-client.js';

// Fixture strings shaped like Google's, assembled so no literal credential sits in the repo.
const id = (d) => `${d.repeat(12)}-${'a'.repeat(32)}.apps.googleusercontent.com`;
const secret = (c) => ['GOC', 'SPX-', c.repeat(28)].join('');

test('scan finds every client id and secret, including across chunk edges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-'));
    try {
        const bin = join(dir, 'agy.bin');
        const pad = Buffer.alloc(8 * 1024 * 1024 - 20, 0);
        writeFileSync(bin, Buffer.concat([Buffer.from(id('1')), pad, Buffer.from(secret('x') + 'decode' + id('2') + 'http' + secret('y') + 'field')]));
        const found = scanForClients(bin);
        assert.deepEqual(found.ids.sort(), [id('1'), id('2')]);
        assert.deepEqual(found.secrets.sort(), [secret('x'), secret('y')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('environment pair wins; otherwise every binary pair is a candidate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-'));
    try {
        const bin = join(dir, 'agy.bin');
        writeFileSync(bin, `\0${id('3')}\0${secret('z')}\0`);
        process.env.AGY_BIN_PATH = bin;
        assert.deepEqual(agyClientCandidates(), [{ id: id('3'), secret: secret('z') }]);
        process.env.AGY_OAUTH_CLIENT_ID = 'env-id';
        process.env.AGY_OAUTH_CLIENT_SECRET = 'env-secret';
        assert.deepEqual(agyClientCandidates(), [{ id: 'env-id', secret: 'env-secret' }]);
    } finally {
        delete process.env.AGY_BIN_PATH; delete process.env.AGY_OAUTH_CLIENT_ID; delete process.env.AGY_OAUTH_CLIENT_SECRET;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a launcher script points at agy.bin beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-'));
    try {
        writeFileSync(join(dir, 'agy'), '#!/bin/bash\nexec agy.bin\n');
        writeFileSync(join(dir, 'agy.bin'), '\x7fELF');
        symlinkSync(join(dir, 'agy'), join(dir, 'link'));
        assert.equal(agyBinaryFile({ path: join(dir, 'link') }), join(dir, 'agy.bin'));
        assert.equal(agyBinaryFile({ path: join(dir, 'agy.bin') }), join(dir, 'agy.bin'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
