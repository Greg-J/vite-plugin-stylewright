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
import { readRules, applyEdit, readStyle, applyStyleBlock } from './patch.js';
import type {
	SwRulesResponse,
	SwEditRequest,
	SwEditResponse,
	SwStyleResponse,
	SwStyleSaveRequest
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

export function createStylewrightMiddleware(root: string): Connect.NextHandleFunction {
	return async (req, res, next) => {
		const url = req.url || '';
		if (!url.startsWith(PREFIX)) return next();

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
				return sendJson(res, 200, { ok: true, changed: result.changed, invalid: result.invalid });
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
