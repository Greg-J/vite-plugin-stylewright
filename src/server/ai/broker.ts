// The broker — the only stateful component in the AI path.
//
// The browser enqueues a request; a deliberately linked agent session claims it
// over MCP. The broker never writes a file: it holds text and hands it over. All
// writing stays the agent's, under the agent's own permission and diff flow.
//
// Liveness. Every MCP process keeps exactly one long-poll open at all times:
// `claim` while the agent is actively watching for work, `ping` otherwise. That
// makes a dead session a closed socket rather than a missed heartbeat, so the
// overlay's chip flips within a render rather than after a polling window. The
// sweep below is only a backstop for sockets that die without an event.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
	SwAiRequest,
	SwAiSession,
	SwAiState,
	SwAiStatus,
	SwAiFileTouch,
	SwAgentHello,
	SwAgentClaimResponse,
	SwAiSetup,
	SwAiTask
} from '../../shared/protocol.js';
import { SW_AI_LIMITS, SW_AI_HISTORY } from '../../shared/protocol.js';
import { usefulCwd } from '../../shared/cwd.js';
import { vendorForClient } from '../../shared/vendors.js';

/** No contact for this long and a session is presumed dead. The long-polls
 *  re-arm well inside it; this only catches a socket that died silently. */
const LIVENESS_MS = 12_000;
const SWEEP_MS = 1_000;
/** How long a dead session lingers in the list before it is forgotten. Long
 *  enough that a quick agent restart still reads as "that one came back", short
 *  enough that a day of restarts doesn't leave a graveyard the user has to press
 *  Refresh to clear. The BOUND session is exempt — its name is what the offline
 *  banner offers to re-link. */
const GONE_TTL_MS = 60_000;

type Waiter = {
	sessionId: string;
	resolve: (r: SwAgentClaimResponse) => void;
	timer: ReturnType<typeof setTimeout>;
};

interface SessionRec extends SwAiSession {
	/** Open `claim` waiter — its presence is what makes the session `watching`. */
	claim: Waiter | null;
	/** Open `ping` waiter — keepalive only, never delivers work. */
	ping: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null;
}

export interface BrokerOptions {
	root: string;
	/** Shipped to the overlay so the setup screen shows a command that works. */
	setup?: SwAiSetup;
	/** Injected in tests so the sweep is deterministic. */
	now?: () => number;
}

export class Broker {
	private root: string;
	private setup: SwAiSetup | undefined;
	private now: () => number;
	private sessions = new Map<string, SessionRec>();
	private queue: SwAiRequest[] = [];
	/** The request currently with an agent. Kept so it can be handed back if the
	 *  agent turns out not to have been able to act on it — once it leaves the
	 *  queue it exists nowhere else, and losing it strands the overlay. */
	private inFlightRequest: SwAiRequest | null = null;
	/** Running log, oldest first. The overlay renders this as a task list rather
	 *  than a single status screen you have to dismiss. */
	private tasks: SwAiTask[] = [];
	private boundId: string | null = null;
	private current: SwAiState['current'] = undefined;
	private listeners = new Set<(s: SwAiState) => void>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	constructor(opts: BrokerOptions) {
		this.root = opts.root;
		this.setup = opts.setup;
		this.now = opts.now || (() => Date.now());
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
		// Never hold the dev server open just for the sweep.
		this.sweepTimer.unref?.();
	}

	/** Release every timer, waiter and listener. Called on dev-server close. */
	dispose(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const s of this.sessions.values()) {
			if (s.claim) { clearTimeout(s.claim.timer); s.claim.resolve({ status: 'idle' }); }
			if (s.ping) { clearTimeout(s.ping.timer); s.ping.resolve(); }
		}
		this.sessions.clear();
		this.listeners.clear();
		this.queue = [];
		this.tasks = [];
		this.inFlightRequest = null;
	}

	// ---------- state + fan-out ----------

	/** The snapshot every overlay client renders from. Whole snapshots, not
	 *  deltas — the panel is a full re-render anyway. */
	state(): SwAiState {
		const sessions = [...this.sessions.values()]
			.map((s) => this.publicSession(s))
			.sort((a, b) => {
				if (a.sameProject !== b.sameProject) return a.sameProject ? -1 : 1;
				const rank = (x: SwAiSession): number => (x.state === 'watching' ? 0 : x.state === 'connected' ? 1 : 2);
				if (rank(a) !== rank(b)) return rank(a) - rank(b);
				return b.lastSeenAt - a.lastSeenAt;
			});
		const bound = this.boundId ? this.sessions.get(this.boundId) : undefined;
		return {
			sessions,
			setup: this.setup,
			tasks: this.tasks,
			boundId: this.boundId,
			offline: !!this.boundId && (!bound || bound.state === 'gone'),
			current: this.current
		};
	}

	private publicSession(s: SessionRec): SwAiSession {
		return {
			id: s.id, name: s.name, tool: s.tool, cwd: s.cwd, sameProject: s.sameProject,
			state: s.state, connectedAt: s.connectedAt, lastSeenAt: s.lastSeenAt, watchMs: s.watchMs
		};
	}

	subscribe(fn: (s: SwAiState) => void): () => void {
		this.listeners.add(fn);
		// The immediate first paint gets the same guard as emit(): a listener that
		// throws is a broken client, not a reason to fail the caller who added it.
		try { fn(this.state()); } catch { /* ignore */ }
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		const snap = this.state();
		for (const fn of this.listeners) {
			try { fn(snap); } catch { /* a broken client must not stop the others */ }
		}
	}

	// ---------- sessions ----------

	hello(body: SwAgentHello): { sessionId: string; name: string; bound: boolean } {
		const cwd = String(body.cwd || '').trim() || this.root;
		const tool = normaliseTool(body.clientInfo?.name);
		const id = randomUUID();
		const name = this.deriveName(body.name, cwd);
		const t = this.now();
		this.sessions.set(id, {
			id, name, tool, cwd,
			watchMs: typeof body.watchMs === 'number' && body.watchMs > 0 ? body.watchMs : undefined,
			// An unusable cwd is unknown, not foreign. Badging a Cline session
			// "different project" because its editor spawned it at "/" is a false
			// warning about the only session the user has.
			sameProject: usefulCwd(cwd) ? isInside(cwd, this.root) : true,
			state: 'connected',
			connectedAt: t, lastSeenAt: t,
			claim: null, ping: null
		});
		// Deliberately NOT auto-binding. A prompt going to a session the user did
		// not choose is the one failure this design refuses to have.
		this.emit();
		return { sessionId: id, name, bound: this.boundId === id };
	}

	/**
	 * `<basename(cwd)>`, disambiguated against the names currently IN USE rather
	 * than a monotonic counter. A counter never recycles, so restarting an agent
	 * in the same directory gets `app-2`, `app-3`… and the overlay's "Re-link
	 * {name}" can never match the name it is offering. Reclaiming the free name is
	 * what makes that affordance work.
	 */
	private deriveName(preferred: string | undefined, cwd: string): string {
		const explicit = (preferred || '').trim();
		if (explicit) return explicit.slice(0, 40);
		// Cline spawns MCP servers with cwd "/", so basename() is empty and the old
		// fallback produced "session", "session-2" — rows you cannot tell apart,
		// which is worse than no list at all. When cwd says nothing, name the
		// session after the project it actually connected to.
		const base = (usefulCwd(cwd) ? basename(cwd) : '') || basename(this.root) || 'agent';
		const taken = new Set([...this.sessions.values()].filter((s) => s.state !== 'gone').map((s) => s.name));
		if (!taken.has(base)) return base;
		for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
		return base;
	}

	/**
	 * Clean shutdown. The BOUND session is marked `gone` rather than deleted: the
	 * overlay's offline banner offers "Re-link {name}", and that offer needs the
	 * name to survive the process that had it. Everything else is forgotten at once.
	 */
	bye(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		this.closeWaiters(s);
		if (sessionId === this.boundId) { s.state = 'gone'; s.lastSeenAt = this.now(); }
		else this.sessions.delete(sessionId);
		this.emit();
	}

	link(sessionId: string): SwAiState {
		if (this.sessions.has(sessionId)) {
			this.boundId = sessionId;
			// A newly bound session may already have work waiting for it.
			this.pump();
			this.emit();
		}
		return this.state();
	}

	unlink(): SwAiState {
		this.boundId = null;
		this.emit();
		return this.state();
	}

	/**
	 * Drop dead sessions and re-report. The UI's Refresh button.
	 *
	 * The bound session is kept even when dead — pressing Refresh while offline is
	 * precisely when the user wants "Re-link visual", and that offer needs the
	 * name. It goes when they link something else or clear the binding.
	 */
	refresh(): SwAiState {
		this.sweep();
		for (const [id, s] of [...this.sessions]) {
			if (s.state === 'gone' && id !== this.boundId) { this.closeWaiters(s); this.sessions.delete(id); }
		}
		this.emit();
		return this.state();
	}

	private closeWaiters(s: SessionRec): void {
		if (s.claim) { clearTimeout(s.claim.timer); s.claim.resolve({ status: 'idle' }); s.claim = null; }
		if (s.ping) { clearTimeout(s.ping.timer); s.ping.resolve(); s.ping = null; }
	}

	/** Backstop for sockets that die without firing `close`, plus expiry of the
	 *  long dead so the list stays a list of sessions rather than a history of them. */
	private sweep(): void {
		const t = this.now();
		let changed = false;
		for (const [id, s] of [...this.sessions]) {
			if (s.state === 'gone') {
				if (id !== this.boundId && t - s.lastSeenAt > GONE_TTL_MS) { this.sessions.delete(id); changed = true; }
				continue;
			}
			const live = !!s.claim || !!s.ping || t - s.lastSeenAt < LIVENESS_MS;
			if (!live) { s.state = 'gone'; this.closeWaiters(s); changed = true; }
		}
		if (changed) this.emit();
	}

	private touch(s: SessionRec): void {
		s.lastSeenAt = this.now();
		if (s.state === 'gone') s.state = s.claim ? 'watching' : 'connected';
	}

	// ---------- the queue ----------

	/**
	 * Enqueue a request from the overlay. One in flight at a time: while a request
	 * is `sending`/`queued`/`working`/`needs_input` the composer is replaced by the
	 * status view, so a second Send is unreachable by construction — but the guard
	 * is here too, because "unreachable in the UI" is not a security property.
	 */
	send(req: SwAiRequest): { ok: boolean; reason?: string; status?: SwAiStatus } {
		if (!this.boundId) return { ok: false, reason: 'no_session' };
		const bound = this.sessions.get(this.boundId);
		if (!bound || bound.state === 'gone') return { ok: false, reason: 'offline' };
		// Queueing rather than refusing: the overlay is a task log now, so a second
		// prompt while one is running is a normal thing to do, not an error.
		if (this.queue.length >= SW_AI_LIMITS.queueDepth) return { ok: false, reason: 'queue_full' };

		const t = this.now();
		this.queue.push(req);
		this.tasks.push({
			id: req.id, prompt: req.prompt, file: req.source.file,
			status: 'queued', createdAt: t, updatedAt: t
		});
		if (this.tasks.length > SW_AI_HISTORY) this.tasks.splice(0, this.tasks.length - SW_AI_HISTORY);
		this.current = { requestId: req.id, status: 'queued', startedAt: t, updatedAt: t };
		this.pump();
		this.emit();
		return { ok: true, status: this.current.status };
	}

	/** Drop an unclaimed request. Claimed work belongs to the agent — we can only
	 *  stop showing it, never recall it, so we refuse rather than lie. */
	cancel(requestId: string): { ok: boolean; reason?: string } {
		const i = this.queue.findIndex((r) => r.id === requestId);
		if (i < 0) return { ok: false, reason: 'not_queued' };
		this.queue.splice(i, 1);
		// A withdrawn request is not history worth keeping — it never ran.
		this.tasks = this.tasks.filter((t) => t.id !== requestId);
		if (this.inFlightRequest?.id === requestId) this.inFlightRequest = null;
		if (this.current?.requestId === requestId) this.current = undefined;
		this.emit();
		return { ok: true };
	}

	/**
	 * Put a request back at the head of the queue. Used when a claim resolved but
	 * the agent's socket turned out to be dead, so the payload was never actually
	 * delivered. Losing a request here would be the worst failure this system can
	 * have: the overlay would sit on "working" for a run that no agent ever saw.
	 */
	requeue(req: SwAiRequest): void {
		if (this.queue.some((r) => r.id === req.id)) return;
		if (this.inFlightRequest?.id === req.id) this.inFlightRequest = null;
		this.queue.unshift(req);
		this.setTask(req.id, { status: 'queued' });
		if (this.current?.requestId === req.id) {
			this.current = { ...this.current, status: 'queued', updatedAt: this.now() };
		}
		this.pump();
		this.emit();
	}

	/**
	 * An agent returning work it was given but could not act on. Distinct from
	 * `cancel` (the user changing their mind) and from `requeue` (the transport
	 * noticing a dead socket) only in who initiates it — the effect is the same:
	 * the request goes back in the queue instead of evaporating.
	 */
	release(requestId: string): boolean {
		if (!this.current || this.current.requestId !== requestId) return false;
		if (this.queue.some((r) => r.id === requestId)) return true;
		// The payload itself is gone with the claim, so re-queueing needs the record
		// we still hold. Without one there is nothing to give back; say so honestly.
		const held = this.inFlightRequest;
		if (!held || held.id !== requestId) {
			this.current = { ...this.current, status: 'queued', updatedAt: this.now() };
			this.emit();
			return false;
		}
		this.requeue(held);
		return true;
	}

	/** Patch one entry in the running log. */
	private setTask(id: string, patch: Partial<SwAiTask>): void {
		const t = this.tasks.find((x) => x.id === id);
		if (t) Object.assign(t, patch, { updatedAt: this.now() });
	}

	/** Hand the head of the queue to a waiting claim, if both exist. */
	private pump(): void {
		if (!this.queue.length || !this.boundId) return;
		const s = this.sessions.get(this.boundId);
		if (!s || !s.claim) return; // connected but not watching — the request waits
		const req = this.queue.shift()!;
		this.inFlightRequest = req;
		const w = s.claim;
		s.claim = null;
		clearTimeout(w.timer);
		this.setTask(req.id, { status: 'working' });
		if (this.current?.requestId === req.id) {
			this.current = { ...this.current, status: 'working', updatedAt: this.now() };
		}
		s.state = 'connected'; // the claim is spent; the agent re-arms to watch again
		w.resolve({ status: 'request', request: req });
	}

	// ---------- agent-facing ----------

	/** Long-poll. Resolves with work as soon as there is any, else `idle`. */
	claim(sessionId: string, timeoutMs: number): Promise<SwAgentClaimResponse> {
		const s = this.sessions.get(sessionId);
		if (!s) return Promise.resolve({ status: 'idle' });
		this.touch(s);

		if (this.boundId !== sessionId) {
			const bound = this.boundId ? this.sessions.get(this.boundId) : null;
			return Promise.resolve({ status: 'not_bound', boundName: bound ? bound.name : null });
		}
		// Replace any previous claim from this session rather than stacking them.
		if (s.claim) { clearTimeout(s.claim.timer); s.claim.resolve({ status: 'idle' }); s.claim = null; }

		return new Promise<SwAgentClaimResponse>((resolve) => {
			const timer = setTimeout(() => {
				if (s.claim && s.claim.timer === timer) { s.claim = null; s.state = 'connected'; this.emit(); }
				resolve({ status: 'idle' });
			}, Math.max(1000, timeoutMs));
			timer.unref?.();
			s.claim = { sessionId, resolve, timer };
			s.state = 'watching';
			this.pump();      // work may already be waiting
			this.emit();
		});
	}

	/** Called when the claim's HTTP socket closes — the agent went away. */
	abandonClaim(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (!s || !s.claim) return;
		clearTimeout(s.claim.timer);
		s.claim = null;
		s.state = s.ping ? 'connected' : 'gone';
		this.emit();
	}

	/** Keepalive long-poll. Holds the socket so a dead process is detectable at
	 *  once; carries no work and never changes `watching`. */
	ping(sessionId: string, timeoutMs: number): Promise<{ known: boolean }> {
		const s = this.sessions.get(sessionId);
		// A session we have never heard of is the signature of a dev-server restart:
		// the agent process outlived us and is still presenting an id (and a token)
		// minted by the previous broker. Saying so is what lets it re-register.
		// Resolving silently here instead — which is what this used to do — made the
		// keepalive return instantly, so the agent re-pinged 50ms later, forever,
		// never noticing it had been orphaned and never appearing in the list.
		if (!s) return Promise.resolve({ known: false });
		this.touch(s);
		if (s.ping) { clearTimeout(s.ping.timer); s.ping.resolve(); s.ping = null; }
		return new Promise<{ known: boolean }>((resolve) => {
			const done = (): void => resolve({ known: true });
			const timer = setTimeout(() => { if (s.ping?.timer === timer) s.ping = null; done(); }, Math.max(1000, timeoutMs));
			timer.unref?.();
			s.ping = { resolve: done, timer };
			this.emit();
		});
	}

	abandonPing(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (!s || !s.ping) return;
		clearTimeout(s.ping.timer);
		s.ping = null;
		if (!s.claim) { s.state = 'gone'; this.emit(); }
	}

	/** Non-blocking peek — debugging, and for an agent that prefers to poll. */
	listPending(sessionId: string): { pending: number; forYou: boolean } {
		const s = this.sessions.get(sessionId);
		if (s) this.touch(s);
		return { pending: this.queue.length, forYou: this.boundId === sessionId };
	}

	/**
	 * The agent's own report. This is the ONLY way `needs_input` and `done` are
	 * ever set — no timer, no file-watch heuristic. A status we did not observe is
	 * a status we do not show.
	 */
	report(sessionId: string, requestId: string, status: 'working' | 'needs_input' | 'done' | 'error', message?: string, filesTouched?: SwAiFileTouch[]): { ok: boolean; reason?: string } {
		const s = this.sessions.get(sessionId);
		if (s) this.touch(s);
		// Look the task up by id rather than assuming it is the current one: with a
		// queue, the agent can be finishing r1 while r2 and r3 are already waiting.
		const task = this.tasks.find((t) => t.id === requestId);
		if (!task) return { ok: false, reason: 'unknown_request' };
		const msg = message ? String(message).slice(0, 500) : undefined;
		const files = Array.isArray(filesTouched) ? filesTouched.slice(0, 50) : undefined;
		if (status === 'done' || status === 'error') {
			if (this.inFlightRequest?.id === requestId) this.inFlightRequest = null;
		}
		this.setTask(requestId, { status, message: msg, filesTouched: files });
		if (this.current?.requestId === requestId) {
			this.current = { ...this.current, status, message: msg, filesTouched: files, updatedAt: this.now() };
		}
		this.emit();
		return { ok: true };
	}

	/** Overlay-side reset after `done`/`error` — clears the status view so the
	 *  composer comes back. */
	/**
	 * "Clear history". Finished cards go; anything still QUEUED stays, because it
	 * has not happened yet and dropping it would lose work.
	 *
	 * A card stuck in `working`/`needs_input` is cleared too. The agent may simply
	 * never report — that is the honest behaviour we chose — but the alternative
	 * here is a card nobody can ever remove: cancel refuses claimed work, and there
	 * is no terminal report coming.
	 */
	clearCurrent(): SwAiState {
		const stillWaiting = new Set(this.queue.map((r) => r.id));
		this.tasks = this.tasks.filter((t) => stillWaiting.has(t.id));
		this.current = undefined;
		this.inFlightRequest = null;
		this.emit();
		return this.state();
	}

	/** Test seam. */
	get queueLength(): number { return this.queue.length; }
}


function normaliseTool(name: string | undefined): string {
	return vendorForClient(name || '')?.label ?? (name || 'MCP client').slice(0, 32);
}

/** Path containment for the `sameProject` badge only — never for file access. */
function isInside(child: string, parent: string): boolean {
	const c = child.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const p = parent.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return c === p || c.startsWith(p + '/');
}
