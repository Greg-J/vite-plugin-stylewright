// The security suite the API middleware never had.
//
// Every route under /__stylewright reads or writes the developer's source tree
// from a server that any page in their browser can reach by URL. These tests pin
// the two properties that make that safe — a write needs a same-origin request
// carrying the overlay's own header, and no path outside the project root is
// reachable however it is spelled — plus the token gate on the agent routes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStylewrightMiddleware } from '../src/server/middleware.js';
import { createAiRoutes } from '../src/server/ai/routes.js';
import { Broker } from '../src/server/ai/broker.js';
import { resolveSvelteFile } from '../src/server/paths.js';
import { applyStyleBlock } from '../src/server/patch.js';
import { isSafeHost, isSameOrigin, isLoopbackAddress, timingSafeEqual } from '../src/server/guard.js';

const COMPONENT = '<div class="btn">hi</div>\n<style>\n.btn { color: red; }\n</style>\n';

let root: string;
let outside: string;

beforeEach(() => {
	// realpath: on macOS /tmp is itself a symlink, and the validator resolves both
	// sides — the fixture has to compare against the same reality.
	root = realpathSync(mkdtempSync(join(tmpdir(), 'sw-root-')));
	outside = realpathSync(mkdtempSync(join(tmpdir(), 'sw-out-')));
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'src', 'Button.svelte'), COMPONENT);
	writeFileSync(join(outside, 'Secret.svelte'), '<style>.x{color:blue}</style>');
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

interface FakeRes {
	statusCode: number;
	body: string;
	headers: Record<string, string>;
	writableEnded: boolean;
	setHeader(k: string, v: unknown): void;
	getHeader(k: string): string | undefined;
	removeHeader(k: string): void;
	write(c?: unknown): boolean;
	end(c?: unknown): FakeRes;
}

function makeRes(): FakeRes {
	const headers: Record<string, string> = {};
	const res: FakeRes = {
		statusCode: 200, body: '', headers, writableEnded: false,
		setHeader(k, v) { headers[k.toLowerCase()] = String(v); },
		getHeader(k) { return headers[k.toLowerCase()]; },
		removeHeader(k) { delete headers[k.toLowerCase()]; },
		write(c) { if (c != null) res.body += String(c); return true; },
		end(c) { if (c != null) res.body += String(c); res.writableEnded = true; return res; }
	};
	return res;
}

interface CallOpts {
	method?: string;
	url: string;
	host?: string;
	origin?: string;
	swHeader?: boolean;
	auth?: string;
	contentType?: string;
	body?: unknown;
	remote?: string;
}

/** Drive the middleware with a fake req/res pair and wait for it to settle. */
async function call(mw: ReturnType<typeof createStylewrightMiddleware>, o: CallOpts) {
	const res = makeRes();
	let nexted = false;
	const headers: Record<string, string> = { host: o.host ?? '127.0.0.1:5173' };
	if (o.origin) headers.origin = o.origin;
	if (o.swHeader) headers['x-stylewright'] = '1';
	if (o.auth) headers.authorization = o.auth;

	const payload = o.body === undefined ? null : JSON.stringify(o.body);
	// The real overlay always sends JSON, and the guard now requires it — so a
	// test that supplies a body is testing a JSON request unless it says otherwise.
	if (payload !== null) headers['content-type'] = o.contentType ?? 'application/json';
	else if (o.contentType) headers['content-type'] = o.contentType;
	const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
	const req = {
		method: o.method || 'GET',
		url: o.url,
		headers,
		socket: { remoteAddress: o.remote ?? '127.0.0.1' },
		on(ev: string, fn: (...a: unknown[]) => void) {
			(listeners[ev] ||= []).push(fn);
			// Deliver the body synchronously on subscribe, like a buffered stream.
			if (ev === 'end' && payload !== null) queueMicrotask(() => fn());
			if (ev === 'data' && payload !== null) queueMicrotask(() => fn(payload));
			return req;
		},
		off() { return req; },
		destroy() { /* noop */ }
	};
	await (mw as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, res, () => { nexted = true; });
	return { res, nexted, json: () => { try { return JSON.parse(res.body); } catch { return null; } } };
}

describe('path containment', () => {
	it('accepts a .svelte file inside the root', () => {
		expect(resolveSvelteFile(root, 'src/Button.svelte')).toBeTruthy();
	});

	it('rejects traversal, non-svelte, absolute-outside and missing files', () => {
		expect(resolveSvelteFile(root, '../Secret.svelte')).toBeNull();
		expect(resolveSvelteFile(root, 'src/../../x/Secret.svelte')).toBeNull();
		expect(resolveSvelteFile(root, join(outside, 'Secret.svelte'))).toBeNull();
		writeFileSync(join(root, 'notes.txt'), 'x');
		expect(resolveSvelteFile(root, 'notes.txt')).toBeNull();
		expect(resolveSvelteFile(root, 'src/Nope.svelte')).toBeNull();
	});

	it('rejects a NUL byte in the path', () => {
		expect(resolveSvelteFile(root, 'src/Button.svelte\0.png')).toBeNull();
	});

	// The gap the old validator had: normalize() + a prefix compare says this path
	// is inside the root, and then readFile/writeFile follows it straight out.
	it('rejects a symlink that escapes the root', () => {
		const link = join(root, 'src', 'Escape.svelte');
		symlinkSync(join(outside, 'Secret.svelte'), link);
		expect(resolveSvelteFile(root, 'src/Escape.svelte')).toBeNull();
	});

	it('still accepts a symlink that stays inside the root', () => {
		const target = join(root, 'src', 'Button.svelte');
		const link = join(root, 'Alias.svelte');
		symlinkSync(target, link);
		expect(resolveSvelteFile(root, 'Alias.svelte')).toBeTruthy();
	});

	it('rejects a symlink whose real target is not a .svelte file', () => {
		writeFileSync(join(outside, 'passwd'), 'root:x:0:0');
		symlinkSync(join(outside, 'passwd'), join(root, 'src', 'Sneaky.svelte'));
		expect(resolveSvelteFile(root, 'src/Sneaky.svelte')).toBeNull();
	});
});

describe('the whole-block save cannot escape the <style> element', () => {
	// /style splices the client's text in verbatim (unlike /apply and /edit, which
	// re-serialize through postcss and escape `<`). A payload containing </style>
	// would close the block early and turn the remainder into markup or script —
	// under SSR, code execution in the dev server. postcss parses such a string
	// happily, so nothing else catches it.
	const attack = 'h1{color:red}\n</style>\n<script context="module">globalThis.PWNED=1</script>\n<style>\nb{color:blue}';

	it('refuses a payload that closes the style element', () => {
		const src = '<script>let a=1;</script>\n<h1>hi</h1>\n<style>h1{color:blue}</style>\n';
		const out = applyStyleBlock(src, attack);
		expect(out.changed).toBe(false);
		// `unsafe`, not `invalid`: the CSS parses fine, which is exactly why the
		// completeness check never caught this. They are reported separately so the
		// overlay can say which one happened.
		expect(out.unsafe).toBe(true);
		expect(out.code).toBe(src);
	});

	it('refuses the obfuscated spellings too', () => {
		const src = '<style>a{b:c}</style>';
		for (const p of ['x{}</STYLE><script>1</script>', 'x{}</ style ><script>1</script>', 'x{}< /style>']) {
			expect(applyStyleBlock(src, p).changed, p).toBe(false);
		}
	});

	it('still writes ordinary CSS', () => {
		const out = applyStyleBlock('<style>a{b:c}</style>', 'a{ b: d }');
		expect(out.changed).toBe(true);
		expect(out.code).toContain('a{ b: d }');
	});
});

describe('host and origin guards', () => {
	it('accepts the hosts a dev server is legitimately reached on', () => {
		for (const h of [
			'127.0.0.1:5173', 'localhost:5173', 'localhost', 'my-app.localhost:5173',
			'192.168.1.20:5173',                 // vite --host, testing on a phone
			'[::1]:5173', '::1',
			'[::ffff:127.0.0.1]:5173'            // IPv4-mapped, from a dual-stack bind
		]) expect(isSafeHost(h), h).toBe(true);
	});

	// DNS rebinding is what makes the Origin check insufficient on its own: the
	// attacker's page becomes same-origin with the dev server. Refusing any Host
	// that could be a registered domain is what closes it.
	it('refuses every host that could be attacker-controlled', () => {
		for (const h of [
			'evil.com:5173', 'evil.com', 'localhost.evil.com:5173', 'sub.localhost.evil.com',
			'evil.com.',                          // trailing dot is still a domain
			'localhost@evil.com',                 // userinfo confusion
			'LOCALHOST.EVIL.COM',                 // case
			'xn--80ak6aa92e.com',                 // punycode homograph
			'127.1', '2130706433',                // shorthand / decimal IP forms
			'face.fade',                          // all-hex letters, but no colon
			'evil.com:80@localhost', 'not-localhost', 'localhost:', ''
		]) expect(isSafeHost(h), h).toBe(false);
		expect(isSafeHost(undefined)).toBe(false);
	});

	it('compares origins by authority', () => {
		expect(isSameOrigin('http://127.0.0.1:5173', '127.0.0.1:5173')).toBe(true);
		expect(isSameOrigin('http://127.0.0.1:5174', '127.0.0.1:5173')).toBe(false);
		expect(isSameOrigin('http://evil.com', '127.0.0.1:5173')).toBe(false);
		expect(isSameOrigin('null', '127.0.0.1:5173')).toBe(false);
	});

	it('recognises loopback socket addresses', () => {
		expect(isLoopbackAddress('127.0.0.1')).toBe(true);
		expect(isLoopbackAddress('::1')).toBe(true);
		expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
		expect(isLoopbackAddress('192.168.1.5')).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});

	it('compares tokens without an early-exit oracle', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
		expect(timingSafeEqual('', '')).toBe(true);
	});
});

describe('CSS routes are not writable from another page', () => {
	let mw: ReturnType<typeof createStylewrightMiddleware>;
	beforeEach(() => { mw = createStylewrightMiddleware(root); });

	it('allows a same-origin write that carries the overlay header', async () => {
		const r = await call(mw, {
			method: 'POST', url: '/__stylewright/apply', origin: 'http://127.0.0.1:5173', swHeader: true,
			body: { file: 'src/Button.svelte', rules: [] }
		});
		expect(r.res.statusCode).toBe(200);
	});

	it('refuses a cross-origin write', async () => {
		const r = await call(mw, {
			method: 'POST', url: '/__stylewright/apply', origin: 'http://evil.example', swHeader: true,
			body: { file: 'src/Button.svelte', rules: [] }
		});
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('bad_origin');
	});

	// A cross-site <form> can POST without JavaScript but cannot set a header.
	it('refuses a write with no overlay header', async () => {
		const r = await call(mw, {
			method: 'POST', url: '/__stylewright/apply', origin: 'http://127.0.0.1:5173',
			body: { file: 'src/Button.svelte', rules: [] }
		});
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('missing_client_header');
	});

	it('refuses any request addressed to a rebound domain', async () => {
		const r = await call(mw, { method: 'GET', url: '/__stylewright/rules?file=src/Button.svelte', host: 'evil.com:5173' });
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('bad_host');
	});

	it('refuses to read a file outside the root', async () => {
		const r = await call(mw, { method: 'GET', url: `/__stylewright/rules?file=${encodeURIComponent(join(outside, 'Secret.svelte'))}` });
		expect(r.res.statusCode).toBe(404);
	});

	it('serves the overlay bundle to a plain same-origin GET', async () => {
		const r = await call(mw, { method: 'GET', url: '/__stylewright/client.js' });
		expect(r.res.statusCode).toBe(200);
	});
});

describe('agent routes are token-gated', () => {
	let mw: ReturnType<typeof createStylewrightMiddleware>;
	let broker: Broker;
	const TOKEN = 'a'.repeat(64);

	beforeEach(() => {
		broker = new Broker({ root });
		mw = createStylewrightMiddleware(root, createAiRoutes({ broker, root, token: TOKEN }));
	});
	afterEach(() => broker.dispose());

	it('refuses with no token', async () => {
		const r = await call(mw, { method: 'POST', url: '/__stylewright/ai/agent/hello', body: { cwd: root } });
		expect(r.res.statusCode).toBe(401);
	});

	it('refuses with a wrong token', async () => {
		const r = await call(mw, { method: 'POST', url: '/__stylewright/ai/agent/hello', auth: 'Bearer ' + 'b'.repeat(64), body: { cwd: root } });
		expect(r.res.statusCode).toBe(401);
	});

	it('refuses a correct token from a non-loopback socket', async () => {
		const r = await call(mw, { method: 'POST', url: '/__stylewright/ai/agent/hello', auth: 'Bearer ' + TOKEN, remote: '10.0.0.9', body: { cwd: root } });
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('not_loopback');
	});

	it('accepts loopback + the right token', async () => {
		const r = await call(mw, { method: 'POST', url: '/__stylewright/ai/agent/hello', auth: 'Bearer ' + TOKEN, body: { cwd: root, clientInfo: { name: 'claude-code' } } });
		expect(r.res.statusCode).toBe(200);
		expect(r.json().sessionId).toBeTruthy();
	});

	// The agent routes must not be reachable by a page just because it is
	// same-origin — and a DNS-rebound page IS loopback, so the socket check alone
	// would not stop it. An MCP process never sends Origin; a browser always does.
	it('refuses anything carrying a browser Origin, even with the right token', async () => {
		const r = await call(mw, {
			method: 'POST', url: '/__stylewright/ai/agent/hello',
			origin: 'http://127.0.0.1:5173', swHeader: true, auth: 'Bearer ' + TOKEN, body: { cwd: root }
		});
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('browser_origin');
	});

	it('applies the rebinding host rule to the agent routes too', async () => {
		const r = await call(mw, {
			method: 'POST', url: '/__stylewright/ai/agent/hello',
			host: 'evil.com:5173', auth: 'Bearer ' + TOKEN, body: { cwd: root }
		});
		expect(r.res.statusCode).toBe(403);
		expect(r.json().error).toBe('bad_host');
	});
});

describe('overlay AI routes reject untrusted payloads', () => {
	let mw: ReturnType<typeof createStylewrightMiddleware>;
	let broker: Broker;

	beforeEach(() => {
		broker = new Broker({ root });
		mw = createStylewrightMiddleware(root, createAiRoutes({ broker, root, token: 'tok' }));
	});
	afterEach(() => broker.dispose());

	const send = (body: unknown) => call(mw, {
		method: 'POST', url: '/__stylewright/ai/send', origin: 'http://127.0.0.1:5173', swHeader: true, body
	});

	it('refuses a send whose source file escapes the project', async () => {
		const r = await send({
			prompt: 'make it blue',
			source: { file: join(outside, 'Secret.svelte') },
			element: {}, context: {}, page: {}
		});
		expect(r.res.statusCode).toBe(400);
		expect(r.json().reason).toBe('bad_file');
	});

	it('refuses an empty prompt', async () => {
		const r = await send({ prompt: '   ', source: { file: 'src/Button.svelte' }, element: {}, context: {}, page: {} });
		expect(r.json().reason).toBe('empty_prompt');
	});

	it('refuses a valid send when nothing is linked, rather than picking a session', async () => {
		broker.hello({ cwd: root, clientInfo: { name: 'claude-code' } });
		const r = await send({ prompt: 'make it blue', source: { file: 'src/Button.svelte' }, element: {}, context: {}, page: {} });
		expect(r.res.statusCode).toBe(409);
		expect(r.json().reason).toBe('no_session');
	});

	it('is not reachable cross-origin', async () => {
		const res = await call(mw, {
			method: 'POST', url: '/__stylewright/ai/send', origin: 'http://evil.example', swHeader: true,
			body: { prompt: 'x', source: { file: 'src/Button.svelte' } }
		});
		expect(res.res.statusCode).toBe(403);
	});
});
