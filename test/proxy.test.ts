// The plain-HTML proxy, driven over real sockets against a stub app.
//
// What it must do: forward everything to the app as if the browser had asked the
// app directly, add the overlay to HTML and to nothing else, leave the app's
// headers (its CSP above all) alone, tunnel WebSockets, and serve the
// Stylewright API behind the same guards the Vite plugin uses.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy, injectOverlay, overlayTags, cspBlocksInline, inlineScriptSafe, type RunningProxy } from '../src/proxy/proxy.js';
import { parseSourceSpecs } from '../src/server/sources.js';
import { PLAIN_FILE } from '../src/shared/protocol.js';

// Greenskeeper's real policy: inline scripts allowed, nothing from a URL.
const GK_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
const STYLE_JS = 'export const STYLE = `\n.btn { color: #333; }\n`;\n';
const PAGE = '<!doctype html><html><head><style>\n.btn { color: #333; }\n</style></head><body><button class="btn">Go</button></body></html>';

describe('injection helpers', () => {
	it('adds the overlay before the last </body>, case-insensitively, once', () => {
		const tags = overlayTags('/*bundle*/', { ai: true, fonts: true });
		const out = injectOverlay('<html><BODY>x</BODY></html>', tags);
		expect(out).toBe(`<html><BODY>x${tags}</BODY></html>`);
		expect(injectOverlay(out, tags)).toBe(out);
		expect(injectOverlay('<p>fragment</p>', tags)).toBe('<p>fragment</p>' + tags);
	});

	it('stamps the mode flags the overlay reads', () => {
		expect(overlayTags('', { ai: true, fonts: true })).toContain('window.__stylewright_plain__=true');
		const off = overlayTags('', { ai: false, fonts: false });
		expect(off).toContain('__stylewright_no_ai__=true');
		expect(off).toContain('__stylewright_no_fonts__=true');
	});

	it('makes a bundle safe inline without changing what it does', () => {
		const js = 'globalThis.r = ["</script>", "<!-- x -->", `<script>`, /<\\/script>/.source, /<!--/u.test("<!--")];';
		const safe = inlineScriptSafe(js);
		expect(safe).not.toMatch(/<\/script|<!--|<script/i);
		const ctx: { r?: unknown[] } = {};
		vm.runInNewContext(js.replace('globalThis', 'this'), ctx);
		const ctx2: { r?: unknown[] } = {};
		vm.runInNewContext(safe.replace('globalThis', 'this'), ctx2);
		expect(ctx2.r).toEqual(ctx.r);
	});

	it('leaves the real overlay bundle compilable', () => {
		const p = join(__dirname, '..', 'dist', 'client.global.js');
		if (!existsSync(p)) return; // built by `npm run build`; package.test.ts owns its presence
		expect(() => new vm.Script(inlineScriptSafe(readFileSync(p, 'utf8')))).not.toThrow();
	});

	it('knows which policies block an inline script', () => {
		expect(cspBlocksInline(GK_CSP)).toBe(false);
		expect(cspBlocksInline(undefined)).toBe(false);
		expect(cspBlocksInline("default-src 'self'")).toBe(true);
		expect(cspBlocksInline("script-src 'self'")).toBe(true);
		expect(cspBlocksInline("script-src 'unsafe-inline' 'nonce-abc'")).toBe(true);
		expect(cspBlocksInline("script-src 'unsafe-inline' 'strict-dynamic'")).toBe(true);
		expect(cspBlocksInline("script-src 'unsafe-inline' 'sha256-xyz'")).toBe(true);
		expect(cspBlocksInline("img-src 'self'")).toBe(false);
		expect(cspBlocksInline([GK_CSP, "script-src 'self'"])).toBe(true);
	});
});

describe('the proxy against a stub app', () => {
	let root: string;
	let registry: string;
	let prevRegistry: string | undefined;
	let app: http.Server;
	let appUrl: URL;
	let proxy: RunningProxy;
	let base: string;
	const seen: http.IncomingHttpHeaders[] = [];

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), 'sw-proxy-'));
		registry = mkdtempSync(join(tmpdir(), 'sw-reg-'));
		prevRegistry = process.env.STYLEWRIGHT_REGISTRY_DIR;
		process.env.STYLEWRIGHT_REGISTRY_DIR = registry;
		writeFileSync(join(root, 'style.js'), STYLE_JS);

		app = http.createServer((req, res) => {
			seen.push(req.headers);
			const url = req.url || '/';
			const html = (body: string | Buffer, extra: http.OutgoingHttpHeaders = {}) => {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': GK_CSP, 'set-cookie': 'gk=1; HttpOnly; Secure; SameSite=Lax; Path=/', etag: '"abc"', ...extra });
				res.end(body);
			};
			if (url === '/') return html(PAGE);
			if (url === '/gz') return html(zlib.gzipSync(PAGE), { 'content-encoding': 'gzip' });
			if (url === '/redirect') { res.writeHead(303, { location: `${appUrl.origin}/after` }); return res.end(); }
			if (url === '/relative') { res.writeHead(303, { location: '/after' }); return res.end(); }
			if (url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': '13' }); return res.end('console.log()'); }
			if (url === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(req.headers)); }
			if (url === '/post' && req.method === 'POST') {
				let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('got ' + b); });
				return;
			}
			res.writeHead(404); res.end();
		});
		// A minimal upgrade endpoint: answer 101, then echo bytes back.
		app.on('upgrade', (req, socket) => {
			seen.push(req.headers);
			socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
			socket.on('data', (d) => socket.write(d));
			// Upgraded sockets are half-open on an http.Server: end ours when the
			// proxy ends its side, or app.close() waits on it forever.
			socket.on('end', () => socket.end());
		});
		await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
		appUrl = new URL(`http://127.0.0.1:${(app.address() as AddressInfo).port}`);

		proxy = await startProxy({ target: appUrl, root, sources: parseSourceSpecs(root, ['style.js#STYLE']), port: 0, ai: true, fonts: true });
		base = proxy.url.replace(/\/$/, '');
	});
	afterAll(async () => {
		await proxy.close();
		app.closeAllConnections?.();
		await new Promise((r) => app.close(r));
		if (prevRegistry === undefined) delete process.env.STYLEWRIGHT_REGISTRY_DIR; else process.env.STYLEWRIGHT_REGISTRY_DIR = prevRegistry;
		rmSync(root, { recursive: true, force: true });
		rmSync(registry, { recursive: true, force: true });
	});

	type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
	const req = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
		new Promise((resolve, reject) => {
			const r = http.request(`${base}${path}`, { method: opts.method || 'GET', headers: opts.headers }, (res) => {
				let data = '';
				res.on('data', (c) => (data += c));
				res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
			});
			r.on('error', reject);
			r.end(opts.body);
		});

	it('adds the overlay to HTML and leaves the app\'s headers alone', async () => {
		const r = await req('/');
		expect(r.status).toBe(200);
		expect(r.body.startsWith(PAGE.slice(0, PAGE.indexOf('</body>')))).toBe(true);
		expect(r.body).toContain('window.__stylewright_plain__=true');
		expect(r.body.endsWith('</body></html>')).toBe(true);
		expect(r.headers['content-security-policy']).toBe(GK_CSP);
		expect(r.headers['set-cookie']).toEqual(['gk=1; HttpOnly; Secure; SameSite=Lax; Path=/']);
		expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.body));
		expect(r.headers.etag).toBeUndefined();
		expect(r.headers['cache-control']).toBe('no-store');
	});

	it('decodes a compressed page before adding to it', async () => {
		const r = await req('/gz');
		expect(r.headers['content-encoding']).toBeUndefined();
		expect(r.body).toContain('<button class="btn">Go</button>');
		expect(r.body).toContain('__stylewright_plain__');
	});

	it('passes everything else through byte for byte', async () => {
		const r = await req('/app.js');
		expect(r.body).toBe('console.log()');
		expect(r.headers['content-length']).toBe('13');
		const p = await req('/post', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
		expect(p.body).toBe('got a=1');
	});

	it('addresses the app as itself: its own Host, Origin and Referer, uncompressed', async () => {
		const r = await req('/echo', { headers: { origin: base, referer: `${base}/p/x?y=1`, 'accept-encoding': 'gzip, br' } });
		const h = JSON.parse(r.body) as http.IncomingHttpHeaders;
		expect(h.host).toBe(appUrl.host);
		expect(h.origin).toBe(appUrl.origin);
		expect(h.referer).toBe(`${appUrl.origin}/p/x?y=1`);
		expect(h['accept-encoding']).toBeUndefined();
		// A foreign Origin is not ours to launder.
		const f = JSON.parse((await req('/echo', { headers: { origin: 'https://evil.example' } })).body) as http.IncomingHttpHeaders;
		expect(f.origin).toBe('https://evil.example');
	});

	it('keeps the browser on the proxy across an absolute redirect', async () => {
		expect((await req('/redirect')).headers.location).toBe(`${base}/after`);
		expect((await req('/relative')).headers.location).toBe('/after');
	});

	it('tunnels a WebSocket upgrade to the app', async () => {
		const port = Number(new URL(base).port);
		const echoed = await new Promise<string>((resolve, reject) => {
			const s = net.connect(port, '127.0.0.1', () => {
				s.write(`GET /live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${base}\r\n\r\n`);
			});
			let buf = '';
			s.on('data', (d) => {
				buf += d.toString();
				if (buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping');
				if (buf.includes('ping')) { s.destroy(); resolve(buf); }
			});
			s.on('error', reject);
		});
		expect(echoed).toMatch(/^HTTP\/1\.1 101/);
		expect(echoed).toContain('ping');
		const last = seen[seen.length - 1];
		expect(last.origin).toBe(appUrl.origin);
		expect(last.host).toBe(appUrl.host);
	});

	it('refuses a Host that is not an IP literal or localhost — the API and the app alike', async () => {
		expect((await req('/', { headers: { host: 'evil.example' } })).status).toBe(403);
		expect((await req(`/__stylewright/rules?file=${PLAIN_FILE}`, { headers: { host: 'evil.example' } })).status).toBe(403);
	});

	it('serves the configured sources\' rules itself', async () => {
		const r = await req(`/__stylewright/rules?file=${encodeURIComponent(PLAIN_FILE)}`);
		const body = JSON.parse(r.body);
		expect(body.rules[0]).toMatchObject({ selector: '.btn', origin: 'style.js#STYLE' });
		expect(body.sources[0].css).toBe('\n.btn { color: #333; }\n');
	});

	it('requires the overlay\'s header and a same-origin request to write', async () => {
		const { rules } = JSON.parse((await req(`/__stylewright/rules?file=${PLAIN_FILE}`)).body);
		rules[0].decls[0].value = 'red';
		const body = JSON.stringify({ file: PLAIN_FILE, rules });
		const json = { 'content-type': 'application/json' };
		expect((await req('/__stylewright/apply', { method: 'POST', body, headers: { ...json, origin: base } })).status).toBe(403);
		expect((await req('/__stylewright/apply', { method: 'POST', body, headers: { ...json, origin: 'https://evil.example', 'x-stylewright': '1' } })).status).toBe(403);
		expect(readFileSync(join(root, 'style.js'), 'utf8')).toBe(STYLE_JS);
		const ok = await req('/__stylewright/apply', { method: 'POST', body, headers: { ...json, origin: base, 'x-stylewright': '1' } });
		expect(ok.status).toBe(200);
		expect(readFileSync(join(root, 'style.js'), 'utf8')).toBe(STYLE_JS.replace('#333', 'red'));
		writeFileSync(join(root, 'style.js'), STYLE_JS);
	});

	it('does not mount the .svelte-only routes', async () => {
		expect((await req('/__stylewright/style?file=x.svelte')).status).toBe(404);
	});

	it('registers for agents with the proxy\'s own origin, and Ask AI accepts only configured files', async () => {
		const entries = readdirSync(registry).filter((f) => f.endsWith('.json'));
		expect(entries).toHaveLength(1);
		const dev = JSON.parse(readFileSync(join(registry, entries[0]), 'utf8'));
		expect(dev.origin).toBe(base);
		expect(dev.root).toBe(root);

		const send = (file: string) => req('/__stylewright/ai/send', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: base, 'x-stylewright': '1' },
			body: JSON.stringify({ prompt: 'make it green', source: { file }, element: {}, context: {}, page: {} })
		});
		const bad = await send('view.js');
		expect(bad.status).toBe(400);
		expect(JSON.parse(bad.body).reason).toBe('bad_file');
		// A configured file passes validation; with no session linked the broker refuses.
		expect(JSON.parse((await send('style.js')).body).reason).not.toBe('bad_file');
	});

	it('says plainly when the app is not running', async () => {
		const dead = await startProxy({ target: new URL('http://127.0.0.1:1'), root, sources: parseSourceSpecs(root, ['style.js#STYLE']), port: 0, ai: false, fonts: true });
		try {
			const r = await new Promise<Res>((resolve) => {
				http.get(dead.url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: d })); });
			});
			expect(r.status).toBe(502);
			expect(r.body).toMatch(/Start the app's dev server/);
		} finally {
			await dead.close();
		}
	});

	it('refuses an https target rather than pretend to proxy it', async () => {
		await expect(startProxy({ target: new URL('https://127.0.0.1:1'), root, sources: [], port: 0, ai: false, fonts: true })).rejects.toThrow(/http:\/\//);
	});
});
