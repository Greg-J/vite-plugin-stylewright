// Dev-server-only HTTP surface. Mounted as Connect middleware by the plugin's
// configureServer hook — it NEVER exists in a production build, so writing to the
// filesystem here is safe and appropriate.
//
//   GET  /__stylewright/rules?file=<path>   -> { hasStyle, rules }
//   POST /__stylewright/edit  { file, selector, prop, value } -> { changed, matched }
//   GET  /__stylewright/client.js           -> the overlay bundle (IIFE)

import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRules, applyEdit, applyRules, readStyle, applyStyleBlock } from './patch.js';
import type {
	SwRulesResponse,
	SwEditRequest,
	SwEditResponse,
	SwStyleResponse,
	SwStyleSaveRequest,
	SwApplyRequest
} from '../shared/protocol.js';

const PREFIX = '/__stylewright';

/**
 * Resolve a client-supplied path to an absolute .svelte file that lives INSIDE
 * the project root. Returns null for anything that escapes the root, isn't a
 * .svelte file, or doesn't exist — the guard against writing arbitrary files.
 */
function resolveSvelteFile(root: string, file: string): string | null {
	if (!file) return null;
	const abs = normalize(isAbsolute(file) ? file : join(root, file));
	const nRoot = normalize(root);
	// Case-insensitive compare so Windows drive-letter casing (d:\ vs D:\) can't
	// be used to dodge the root containment check.
	const a = abs.toLowerCase();
	const r = (nRoot.endsWith(sep) ? nRoot : nRoot + sep).toLowerCase();
	const within = a === nRoot.toLowerCase() || a.startsWith(r);
	if (!within) return null;
	if (!abs.toLowerCase().endsWith('.svelte')) return null;
	if (!existsSync(abs)) return null;
	return abs;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-store');
	res.end(text);
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) reject(new Error('body too large'));
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

/**
 * Same-origin guard for state-changing requests. The POST endpoints write to the
 * developer's .svelte source, so without this ANY website visited while `vite dev`
 * runs could silently overwrite/inject into source via a cross-site POST (CSRF) —
 * the write lands even though the attacker can't read the opaque response. We allow
 * the request only when:
 *   - the Origin (or Referer fallback) host matches the dev server's own Host, AND
 *   - the body is application/json — which the real overlay always sends and which
 *     forces any cross-origin attempt into a CORS preflight the browser blocks.
 * The browser sets Origin/Referer and a page cannot forge them, so a mismatch — or
 * their absence, which a genuine same-origin fetch POST never has — is refused.
 * GET reads stay open: cross-origin JS still can't read their responses (no CORS).
 */
function isCrossSiteWrite(req: Connect.IncomingMessage): boolean {
	const ct = String(req.headers['content-type'] || '').toLowerCase();
	if (!ct.includes('application/json')) return true;
	const host = req.headers.host ? String(req.headers.host) : '';
	if (!host) return true;
	const src = req.headers.origin || req.headers.referer;
	if (!src) return true;
	try {
		return new URL(String(src)).host !== host;
	} catch {
		return true;
	}
}

/**
 * Load the prebuilt overlay bundle that sits next to this file. Read fresh on
 * every request (NOT cached) so a rebuilt overlay shows up on a plain browser
 * refresh — no dev-server restart needed while iterating. The read is a single
 * small file, only on full page loads, so the cost is negligible.
 */
function loadClient(): string {
	const candidates = [
		fileURLToPath(new URL('./client.global.js', import.meta.url)),
		fileURLToPath(new URL('../dist/client.global.js', import.meta.url))
	];
	for (const p of candidates) {
		if (existsSync(p)) return readFileSync(p, 'utf8');
	}
	return 'console.warn("[stylewright] client bundle not found — run `npm run build` in the plugin.");';
}

const SCRIPT_TAG = '<script src="/__stylewright/client.js" defer></script>';

/**
 * Inject the overlay client into HTML page responses by rewriting the response.
 * `transformIndexHtml` works for plain Vite, but SvelteKit (and other SSR
 * frameworks) render their own HTML and bypass that hook — so we also splice the
 * tag in here. Idempotent: it never injects twice (skips if the tag is already
 * present, e.g. when transformIndexHtml already ran). Dev-server only.
 */
export function createHtmlInjectMiddleware(): Connect.NextHandleFunction {
	return (req, res, next) => {
		const accept = String(req.headers.accept || '');
		if (req.method !== 'GET' || res.headersSent || !accept.includes('text/html')) { next(); return; }

		const chunks: Buffer[] = [];
		const origWriteHead = res.writeHead.bind(res);
		const origWrite = res.write.bind(res);
		const origEnd = res.end.bind(res) as (data?: string | Buffer, cb?: () => void) => ServerResponse;
		const toBuf = (c: unknown): Buffer => {
			if (typeof c === 'string') return Buffer.from(c);
			if (Buffer.isBuffer(c)) return c;
			// Cross-realm safe. SvelteKit's SSR module runner renders in a SEPARATE
			// realm (Vite runs SSR in a vm context), so its streamed body chunks are
			// Uint8Arrays whose `instanceof Uint8Array` — tested against THIS realm's
			// constructor — is false. The old code then String()-ified the bytes into
			// "60,47,98,..." and shipped that as the page. ArrayBuffer.isView and
			// Symbol.toStringTag are brand checks that hold across realms.
			if (ArrayBuffer.isView(c)) {
				const v = c as ArrayBufferView;
				return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
			}
			if (Object.prototype.toString.call(c) === '[object ArrayBuffer]') return Buffer.from(c as ArrayBuffer);
			return Buffer.from(String(c));
		};
		const lastCb = (a: unknown[]): (() => void) | undefined => (typeof a[a.length - 1] === 'function' ? (a[a.length - 1] as () => void) : undefined);

		// SvelteKit calls writeHead(), which flushes headers immediately — too early to
		// rewrite content-length. Capture status + headers WITHOUT flushing; we replay
		// them through the response's own header map at end time.
		res.writeHead = ((status: number, ...args: unknown[]): ServerResponse => {
			if (typeof status === 'number') res.statusCode = status;
			for (const a of args) {
				if (Array.isArray(a)) { for (let i = 0; i + 1 < a.length; i += 2) res.setHeader(String(a[i]), a[i + 1] as number | string | readonly string[]); }
				else if (a && typeof a === 'object') { for (const [k, v] of Object.entries(a)) res.setHeader(k, v as number | string | readonly string[]); }
			}
			return res;
		}) as ServerResponse['writeHead'];

		res.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
			if (chunk != null && typeof chunk !== 'function') chunks.push(toBuf(chunk));
			lastCb(rest)?.();
			return true;
		}) as ServerResponse['write'];

		res.end = ((chunk?: unknown, ...rest: unknown[]): ServerResponse => {
			if (chunk != null && typeof chunk !== 'function') chunks.push(toBuf(chunk));
			res.writeHead = origWriteHead;
			res.write = origWrite;
			res.end = origEnd as ServerResponse['end'];
			const cb = lastCb(rest);
			const buf = Buffer.concat(chunks);
			// Inject inside a guard: a failure here must NEVER hang the response, so we
			// always fall through to writing the original body.
			try {
				const ct = String(res.getHeader('content-type') || '');
				if (!res.headersSent && ct.includes('text/html')) {
					let html = buf.toString('utf8');
					if (!html.includes('/__stylewright/client.js')) {
						html = html.includes('</body>') ? html.replace('</body>', `${SCRIPT_TAG}</body>`) : html + SCRIPT_TAG;
					}
					const out = Buffer.from(html, 'utf8');
					res.setHeader('content-length', String(out.length));
					// We rewrote the body, so the upstream validators no longer match it.
					// Drop them and forbid caching: a dev overlay must never let a stale
					// (or previously-broken) page survive in the browser across a fix or a
					// server restart — that turns a fixed bug into a "still broken" report.
					res.removeHeader('etag');
					res.removeHeader('last-modified');
					res.setHeader('cache-control', 'no-store');
					return origEnd(out, cb);
				}
			} catch { /* fall through */ }
			if (!res.headersSent) res.setHeader('content-length', String(buf.length));
			return origEnd(buf, cb);
		}) as ServerResponse['end'];

		next();
	};
}

export function createStylewrightMiddleware(root: string): Connect.NextHandleFunction {
	return async (req, res, next) => {
		const url = req.url || '';
		if (!url.startsWith(PREFIX)) return next();

		// CSRF guard: every POST under the prefix writes to source, so reject any that
		// isn't a same-origin JSON request from the dev page itself. (See isCrossSiteWrite.)
		if (req.method === 'POST' && isCrossSiteWrite(req)) {
			return sendJson(res, 403, { ok: false, changed: false, error: 'cross-site request blocked' });
		}

		// --- serve the overlay bundle ---
		if (req.method === 'GET' && url.startsWith(`${PREFIX}/client.js`)) {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/javascript');
			res.setHeader('cache-control', 'no-store');
			res.end(loadClient());
			return;
		}

		// --- list a component's rules ---
		if (req.method === 'GET' && url.startsWith(`${PREFIX}/rules`)) {
			const q = new URL(url, 'http://localhost').searchParams;
			const file = q.get('file') || '';
			const abs = resolveSvelteFile(root, file);
			if (!abs) {
				const body: SwRulesResponse = { file, hasStyle: false, rules: [], error: 'file not found in project' };
				return sendJson(res, 404, body);
			}
			try {
				const source = await readFile(abs, 'utf8');
				const { hasStyle, rules } = readRules(source);
				const body: SwRulesResponse = { file, hasStyle, rules };
				return sendJson(res, 200, body);
			} catch (err) {
				const body: SwRulesResponse = { file, hasStyle: false, rules: [], error: String(err) };
				return sendJson(res, 500, body);
			}
		}

		// --- read a component's whole <style> (code-editor model) ---
		if (req.method === 'GET' && url.startsWith(`${PREFIX}/style`)) {
			const q = new URL(url, 'http://localhost').searchParams;
			const file = q.get('file') || '';
			const abs = resolveSvelteFile(root, file);
			if (!abs) {
				const body: SwStyleResponse = { file, hasStyle: false, css: '', error: 'file not found in project' };
				return sendJson(res, 404, body);
			}
			try {
				const source = await readFile(abs, 'utf8');
				const { hasStyle, css } = readStyle(source);
				const body: SwStyleResponse = { file, hasStyle, css };
				return sendJson(res, 200, body);
			} catch (err) {
				const body: SwStyleResponse = { file, hasStyle: false, css: '', error: String(err) };
				return sendJson(res, 500, body);
			}
		}

		// --- save a component's whole <style> ---
		if (req.method === 'POST' && url.startsWith(`${PREFIX}/style`)) {
			let save: SwStyleSaveRequest;
			try {
				save = JSON.parse(await readBody(req));
			} catch {
				return sendJson(res, 400, { ok: false, changed: false, error: 'invalid json' });
			}
			const abs = resolveSvelteFile(root, save?.file);
			if (!abs || typeof save.css !== 'string') {
				return sendJson(res, 400, { ok: false, changed: false, error: 'bad request' });
			}
			try {
				const source = await readFile(abs, 'utf8');
				const result = applyStyleBlock(source, save.css);
				if (result.changed) await writeFile(abs, result.code, 'utf8');
				return sendJson(res, 200, { ok: true, changed: result.changed, invalid: result.invalid, droppedAtRules: result.droppedAtRules, unsafe: result.unsafe });
			} catch (err) {
				return sendJson(res, 500, { ok: false, changed: false, error: String(err) });
			}
		}

		// --- structure-preserving save (postcss reconcile, preserves at-rules) ---
		if (req.method === 'POST' && url.startsWith(`${PREFIX}/apply`)) {
			let body: SwApplyRequest;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				return sendJson(res, 400, { ok: false, changed: false, error: 'invalid json' });
			}
			const abs = resolveSvelteFile(root, body?.file);
			if (!abs || !Array.isArray(body.rules)) {
				return sendJson(res, 400, { ok: false, changed: false, error: 'bad request' });
			}
			try {
				const source = await readFile(abs, 'utf8');
				const result = applyRules(source, body.rules, { removeIds: body.removeIds, mediaRenames: body.mediaRenames });
				if (result.changed) await writeFile(abs, result.code, 'utf8');
				return sendJson(res, 200, { ok: true, changed: result.changed, matched: result.matched, created: result.created, removed: result.removed, renamed: result.renamed });
			} catch (err) {
				return sendJson(res, 500, { ok: false, changed: false, error: String(err) });
			}
		}

		// --- apply an edit ---
		if (req.method === 'POST' && url.startsWith(`${PREFIX}/edit`)) {
			let edit: SwEditRequest;
			try {
				edit = JSON.parse(await readBody(req));
			} catch {
				return sendJson(res, 400, { ok: false, changed: false, matched: false, error: 'invalid json' });
			}
			const abs = resolveSvelteFile(root, edit?.file);
			if (!abs || !edit.selector || !edit.prop) {
				return sendJson(res, 400, { ok: false, changed: false, matched: false, error: 'bad request' });
			}
			try {
				const source = await readFile(abs, 'utf8');
				const result = applyEdit(source, edit);
				if (result.changed) await writeFile(abs, result.code, 'utf8');
				const body: SwEditResponse = { ok: true, changed: result.changed, matched: result.matched };
				return sendJson(res, 200, body);
			} catch (err) {
				return sendJson(res, 500, { ok: false, changed: false, matched: false, error: String(err) });
			}
		}

		return next();
	};
}
