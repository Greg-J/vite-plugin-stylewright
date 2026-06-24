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
import { createStylewrightMiddleware } from '../src/server/middleware.js';

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
