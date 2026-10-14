// `stylewright_attach`: the user asks their agent for Stylewright on an app that is
// not Svelte + Vite, and the agent — not the user — puts the overlay on it. Driven
// through the MCP server exactly as an agent would.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StylewrightMcpServer } from '../src/mcp/server.js';
import { attach } from '../src/proxy/attach.js';

interface Rpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: any; error?: any }

let registry: string;
let prevRegistry: string | undefined;
let app: http.Server;
let appUrl: string;
let root: string;

beforeAll(async () => {
	prevRegistry = process.env.STYLEWRIGHT_REGISTRY_DIR;
	registry = mkdtempSync(join(tmpdir(), 'sw-attach-reg-'));
	process.env.STYLEWRIGHT_REGISTRY_DIR = registry;
	app = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<html><head><style>.btn { color: #333; }</style></head><body><a class="btn">Go</a></body></html>');
	});
	await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
	appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
	app.closeAllConnections?.();
	await new Promise((r) => app.close(r));
	if (prevRegistry === undefined) delete process.env.STYLEWRIGHT_REGISTRY_DIR; else process.env.STYLEWRIGHT_REGISTRY_DIR = prevRegistry;
	rmSync(registry, { recursive: true, force: true });
});
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sw-attach-'));
	writeFileSync(join(root, 'style.js'), 'export const STYLE = `.btn { color: #333; }`;\nexport const OTHER = `.x{}`;\n');
});

function harness() {
	const frames: Rpc[] = [];
	const server = new StylewrightMcpServer((s) => {
		for (const line of s.split('\n')) if (line.trim()) frames.push(JSON.parse(line));
	});
	let id = 0;
	const call = async (name: string, args: Record<string, unknown>) => {
		const i = ++id;
		await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name, arguments: args } }));
		const r = frames.find((f) => f.id === i)!.result;
		return { text: r.content[0].text as string, isError: !!r.isError };
	};
	return { server, call };
}

const get = (url: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
	http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode || 0, body: d })); }).on('error', reject);
});
const urlIn = (text: string): string => /open instead of the app's own: (http:\/\/\S+)/.exec(text)![1];

describe('stylewright_attach', () => {
	it('puts the overlay on the app and returns the URL to give the user', async () => {
		const h = harness();
		const r = await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE'], root });
		expect(r.isError).toBe(false);
		const url = urlIn(r.text);
		expect(r.text).toContain('It may write only: style.js#STYLE');
		expect(r.text).toContain('This session is connected');
		const page = await get(url);
		expect(page.body).toContain('window.__stylewright_plain__=true');
		// It registered with its own server, so the watch loop works right away.
		const pending = await h.call('stylewright_list_pending', {});
		expect(pending.isError).toBe(false);
		await h.server.shutdown();
	});

	it('ends with the session: the proxy closes and its registry entry goes', async () => {
		const h = harness();
		const url = urlIn((await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE'], root })).text);
		expect(readdirSync(registry).length).toBeGreaterThan(0);
		await h.server.shutdown();
		await expect(get(url)).rejects.toThrow();
	});

	it('answers a missing or wrong input with what to pass instead, starting nothing', async () => {
		const h = harness();
		expect((await h.call('stylewright_attach', { css: ['style.js#STYLE'], root })).text).toMatch(/target is required/);
		const noName = await h.call('stylewright_attach', { target: appUrl, css: ['style.js'], root });
		expect(noName.isError).toBe(true);
		expect(noName.text).toMatch(/style\.js#NAME.*STYLE, OTHER/);
		expect((await h.call('stylewright_attach', { target: appUrl, css: [], root })).text).toMatch(/at least one --css/);
		expect((await h.call('stylewright_attach', { target: 'https://example.com', css: ['style.js#STYLE'], root })).text).toMatch(/http:\/\//);
		await h.server.shutdown();
	});

	it('points at an overlay that is already running for the project instead of starting a second', async () => {
		const other = await attach({ target: appUrl, css: ['style.js#STYLE'], root, ai: true });
		try {
			const h = harness();
			const r = await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE'], root });
			expect(r.text).toContain('already running for this project');
			expect(r.text).toContain(other.url.replace(/\/$/, ''));
			await h.server.shutdown();
		} finally {
			await other.close();
		}
	});

	it('replaces its own overlay when called again, rather than stacking a second', async () => {
		const h = harness();
		const first = urlIn((await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE'], root })).text);
		const again = await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE', 'style.js#OTHER'], root });
		expect(again.text).toContain('style.js#STYLE, style.js#OTHER');
		const second = urlIn(again.text);
		expect(second).toBe(first); // the port came free and was reused
		expect(readdirSync(registry).filter((f) => f.endsWith('.json'))).toHaveLength(1);
		await h.server.shutdown();
	});

	it('does not leave a second session behind when a background reconnect was pending', async () => {
		const h = harness();
		// No server yet: initialize finds none and schedules a reconnect (2 s).
		await h.server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'i', method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }));
		await new Promise((r) => setTimeout(r, 50));
		const url = urlIn((await h.call('stylewright_attach', { target: appUrl, css: ['style.js#STYLE'], root })).text);
		await new Promise((r) => setTimeout(r, 2600)); // past the pending reconnect
		const state = JSON.parse((await get(`${url}__stylewright/ai/state`)).body);
		expect(state.sessions).toHaveLength(1);
		await h.server.shutdown();
	}, 10_000);
});

describe('attach() picks a free port', () => {
	it('moves to the next port when the default is taken, and reports the one it got', async () => {
		const a = await attach({ target: appUrl, css: ['style.js#STYLE'], root, ai: false });
		const b = await attach({ target: appUrl, css: ['style.js#STYLE'], root, ai: false });
		try {
			expect(a.url).not.toBe(b.url);
			expect(Number(new URL(b.url).port)).toBe(Number(new URL(a.url).port) + 1);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it('is strict about a port that was asked for', async () => {
		const a = await attach({ target: appUrl, css: ['style.js#STYLE'], root, ai: false });
		try {
			await expect(attach({ target: appUrl, css: ['style.js#STYLE'], root, ai: false, port: Number(new URL(a.url).port) })).rejects.toThrow(/in use/);
		} finally {
			await a.close();
		}
	});
});
