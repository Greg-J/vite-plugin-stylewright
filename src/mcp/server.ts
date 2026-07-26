// The Stylewright MCP server: one process per agent session, stdio transport.
//
// Deliberately dependency-free. MCP over stdio is newline-delimited JSON-RPC 2.0,
// and a dev-only plugin whose entire runtime today is postcss + magic-string
// should not grow an SDK (and an SDK's release cadence) to speak three methods.
//
// This process is a thin client of the dev server's broker. It holds no queue and
// makes no decisions; it registers a session, keeps a socket open so the browser
// can tell the session is alive, and relays claims and reports.

import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { discover, NO_SERVER_MESSAGE, ambiguousMessage, AmbiguousServers, type Discovered } from './discover.js';
import { vendorForClient, VENDORS } from '../shared/vendors.js';
import type { SwAgentClaimResponse, SwAiRequest } from '../shared/protocol.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[0];

/**
 * A single HTTP claim is capped well under undici's 300 s headers timeout — a
 * 30-minute fetch would die with UND_ERR_HEADERS_TIMEOUT rather than wait. The
 * tool call loops these until the caller's own deadline, so the agent still sees
 * one long call.
 */
const HTTP_CLAIM_MS = 240_000;

/**
 * How often a blocking watch emits `notifications/progress`.
 *
 * This is not cosmetic. An MCP client that passes `resetTimeoutOnProgress` to
 * its callTool — OpenCode does — restarts its request timer on every progress
 * notification, so a watch that heartbeats faster than the client's timeout
 * cannot be killed by it. Ten seconds sits inside the shortest default any
 * client is known to ship (~30s) with room to spare. Clients that ignore
 * progress are unaffected: it is a notification, so nothing waits on it.
 */
const PROGRESS_EVERY_MS = 10_000;
const PING_MS = 25_000;

/**
 * How long one `stylewright_watch` call waits, per client — because the clients
 * disagree about what a long tool call means.
 *
 * Claude Code moves a call still running after ~2 minutes to a background task
 * and delivers the result as a task notification, so a long wait is free and is
 * the intended shape.
 *
 * Cline instead kills the call at its per-server `timeout`, which defaults to
 * 60 SECONDS. A 25-minute watch there is not "patient", it is a call that never
 * returns: Cline gives up, and any request that arrives afterwards is handed to
 * a tool call nobody is listening to. So on Cline we stay comfortably inside the
 * default and re-arm, which costs one HTTP round trip a minute.
 */
// Per-client budgets live in the shared vendor table (src/shared/vendors.ts), so
// adding an agent does not mean remembering to update this file too.
const DEFAULT_WATCH_MS = 1_500_000;
/** Never hold a claim past this without checking in, whatever the client asked. */
const UNKNOWN_CLIENT_WATCH_MS = 55_000;

/**
 * Explicit override, set alongside the client's own tool timeout so the two
 * cannot drift. Without it the Cline default has to assume the WORST case (a
 * 60 s tool timeout), which means re-arming every 50 seconds even for someone
 * who configured 600 — and every lapse is a turn ending and a human retyping
 * "watch for Stylewright edits".
 */
/**
 * The longest watch anyone may ask for.
 *
 * Derived from the vendor table rather than picked, because the generated
 * configs set STYLEWRIGHT_WATCH_MS to `configuredWatchMs` — a fixed ceiling
 * below that silently caps the very value we just told the user to paste, and
 * the watch then ends long before the tool timeout it was matched to.
 */
const MAX_WATCH_MS = Math.max(DEFAULT_WATCH_MS, ...VENDORS.map((v) => v.configuredWatchMs));

function envWatchMs(): number | null {
	const raw = Number(process.env.STYLEWRIGHT_WATCH_MS);
	if (!Number.isFinite(raw) || raw <= 0) return null;
	return Math.min(Math.max(raw, 5_000), MAX_WATCH_MS);
}

interface Rpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any }

const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

const WATCH_DESCRIPTION =
	'Claim the next visual edit request from the Stylewright browser overlay. The user clicked a ' +
	'specific element in their running app and typed an instruction for you.\n\n' +
	'Call this as soon as the user asks you to watch for Stylewright edits, and call it again after ' +
	'each request you finish — claim → edit → report(done) → claim again.\n\n' +
	'It blocks until a request arrives, and returns {"status":"idle"} on timeout (call again to keep ' +
	'watching). In Claude Code a call still running after ~2 minutes moves to a background task and ' +
	'the payload arrives as a task notification, so a long timeout costs you nothing and is the ' +
	'intended way to use this.\n\n' +
	'On receiving a request: make the change in the named source file, using the supplied element and ' +
	'style-rule context. The styleRules field is the component\'s REAL parsed CSS including its @media ' +
	'chain — use it to find the exact rule to modify instead of guessing. Prefer editing the existing ' +
	'component over creating files. Then call stylewright_report with status "done" and the files you ' +
	'touched. If you must ask the user something, call stylewright_report with status "needs_input" ' +
	'FIRST, then ask in this session.';

const INSTRUCTIONS =
	'Stylewright connects this session to the user\'s running app in the browser. When they select an ' +
	'element in the Stylewright overlay and type an instruction, it arrives here as a request.\n\n' +
	'To receive requests you must call stylewright_watch — nothing is pushed to you. If the user says ' +
	'anything like "watch for Stylewright edits", call stylewright_watch immediately and keep the loop ' +
	'going: claim → edit → stylewright_report(done) → claim again.';

export class StylewrightMcpServer {
	private dev: Discovered | null = null;
	private sessionId = '';
	private sessionName = '';
	private running = true;
	private pingTimer: ReturnType<typeof setTimeout> | null = null;
	private pingGeneration = 0;
	private out: (s: string) => void;
	/** In-flight registration, so a tools/call racing initialize waits for it
	 *  instead of registering a second session. */
	private registering: Promise<void> | null = null;
	/** Last discovery failure, surfaced verbatim to the agent. */
	private lastDiscoveryError: string | null = null;
	/** JSON-RPC ids of tool calls the client has cancelled. */
	private cancelled = new Set<string>();
	/** In-flight claim fetches, so a cancellation can actually abort one rather
	 *  than let it run on holding a claim the agent will never read. */
	private inFlight = new Map<string, AbortController>();
	/** Normalised client name from initialize — decides how long we may block. */
	private clientKind = '';
	/** Client name from initialize, kept so a reconnect re-registers as itself. */
	private clientName = 'MCP client';
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 2_000;

	constructor(out: (s: string) => void = (s) => process.stdout.write(s)) {
		this.out = out;
	}

	// ---------- transport ----------

	private send(msg: Rpc): void {
		this.out(JSON.stringify(msg) + '\n');
	}
	/** Diagnostics go to stderr, never stdout — stdout is the protocol channel and
	 *  one stray line corrupts it. Both Claude Code and Cline show stderr in their
	 *  MCP server logs, which is where someone looks when a session never appears. */
	private warn(msg: string): void {
		try { process.stderr.write(`[stylewright] ${msg}\n`); } catch { /* ignore */ }
	}
	private reply(id: number | string | undefined, result: unknown): void {
		if (id === undefined) return; // a notification has no reply
		this.send({ jsonrpc: '2.0', id, result });
	}
	private fail(id: number | string | undefined, code: number, message: string): void {
		if (id === undefined) return;
		this.send({ jsonrpc: '2.0', id, error: { code, message } });
	}
	/** MCP tool results are content blocks; `isError` is how a tool reports a
	 *  failure the model should read and act on (as opposed to a protocol error). */
	private toolResult(id: number | string | undefined, text: string, isError = false): void {
		this.reply(id, { content: [{ type: 'text', text }], isError });
	}

	async handleLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg: Rpc;
		try { msg = JSON.parse(trimmed); } catch { return; } // a malformed frame is not ours to answer
		try {
			await this.dispatch(msg);
		} catch (err) {
			this.fail(msg.id, -32603, `internal error: ${String(err)}`);
		}
	}

	private async dispatch(msg: Rpc): Promise<void> {
		switch (msg.method) {
			case 'initialize': return this.onInitialize(msg);
			case 'notifications/initialized': return;
			case 'notifications/cancelled': {
				// A cancelled watch must actually stop. Left running it keeps its claim
				// open, is handed the next request, and drops it on the floor — the
				// overlay would show "working" for a run nobody ever saw. Flagging it is
				// not enough: the loop is parked inside a long fetch and would not look
				// at the flag for minutes, so abort the socket as well. The dev server
				// sees it close and re-queues anything already handed over.
				const id = msg.params?.requestId;
				if (id === undefined) return;
				const key = String(id);
				this.cancelled.add(key);
				this.inFlight.get(key)?.abort();
				return;
			}
			case 'ping': return this.reply(msg.id, {});
			case 'tools/list': return this.onToolsList(msg);
			case 'tools/call': return this.onToolsCall(msg);
			case 'resources/list': return this.reply(msg.id, { resources: [] });
			case 'prompts/list': return this.reply(msg.id, { prompts: [] });
			default:
				if (msg.id !== undefined) this.fail(msg.id, -32601, `method not found: ${msg.method}`);
		}
	}

	// ---------- lifecycle ----------

	private async onInitialize(msg: Rpc): Promise<void> {
		const asked = String(msg.params?.protocolVersion || '');
		const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL;
		const clientName = String(msg.params?.clientInfo?.name || 'MCP client');
		this.clientName = clientName;
		this.clientKind = clientName.toLowerCase();

		this.reply(msg.id, {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'stylewright', version: '0.1.0' },
			instructions: INSTRUCTIONS
		});

		// Register with the dev server AFTER replying, so a slow or absent dev
		// server can never stall the client's initialize. The promise is kept so a
		// tools/call arriving immediately can await it rather than racing it.
		this.registering = this.register(clientName).finally(() => { this.registering = null; });
		void this.registering.catch(() => undefined);
	}

	private async register(clientName: string): Promise<void> {
		const cwd = process.cwd();
		this.lastDiscoveryError = null;
		try {
			this.dev = await discover(cwd);
		} catch (err) {
			this.dev = null;
			this.lastDiscoveryError = err instanceof AmbiguousServers ? ambiguousMessage(err.roots) : String(err);
			return;
		}
		// stdout is the JSON-RPC channel, so every diagnostic goes to stderr — which
		// is exactly where Claude Code and Cline surface MCP server logs. A session
		// that silently fails to register is the worst outcome here: the overlay
		// shows an empty list and the user has nothing at all to go on.
		if (!this.dev) {
			this.warn(this.lastDiscoveryError || NO_SERVER_MESSAGE);
			this.scheduleReconnect();   // the dev server may simply not be up YET
			return;
		}
		try {
			const r = await this.post<{ sessionId: string; name: string }>('/hello', {
				clientInfo: { name: clientName },
				cwd,
				name: process.env.STYLEWRIGHT_SESSION_NAME || '',
				// So the overlay can say how long a watch actually lasts here rather
				// than claiming "once per session is enough" at every client.
				watchMs: this.watchBudget()
			});
			this.sessionId = r.sessionId;
			this.sessionName = r.name || basename(cwd);
			this.warn(`connected to ${this.dev.origin} (root ${this.dev.root}) as "${this.sessionName}" — link it in the Stylewright overlay`);
			this.pingLoop();
		} catch (err) {
			this.warn(`found a dev server at ${this.dev?.origin} but could not register: ${String(err)}`);
			// Forget the endpoint so the next tool call rediscovers instead of
			// retrying a dead or re-keyed server forever.
			this.forgetServer();
		}
	}

	/** Drop the cached endpoint + session so the next call re-runs discovery. The
	 *  dev server mints a NEW token on every start, so a cached one is not merely
	 *  stale after a restart — it is wrong, and every request 401s. */
	private forgetServer(): void {
		const had = !!this.dev;
		this.dev = null;
		this.sessionId = '';
		this.pingGeneration++;            // orphan any in-flight ping chain
		if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
		if (had) this.warn('lost the dev server (it probably restarted) — reconnecting in the background');
		this.scheduleReconnect();
	}

	/**
	 * Keep trying to re-register in the background.
	 *
	 * A dev server restarts constantly — a config change, a crash, a plain Ctrl-C
	 * and `npm run dev`. Each restart mints a new token, so every agent process
	 * still running holds a credential that now 401s. Without this the session
	 * simply vanishes from the overlay and never returns until the user happens to
	 * trigger a tool call inside their agent, which is indistinguishable from
	 * "the MCP server is broken".
	 */
	private scheduleReconnect(): void {
		if (!this.running || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.running) return;
			void this.register(this.clientName).then(() => {
				if (this.dev && this.sessionId) { this.reconnectDelay = 2_000; return; }
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
				this.scheduleReconnect();
			});
		}, this.reconnectDelay);
		this.reconnectTimer.unref?.();
	}

	/**
	 * Keep exactly one socket open at all times. The browser's chip flips the
	 * moment this socket dies, which is the only way a `kill -9` on this process
	 * is distinguishable from a session that is merely idle.
	 */
	private pingLoop(): void {
		if (!this.running || !this.dev || !this.sessionId) return;
		const gen = this.pingGeneration;
		const alive = (): boolean => this.running && gen === this.pingGeneration;
		const again = (ms: number): void => {
			if (!alive()) return;
			this.pingTimer = setTimeout(() => this.pingLoop(), ms);
			this.pingTimer.unref?.();
		};
		// The fetch budget must OUTLAST the long-poll it is asking the server to
		// hold, or every keepalive aborts client-side and the "one socket always
		// open" property this design relies on quietly never holds.
		void this.post<{ ok: boolean; reason?: string }>('/ping', { sessionId: this.sessionId, timeoutMs: PING_MS }, PING_MS + 5_000)
			.then((r) => {
				// A dev server that does not recognise us has restarted. Re-register
				// rather than keep pinging an id it will never acknowledge.
				if (r && r.ok === false) { if (alive()) this.forgetServer(); return; }
				again(50);
			})
			.catch(() => { if (alive()) { this.forgetServer(); } });
	}

	/** Idempotent: runStdio wires it to several exit paths that can overlap. */
	async shutdown(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.pingGeneration++;
		if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		if (this.dev && this.sessionId) {
			try { await this.post('/bye', { sessionId: this.sessionId }, 2000); } catch { /* best effort */ }
		}
	}

	// ---------- broker HTTP ----------

	private async post<T>(path: string, body: unknown, timeoutMs = 10_000, ac = new AbortController()): Promise<T> {
		if (!this.dev) throw new Error('no dev server');
		const t = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await fetch(`${this.dev.origin}/__stylewright/ai/agent${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${this.dev.token}` },
				body: JSON.stringify(body),
				signal: ac.signal
			});
			if (res.status === 401 || res.status === 403) {
				// The dev server restarted and re-keyed. Nothing we hold is valid.
				this.forgetServer();
				throw new Error(`${path} → HTTP ${res.status} (dev server re-keyed; re-registering)`);
			}
			if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
			return (await res.json()) as T;
		} finally {
			clearTimeout(t);
		}
	}

	/**
	 * Re-discover if we are not registered — either never were, or the dev server
	 * restarted under us and forgetServer() cleared the cache. Concurrent callers
	 * share one attempt: two tool calls arriving together must not produce two
	 * sessions (and two competing ping loops) in the overlay's list.
	 */
	private async ensureRegistered(): Promise<boolean> {
		if (this.registering) await this.registering.catch(() => undefined);
		if (this.dev && this.sessionId) return true;
		this.registering = this.register('MCP client').finally(() => { this.registering = null; });
		await this.registering.catch(() => undefined);
		return !!(this.dev && this.sessionId);
	}

	/** The message a tool returns when there is nothing to talk to. */
	private noServerText(): string {
		return this.lastDiscoveryError || NO_SERVER_MESSAGE;
	}

	/** How long this client will tolerate one blocking call. See WATCH_MS_BY_CLIENT. */
	private watchBudget(): number {
		// An explicit override always wins: it is written into the generated config
		// alongside that client's own tool timeout, so the two cannot drift.
		const explicit = envWatchMs();
		if (explicit) return explicit;
		const vendor = vendorForClient(this.clientKind);
		if (vendor) return vendor.safeWatchMs;
		// An unknown client is assumed to have a short, MCP-typical timeout: a wait
		// that is too short only costs a re-arm, one that is too long loses requests.
		return this.clientKind ? UNKNOWN_CLIENT_WATCH_MS : DEFAULT_WATCH_MS;
	}

	// ---------- tools ----------

	private onToolsList(msg: Rpc): void {
		this.reply(msg.id, {
			tools: [
				{
					name: 'stylewright_watch',
					description: WATCH_DESCRIPTION,
					inputSchema: {
						type: 'object',
						properties: {
							timeoutMs: { type: 'number', description: `Max wait in ms. Default ${DEFAULT_WATCH_MS}.` }
						}
					}
				},
				{
					name: 'stylewright_report',
					description:
						'Report progress on a Stylewright request back to the browser overlay. The overlay shows ONLY ' +
						'what you report — it never guesses from file changes or timers, so a request you do not ' +
						'report on stays "working" forever. Call it with "done" and the files you touched when the ' +
						'change is in, or "needs_input" BEFORE you ask the user a question.',
					inputSchema: {
						type: 'object',
						properties: {
							requestId: { type: 'string', description: 'The id from stylewright_watch.' },
							status: { type: 'string', enum: ['working', 'needs_input', 'done', 'error'] },
							message: { type: 'string', description: 'One short line shown to the user on error.' },
							filesTouched: {
								type: 'array',
								description: 'Files you changed.',
								items: {
									type: 'object',
									properties: {
										path: { type: 'string' },
										mark: { type: 'string', enum: ['M', 'A', 'D'] },
										note: { type: 'string', description: 'e.g. "+22 −4"' }
									},
									required: ['path', 'mark']
								}
							}
						},
						required: ['requestId', 'status']
					}
				},
				{
					name: 'stylewright_list_pending',
					description: 'Non-blocking peek at how many Stylewright requests are waiting, and whether this session is the linked one.',
					inputSchema: { type: 'object', properties: {} }
				}
			]
		});
	}

	private async onToolsCall(msg: Rpc): Promise<void> {
		const name = String(msg.params?.name || '');
		const args = msg.params?.arguments || {};

		if (!(await this.ensureRegistered())) {
			this.toolResult(msg.id, this.noServerText(), true);
			return;
		}

		if (name === 'stylewright_watch') {
			const budget = this.watchBudget();
			const asked = Number(args.timeoutMs);
			// An explicit ask is honoured up to the client's own ceiling; NaN, zero and
			// negatives fall back rather than becoming a hot loop.
			const ms = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_WATCH_MS) : budget;
			// Present only when the client asked to be kept informed. Sending progress
			// for a token the client never issued is a protocol error on some clients,
			// so absence means silence.
			const token = (msg.params?._meta as { progressToken?: string | number } | undefined)?.progressToken;
			return this.callWatch(msg.id, ms, token);
		}
		if (name === 'stylewright_report') return this.callReport(msg.id, args);
		if (name === 'stylewright_list_pending') return this.callListPending(msg.id);
		this.toolResult(msg.id, `Unknown tool: ${name}`, true);
	}

	private async callWatch(id: number | string | undefined, timeoutMs: number, progressToken?: string | number): Promise<void> {
		const key = String(id);
		const deadline = Date.now() + Math.max(1000, timeoutMs);
		const stopBeat = this.startProgress(progressToken, deadline);
		try {
			await this.watchLoop(id, key, deadline);
		} finally {
			stopBeat();
		}
	}

	/**
	 * Heartbeat for the duration of a blocking call. Returns a stop function.
	 * A no-op when the client did not supply a progress token.
	 */
	private startProgress(token: string | number | undefined, deadline: number): () => void {
		if (token === undefined || token === null) return () => undefined;
		const started = Date.now();
		const total = Math.max(1, deadline - started);
		const timer = setInterval(() => {
			if (!this.running) return;
			const elapsed = Date.now() - started;
			this.send({
				jsonrpc: '2.0',
				method: 'notifications/progress',
				// `progress` must strictly increase; `total` lets a client render it
				// as a bar rather than a spinner.
				params: { progressToken: token, progress: Math.min(elapsed, total), total, message: 'Waiting for a Stylewright request' }
			});
		}, PROGRESS_EVERY_MS);
		// Never hold the process open on the heartbeat alone.
		timer.unref?.();
		return () => clearInterval(timer);
	}

	private async watchLoop(id: number | string | undefined, key: string, deadline: number): Promise<void> {
		let backoff = 0;
		while (this.running && Date.now() < deadline) {
			// The client can cancel a long tool call; if we ignored that and kept the
			// claim open, the next request would be handed to a call whose result
			// nobody will ever read.
			if (this.cancelled.has(key)) { this.cancelled.delete(key); return; }

			const slice = Math.min(HTTP_CLAIM_MS, deadline - Date.now());
			const startedAt = Date.now();
			let out: SwAgentClaimResponse;
			const ac = new AbortController();
			this.inFlight.set(key, ac);
			try {
				out = await this.post<SwAgentClaimResponse>('/claim', { sessionId: this.sessionId, timeoutMs: slice }, slice + 15_000, ac);
			} catch (err) {
				// An abort here is the cancellation path, not a failure — and the dev
				// server has already re-queued anything it had handed us.
				if (this.cancelled.has(key)) { this.cancelled.delete(key); return; }
				this.toolResult(id, `Lost contact with the Stylewright dev server (${String(err)}). It may have restarted — call stylewright_watch again.`, true);
				return;
			} finally {
				this.inFlight.delete(key);
			}
			if (this.cancelled.has(key)) {
				this.cancelled.delete(key);
				// We won the race: the payload arrived just as the call was cancelled.
				// Hand it back rather than dropping it — nobody will read our result.
				if (out.status === 'request') {
					try { await this.post('/release', { sessionId: this.sessionId, requestId: out.request.id }); } catch { /* best effort */ }
				}
				return;
			}

			if (out.status === 'request') { this.toolResult(id, renderRequest(out.request)); return; }
			if (out.status === 'not_bound') {
				this.toolResult(id,
					`This session ("${this.sessionName}") is connected but the user has not linked it in the Stylewright overlay` +
					(out.boundName ? `; they currently have "${out.boundName}" linked.` : '.') +
					'\nAsk them to click the session chip in the overlay and press Link, then call stylewright_watch again.', true);
				return;
			}

			// `idle` means two different things: "nothing arrived in `slice` ms"
			// (which took the full slice) and "I do not know this session" (which
			// returns instantly). Re-posting immediately on the second turns this
			// loop into an HTTP flood for the rest of the deadline, so a suspiciously
			// fast idle re-registers once and then backs off.
			const elapsed = Date.now() - startedAt;
			if (elapsed < slice / 2) {
				this.forgetServer();
				if (!(await this.ensureRegistered())) { this.toolResult(id, this.noServerText(), true); return; }
				backoff = Math.min(backoff ? backoff * 2 : 500, 5_000);
				await sleep(backoff);
			} else {
				backoff = 0;
			}
		}
		this.toolResult(id, JSON.stringify({ status: 'idle' }) + '\nNo request arrived before the timeout. Call stylewright_watch again to keep watching.');
	}

	private async callReport(id: number | string | undefined, args: any): Promise<void> {
		const status = String(args.status || '');
		if (!['working', 'needs_input', 'done', 'error'].includes(status)) {
			this.toolResult(id, 'status must be one of: working, needs_input, done, error', true);
			return;
		}
		try {
			const r = await this.post<{ ok: boolean; reason?: string }>('/report', {
				sessionId: this.sessionId,
				requestId: String(args.requestId || ''),
				status,
				message: typeof args.message === 'string' ? args.message : undefined,
				filesTouched: Array.isArray(args.filesTouched) ? args.filesTouched : undefined
			});
			if (!r.ok && r.reason === 'unknown_request') {
				this.toolResult(id, 'That requestId is not the one the overlay is currently showing — it was cancelled or superseded. Nothing was displayed.', true);
				return;
			}
			this.toolResult(id, `Reported "${status}" to the Stylewright overlay.`);
		} catch (err) {
			this.toolResult(id, `Could not reach the Stylewright dev server: ${String(err)}`, true);
		}
	}

	private async callListPending(id: number | string | undefined): Promise<void> {
		try {
			const r = await this.post<{ pending: number; forYou: boolean }>('/list_pending', { sessionId: this.sessionId });
			this.toolResult(id, JSON.stringify({ ...r, session: this.sessionName }, null, 2));
		} catch (err) {
			this.toolResult(id, `Could not reach the Stylewright dev server: ${String(err)}`, true);
		}
	}
}

/** What the agent actually reads. A short orientation line first — the model acts
 *  on the instruction, not the JSON — then the full payload for precision. */
export function renderRequest(req: SwAiRequest): string {
	const lines = [
		`Stylewright request ${req.id}`,
		``,
		`The user selected ${req.element.tag} in ${req.source.file} and asked:`,
		``,
		`    ${req.prompt}`,
		``,
		`Make that change in ${req.source.file}. The full context follows — "styleRules" is the`,
		`component's real parsed CSS (with its @media chain), so use it to target the exact rule`,
		`rather than inferring one. When you are done, call stylewright_report with`,
		`requestId "${req.id}", status "done", and the files you touched.`,
		``,
		'```json',
		JSON.stringify(req, null, 2),
		'```'
	];
	return lines.join('\n');
}

/** Wire the server to stdio and block until stdin closes. */
export async function runStdio(): Promise<void> {
	const server = new StylewrightMcpServer();
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

	// Messages are handled CONCURRENTLY on purpose. Serialising them behind one
	// another would park every subsequent message — including the cancellation
	// that is meant to stop it — behind a `stylewright_watch` that legitimately
	// runs for 25 minutes. Ordering where it matters (a tools/call that overtakes
	// initialize) is handled by awaiting the shared registration promise instead.
	rl.on('line', (line) => { void server.handleLine(line); });

	const stop = async (): Promise<void> => { await server.shutdown(); process.exit(0); };
	rl.on('close', () => void stop());
	process.on('SIGINT', () => void stop());
	process.on('SIGTERM', () => void stop());

	await new Promise<void>(() => { /* run until stdin closes */ });
}
