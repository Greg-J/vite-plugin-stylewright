// HTTP surface for the AI path, mounted under /__stylewright/ai.
//
// Two audiences with two different gates:
//   /ai/*        the overlay. Same-origin browser rules (see guard.ts).
//   /ai/agent/*  a local MCP process. Loopback socket + the dev.json token.
//
// Nothing here writes a file. The only filesystem touch is validating that the
// component path an overlay claims to be editing really is a .svelte file inside
// the project — so we never hand an agent a path we would not open ourselves.

import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import type { Broker } from './broker.js';
import type { SwAiRequest, SwAiState, SwAgentReport } from '../../shared/protocol.js';
import { SW_AI_LIMITS } from '../../shared/protocol.js';
import { resolveSvelteFile } from '../paths.js';
import { guardBrowserRequest, guardAgentRequest, refuse } from '../guard.js';

const MAX_BODY = 512 * 1024;
/** Long-poll ceilings. `claim` is generous because Claude Code moves a tool call
 *  that outlives ~2 minutes to a background task and delivers the result as a
 *  task notification — which is exactly the wake-up this design wants. */
const CLAIM_MAX_MS = 1_800_000;
const PING_MAX_MS = 30_000;
const SSE_HEARTBEAT_MS = 15_000;

/** Can this response still reach the client? A long-poll's socket can die at any
 *  point during the wait, and writing to it afterwards is a silent no-op. */
function isWritable(res: ServerResponse): boolean {
	return !res.writableEnded && !res.destroyed && res.writable !== false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(body));
}

/** Buffer with a hard cap, decoding once at the end so a multi-byte character
 *  split across a TCP chunk boundary isn't mangled into U+FFFD. */
function readBody(req: Connect.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		let len = 0;
		let stopped = false;
		req.on('data', (chunk: Buffer | string) => {
			if (stopped) return;
			const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			len += b.length;
			if (len > MAX_BODY) { stopped = true; reject(new Error('body too large')); req.destroy(); return; }
			parts.push(b);
		});
		req.on('end', () => { if (!stopped) resolve(Buffer.concat(parts).toString('utf8')); });
		req.on('error', reject);
	});
}

async function readJson<T>(req: Connect.IncomingMessage): Promise<T | null> {
	try { return JSON.parse(await readBody(req)) as T; } catch { return null; }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Re-build the request from untrusted input rather than passing it through.
 * Whatever the overlay sends, the agent receives a value of exactly this shape
 * and these sizes — an allowlist, so a field we forgot to think about cannot
 * ride along into an agent's context window.
 */
function sanitizeRequest(raw: unknown, root: string): { req: SwAiRequest } | { error: string } {
	if (!raw || typeof raw !== 'object') return { error: 'bad_request' };
	const r = raw as Record<string, any>;

	const prompt = str(r.prompt, SW_AI_LIMITS.prompt).trim();
	if (!prompt) return { error: 'empty_prompt' };

	const file = str(r.source?.file, 1024);
	if (!resolveSvelteFile(root, file)) return { error: 'bad_file' };

	const el = r.element || {};
	const ctx = r.context || {};
	const pg = r.page || {};

	const rules = Array.isArray(ctx.styleRules) ? ctx.styleRules.slice(0, SW_AI_LIMITS.styleRules) : undefined;
	const computed: Record<string, string> = {};
	if (ctx.computed && typeof ctx.computed === 'object') {
		for (const [k, v] of Object.entries(ctx.computed).slice(0, 40)) computed[str(k, 60)] = str(v, 200);
	}

	return {
		req: {
			id: str(r.id, 64) || cryptoId(),
			createdAt: num(r.createdAt) ?? Date.now(),
			prompt,
			source: {
				file,
				componentName: str(r.source?.componentName, 120) || undefined,
				line: num(r.source?.line),
				column: num(r.source?.column)
			},
			element: {
				tag: str(el.tag, 400),
				tagName: str(el.tagName, 40),
				id: str(el.id, 120) || undefined,
				classList: Array.isArray(el.classList) ? el.classList.slice(0, 40).map((c: unknown) => str(c, 80)) : [],
				selector: str(el.selector, 400),
				text: str(el.text, SW_AI_LIMITS.elementText) || undefined,
				rect: { width: num(el.rect?.width) ?? 0, height: num(el.rect?.height) ?? 0 }
			},
			context: {
				outerHTML: str(ctx.outerHTML, SW_AI_LIMITS.outerHTML),
				parentTag: str(ctx.parentTag, 200) || undefined,
				styleRules: rules,
				computed: Object.keys(computed).length ? computed : undefined
			},
			page: {
				route: str(pg.route, 512),
				url: str(pg.url, 1024),
				viewport: {
					width: num(pg.viewport?.width) ?? 0,
					height: num(pg.viewport?.height) ?? 0,
					dpr: num(pg.viewport?.dpr) ?? 1
				},
				breakpoint: num(pg.breakpoint),
				colorScheme: pg.colorScheme === 'light' ? 'light' : 'dark'
			}
		}
	};
}

function cryptoId(): string {
	return 'sw-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface AiRoutesOptions {
	broker: Broker;
	root: string;
	token: string;
}

/**
 * Returns a handler for everything under `<prefix>/ai`. Resolves true when it
 * handled the request, false when the caller should fall through.
 */
export function createAiRoutes(opts: AiRoutesOptions) {
	const { broker, root, token } = opts;

	return async function handleAi(req: Connect.IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
		const method = req.method || 'GET';
		const isAgent = path.startsWith('/agent/');

		// --- gate ---
		if (isAgent) {
			const g = guardAgentRequest(req, token);
			if (!g.ok) { refuse(res, g); return true; }
		} else {
			const g = guardBrowserRequest(req, method !== 'GET');
			if (!g.ok) { refuse(res, g); return true; }
		}

		const ok = (s: SwAiState): void => sendJson(res, 200, s);

		// ---------- overlay-facing ----------

		if (path === '/state' && method === 'GET') { ok(broker.state()); return true; }

		if (path === '/events' && method === 'GET') {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/event-stream');
			res.setHeader('cache-control', 'no-store');
			res.setHeader('connection', 'keep-alive');
			// Proxies in front of a dev server love to buffer SSE. This disables it.
			res.setHeader('x-accel-buffering', 'no');
			const write = (s: SwAiState): void => {
				try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch { /* client went away */ }
			};
			const off = broker.subscribe(write);
			const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, SSE_HEARTBEAT_MS);
			hb.unref?.();
			const close = (): void => { clearInterval(hb); off(); };
			req.on('close', close);
			req.on('error', close);
			return true;
		}

		if (path === '/link' && method === 'POST') {
			const body = await readJson<{ sessionId?: string }>(req);
			ok(broker.link(str(body?.sessionId, 64)));
			return true;
		}

		if (path === '/unlink' && method === 'POST') { ok(broker.unlink()); return true; }
		if (path === '/refresh' && method === 'POST') { ok(broker.refresh()); return true; }
		if (path === '/clear' && method === 'POST') { ok(broker.clearCurrent()); return true; }

		if (path === '/send' && method === 'POST') {
			const raw = await readJson<unknown>(req);
			const built = sanitizeRequest(raw, root);
			if ('error' in built) { sendJson(res, 400, { ok: false, reason: built.error }); return true; }
			const r = broker.send(built.req);
			if (!r.ok) { sendJson(res, 409, { ok: false, reason: r.reason }); return true; }
			sendJson(res, 200, { ok: true, requestId: built.req.id, status: r.status });
			return true;
		}

		if (path === '/cancel' && method === 'POST') {
			const body = await readJson<{ requestId?: string }>(req);
			broker.cancel(str(body?.requestId, 64));
			// Always answer with a state snapshot, like every other overlay route.
			// A refusal shape here would be assigned straight into the panel's `ai`
			// field and blank the whole session list.
			ok(broker.state());
			return true;
		}

		// ---------- MCP-facing ----------

		if (path === '/agent/hello' && method === 'POST') {
			const body = await readJson<{ clientInfo?: { name?: string }; cwd?: string; name?: string }>(req);
			if (!body) { sendJson(res, 400, { error: 'invalid json' }); return true; }
			sendJson(res, 200, broker.hello({
				clientInfo: { name: str(body.clientInfo?.name, 64) },
				cwd: str(body.cwd, 1024),
				name: str(body.name, 40)
			}));
			return true;
		}

		if (path === '/agent/claim' && method === 'POST') {
			const body = await readJson<{ sessionId?: string; timeoutMs?: number }>(req);
			const sessionId = str(body?.sessionId, 64);
			const timeoutMs = Math.min(num(body?.timeoutMs) ?? CLAIM_MAX_MS, CLAIM_MAX_MS);

			// Watch the RESPONSE, not just the request. By the time we get here the
			// request body is fully consumed, so `req` may already have emitted
			// 'close' and a listener attached now would never fire — which left a
			// dead agent looking like it was still watching, and the next Send got
			// handed to a socket nobody was reading.
			const onGone = (): void => broker.abandonClaim(sessionId);
			res.on('close', onGone);
			req.on('aborted', onGone);

			const out = await broker.claim(sessionId, timeoutMs);
			res.off?.('close', onGone);
			req.off?.('aborted', onGone);

			// Belt and braces: if the claim resolved with work but the socket cannot
			// be written to, the agent never received it. Put it back rather than
			// letting the overlay wait forever on a run that never started.
			if (!isWritable(res)) {
				if (out.status === 'request') broker.requeue(out.request);
				return true;
			}
			sendJson(res, 200, out);
			return true;
		}

		if (path === '/agent/ping' && method === 'POST') {
			const body = await readJson<{ sessionId?: string; timeoutMs?: number }>(req);
			const sessionId = str(body?.sessionId, 64);
			const timeoutMs = Math.min(num(body?.timeoutMs) ?? PING_MAX_MS, PING_MAX_MS);
			const onGone = (): void => broker.abandonPing(sessionId);
			res.on('close', onGone);
			req.on('aborted', onGone);
			const { known } = await broker.ping(sessionId, timeoutMs);
			res.off?.('close', onGone);
			req.off?.('aborted', onGone);
			// `known:false` means this dev server has never heard of the session —
			// it restarted under a still-running agent. Telling the agent is what
			// lets it re-register instead of pinging an id nobody recognises.
			if (isWritable(res)) sendJson(res, 200, known ? { ok: true } : { ok: false, reason: 'unknown_session' });
			return true;
		}

		if (path === '/agent/report' && method === 'POST') {
			const body = await readJson<SwAgentReport & { sessionId?: string }>(req);
			if (!body) { sendJson(res, 400, { error: 'invalid json' }); return true; }
			const status = body.status;
			if (status !== 'working' && status !== 'needs_input' && status !== 'done' && status !== 'error') {
				sendJson(res, 400, { ok: false, reason: 'bad_status' });
				return true;
			}
			const files = Array.isArray(body.filesTouched)
				? body.filesTouched.slice(0, 50).map((f) => ({
					path: str(f?.path, 512),
					mark: (f?.mark === 'A' || f?.mark === 'D' ? f.mark : 'M') as 'M' | 'A' | 'D',
					note: str(f?.note, 60) || undefined
				}))
				: undefined;
			const r = broker.report(str(body.sessionId, 64), str(body.requestId, 64), status, body.message, files);
			sendJson(res, r.ok ? 200 : 409, r);
			return true;
		}

		// An agent that was handed a request it cannot act on (its tool call was
		// cancelled mid-flight) gives it back rather than dropping it. Losing work
		// here would leave the overlay on "working" for a run nobody ever saw.
		if (path === '/agent/release' && method === 'POST') {
			const body = await readJson<{ requestId?: string }>(req);
			const id = str(body?.requestId, 64);
			const released = broker.release(id);
			sendJson(res, 200, { ok: released });
			return true;
		}

		if (path === '/agent/list_pending' && method === 'POST') {
			const body = await readJson<{ sessionId?: string }>(req);
			sendJson(res, 200, broker.listPending(str(body?.sessionId, 64)));
			return true;
		}

		if (path === '/agent/bye' && method === 'POST') {
			const body = await readJson<{ sessionId?: string }>(req);
			broker.bye(str(body?.sessionId, 64));
			sendJson(res, 200, { ok: true });
			return true;
		}

		sendJson(res, 404, { ok: false, error: 'unknown ai route' });
		return true;
	};
}
