// SEC-1 regression: the POST endpoints write to .svelte source, so a cross-site
// page must never be able to drive them. We mount the real middleware on a real
// http.Server and drive it with http.request (full control over the Origin header,
// which a browser sets and a page cannot forge) to prove the CSRF guard holds.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStylewrightMiddleware, resolveSvelteFile } from '../src/server/middleware.js';
import { isAbsolute, join as pjoin } from 'node:path';

const COMP = 'Comp.svelte';
const SRC = `<button class="btn">x</button>\n<style>\n  .btn { color: #333; }\n</style>\n`;
const editBody = JSON.stringify({ file: COMP, selector: '.btn', prop: 'color', value: 'tomato' });

let root: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'sw-sec-'));
	const mw = createStylewrightMiddleware(root);
	server = http.createServer((req, res) => mw(req as never, res as never, () => { res.statusCode = 404; res.end('no'); }));
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { writeFileSync(join(root, COMP), SRC, 'utf8'); });

function post(path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(`${base}${path}`, { method: 'POST', headers }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
		});
		req.on('error', reject);
		req.end(body);
	});
}
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; ctype: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(`${base}${path}`, { method: 'GET', headers }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, ctype: String(res.headers['content-type'] || '') }));
		});
		req.on('error', reject);
		req.end();
	});
}
const onDisk = () => readFileSync(join(root, COMP), 'utf8');

describe('createStylewrightMiddleware — CSRF / SEC-1', () => {
	it('blocks a cross-site POST (foreign Origin) and does NOT write source', async () => {
		const res = await post('/__stylewright/edit', { 'content-type': 'application/json', origin: 'http://evil.example' }, editBody);
		expect(res.status).toBe(403);
		expect(onDisk()).toBe(SRC); // byte-for-byte unchanged
	});

	it('blocks a non-JSON POST (the no-preflight CSRF vector) and does NOT write', async () => {
		const res = await post('/__stylewright/edit', { 'content-type': 'text/plain', origin: base }, editBody);
		expect(res.status).toBe(403);
		expect(onDisk()).toBe(SRC);
	});

	it('blocks a POST with no Origin/Referer at all', async () => {
		const res = await post('/__stylewright/edit', { 'content-type': 'application/json' }, editBody);
		expect(res.status).toBe(403);
		expect(onDisk()).toBe(SRC);
	});

	it('also guards the /apply and /style write endpoints', async () => {
		const apply = await post('/__stylewright/apply', { 'content-type': 'application/json', origin: 'http://evil.example' }, JSON.stringify({ file: COMP, rules: [] }));
		const style = await post('/__stylewright/style', { 'content-type': 'application/json', origin: 'http://evil.example' }, JSON.stringify({ file: COMP, css: '.btn{color:red}' }));
		expect(apply.status).toBe(403);
		expect(style.status).toBe(403);
		expect(onDisk()).toBe(SRC);
	});

	it('allows a same-origin JSON POST and writes the edit', async () => {
		const res = await post('/__stylewright/edit', { 'content-type': 'application/json', origin: base }, editBody);
		expect(res.status).toBe(200);
		expect(onDisk()).toContain('color: tomato');
	});
});

const ok = (): Record<string, string> => ({ 'content-type': 'application/json', origin: base });

describe('createStylewrightMiddleware — /edit input validation (TEST-1)', () => {
	it('rejects a missing/non-string value (no `prop: undefined` write)', async () => {
		const res = await post('/__stylewright/edit', ok(), JSON.stringify({ file: COMP, selector: '.btn', prop: 'color' }));
		expect(res.status).toBe(400);
		expect(onDisk()).toBe(SRC);
		expect(onDisk()).not.toContain('undefined');
	});

	it('rejects a value carrying { } ; (extra-rule injection)', async () => {
		const res = await post('/__stylewright/edit', ok(), JSON.stringify({ file: COMP, selector: '.btn', prop: 'color', value: 'red } .evil{color:blue' }));
		expect(res.status).toBe(400);
		expect(onDisk()).toBe(SRC);
		expect(onDisk()).not.toContain('.evil');
	});
});

describe('createStylewrightMiddleware — readBody (COR-4, TEST-6)', () => {
	it('preserves multi-byte UTF-8 in a large body (no mojibake on chunk boundaries)', async () => {
		const big = '😀中café'.repeat(12000); // ~140 KB → chunked by Node
		const res = await post('/__stylewright/style', ok(), JSON.stringify({ file: COMP, css: `\n  .btn { content: "${big}"; }\n` }));
		expect(res.status).toBe(200);
		const disk = onDisk();
		expect(disk).toContain('😀中café'); // intact
		expect(disk).not.toContain('�'); // no replacement chars
	});

	it('rejects a body over the 1 MB byte cap and does not write', async () => {
		const huge = JSON.stringify({ file: COMP, selector: '.btn', prop: 'color', value: 'x'.repeat(1_100_000) });
		const res = await post('/__stylewright/edit', ok(), huge);
		expect(res.status).toBe(400);
		expect(onDisk()).toBe(SRC);
	});
});

describe('createStylewrightMiddleware — HTTP contract (TEST-2)', () => {
	it('GET /rules returns 200 for an in-root file, 404 for a path escape', async () => {
		const good = await get(`/__stylewright/rules?file=${encodeURIComponent(COMP)}`);
		expect(good.status).toBe(200);
		expect(JSON.parse(good.body).hasStyle).toBe(true);
		const bad = await get(`/__stylewright/rules?file=${encodeURIComponent('../../../etc/passwd')}`);
		expect(bad.status).toBe(404);
	});

	it('GET /client.js serves the overlay bundle as javascript', async () => {
		const res = await get('/__stylewright/client.js');
		expect(res.status).toBe(200);
		expect(res.ctype).toContain('javascript');
	});

	it('rejects a malformed body shape with 400 (css not a string / rules not an array)', async () => {
		const style = await post('/__stylewright/style', ok(), JSON.stringify({ file: COMP, css: 123 }));
		const apply = await post('/__stylewright/apply', ok(), JSON.stringify({ file: COMP, rules: 'x' }));
		expect(style.status).toBe(400);
		expect(apply.status).toBe(400);
		expect(onDisk()).toBe(SRC);
	});

	it('falls through (next) for a GET on a POST-only route', async () => {
		const res = await get('/__stylewright/apply');
		expect(res.status).toBe(404); // our test harness `next` sets 404
	});
});

describe('resolveSvelteFile — adversarial paths (TEST-3)', () => {
	it('returns an absolute path for a legit in-root .svelte file', () => {
		const abs = resolveSvelteFile(root, COMP);
		expect(abs).not.toBeNull();
		expect(isAbsolute(abs!)).toBe(true);
		expect(abs!.toLowerCase().endsWith('.svelte')).toBe(true);
	});

	it('returns null for traversal, out-of-root, prefix-sibling, wrong-ext, and missing files', () => {
		expect(resolveSvelteFile(root, '../../../etc/passwd')).toBeNull();      // traversal
		expect(resolveSvelteFile(root, '../../../etc/passwd.svelte')).toBeNull(); // traversal w/ ext
		expect(resolveSvelteFile(root, isAbsolute('/etc/x.svelte') ? '/etc/x.svelte' : 'C:/Windows/x.svelte')).toBeNull(); // absolute outside
		expect(resolveSvelteFile(root, '../' + root.split(/[\\/]/).pop() + 'EVIL/x.svelte')).toBeNull(); // prefix sibling
		expect(resolveSvelteFile(root, 'styles.css')).toBeNull();              // not .svelte
		writeFileSync(pjoin(root, 'styles.css'), 'x', 'utf8');
		expect(resolveSvelteFile(root, 'styles.css')).toBeNull();              // exists but not .svelte
		expect(resolveSvelteFile(root, 'Nope.svelte')).toBeNull();            // .svelte but missing
		expect(resolveSvelteFile(root, '')).toBeNull();                       // empty
	});
});
