// Broker behaviour — the rules that decide where a prompt goes, and the honesty
// rule that decides what the overlay is allowed to claim is happening.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Broker } from '../src/server/ai/broker.js';
import { VENDORS } from '../src/shared/vendors.js';
import type { SwAiRequest, SwAiState } from '../src/shared/protocol.js';

const ROOT = '/proj';
let broker: Broker;
let clock = 1_000_000;

beforeEach(() => { clock = 1_000_000; broker = new Broker({ root: ROOT, now: () => clock }); });
afterEach(() => broker.dispose());

const req = (id = 'r1', prompt = 'make it blue'): SwAiRequest => ({
	id, createdAt: clock, prompt,
	source: { file: 'src/Button.svelte' },
	element: { tag: '<button>', tagName: 'button', classList: [], selector: '.btn', rect: { width: 10, height: 10 } },
	context: { outerHTML: '<button></button>' },
	page: { route: '/', url: 'http://x/', viewport: { width: 1, height: 1, dpr: 1 }, colorScheme: 'dark' }
});

const hello = (cwd = ROOT, name?: string) => broker.hello({ cwd, name, clientInfo: { name: 'claude-code' } });

describe('sessions', () => {
	it('registers a session as connected, never watching, and never auto-binds', () => {
		const s = hello();
		const st = broker.state();
		expect(st.sessions[0].state).toBe('connected');
		expect(st.boundId).toBeNull();
		expect(s.bound).toBe(false);
	});

	it('normalises the tool name and flags foreign projects', () => {
		broker.hello({ cwd: '/elsewhere', clientInfo: { name: 'Cline v3' } });
		const s = broker.state().sessions[0];
		expect(s.tool).toBe('Cline');
		expect(s.sameProject).toBe(false);
	});

	// Every vendor in the table, however that product spells itself. A session
	// badged with a raw `clientInfo.name` ("opencode/1.18.4") is the difference
	// between recognising your own agent in the list and not.
	it.each(VENDORS.flatMap((v) => v.match.map((m) => [m, v.label] as const)))(
		'badges a %s client as %s', (clientName, label) => {
			const b = new Broker({ root: ROOT });
			b.hello({ cwd: ROOT, clientInfo: { name: `${clientName}/1.2.3` } });
			expect(b.state().sessions[0].tool).toBe(label);
			b.dispose();
		});

	it('derives a name from the cwd and disambiguates a second one', () => {
		const a = hello('/proj/app');
		const b = hello('/proj/app');
		expect(a.name).toBe('app');
		expect(b.name).toBe('app-2');
	});

	// Cline spawns MCP servers with cwd "/", where basename() is empty. Naming
	// those "session" and "session-2" gives the user a list they cannot read.
	it('names a session after the project when its cwd says nothing', () => {
		const b = new Broker({ root: '/work/my-app', now: () => clock });
		try {
			const a = b.hello({ cwd: '/', clientInfo: { name: 'Cline' } });
			expect(a.name).toBe('my-app');
			const second = b.hello({ cwd: '/', clientInfo: { name: 'Cline' } });
			expect(second.name).toBe('my-app-2');
		} finally { b.dispose(); }
	});

	// …and must not warn "different project" about the user's only session just
	// because their editor chose an unhelpful working directory.
	it('does not badge an unlocatable cwd as a foreign project', () => {
		const b = new Broker({ root: '/work/my-app', now: () => clock });
		try {
			b.hello({ cwd: '/', clientInfo: { name: 'Cline' } });
			expect(b.state().sessions[0].sameProject).toBe(true);
		} finally { b.dispose(); }
	});

	it('still badges a genuinely foreign project', () => {
		const b = new Broker({ root: '/work/my-app', now: () => clock });
		try {
			b.hello({ cwd: '/somewhere/else', clientInfo: { name: 'Cline' } });
			expect(b.state().sessions[0].sameProject).toBe(false);
		} finally { b.dispose(); }
	});

	it('prefers an explicit session name', () => {
		expect(hello(ROOT, 'visual').name).toBe('visual');
	});

	it('orders same-project and watching sessions first', async () => {
		broker.hello({ cwd: '/elsewhere', name: 'foreign', clientInfo: { name: 'cline' } });
		const local = hello(ROOT, 'local');
		const watcher = hello(ROOT, 'watcher');
		broker.link(watcher.sessionId);
		void broker.claim(watcher.sessionId, 5000);
		await Promise.resolve();
		const names = broker.state().sessions.map((s) => s.name);
		expect(names[0]).toBe('watcher');           // same project + watching
		expect(names).toContain(local.name);
		expect(names[names.length - 1]).toBe('foreign');
	});
});

describe('binding is always explicit', () => {
	it('refuses a send with nothing linked even when exactly one session exists', () => {
		hello();
		expect(broker.send(req())).toEqual({ ok: false, reason: 'no_session' });
	});

	it('accepts once linked', () => {
		const s = hello();
		broker.link(s.sessionId);
		expect(broker.send(req()).ok).toBe(true);
	});

	it('reports offline when the bound session is gone', () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.bye(s.sessionId);
		expect(broker.state().offline).toBe(true);
		expect(broker.send(req())).toEqual({ ok: false, reason: 'offline' });
	});

	// "Re-link visual" is only offerable if the name outlives the process.
	it('keeps the bound session’s name after a clean shutdown', () => {
		const s = hello(ROOT, 'visual');
		broker.link(s.sessionId);
		broker.bye(s.sessionId);
		const st = broker.state();
		expect(st.sessions.map((x) => x.name)).toContain('visual');
		expect(st.sessions[0].state).toBe('gone');
	});

	it('forgets an unbound session immediately on a clean shutdown', () => {
		const a = hello(ROOT, 'a');
		const b = hello(ROOT, 'b');
		broker.link(a.sessionId);
		broker.bye(b.sessionId);
		expect(broker.state().sessions.map((x) => x.name)).toEqual(['a']);
	});

	it('tells a claiming session when it is not the bound one', async () => {
		const a = hello(ROOT, 'a');
		const b = hello(ROOT, 'b');
		broker.link(a.sessionId);
		const out = await broker.claim(b.sessionId, 5000);
		expect(out).toEqual({ status: 'not_bound', boundName: 'a' });
	});
});

describe('the queue', () => {
	it('holds a request while the session is connected but not watching', () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req());
		expect(broker.queueLength).toBe(1);
		expect(broker.state().current!.status).toBe('queued');
	});

	it('delivers to a watch that arrives afterwards, and flips to working', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		const out = await broker.claim(s.sessionId, 5000);
		expect(out.status).toBe('request');
		expect((out as { request: SwAiRequest }).request.id).toBe('r1');
		expect(broker.state().current!.status).toBe('working');
		expect(broker.queueLength).toBe(0);
	});

	it('delivers immediately to an already-open watch', async () => {
		const s = hello();
		broker.link(s.sessionId);
		const pending = broker.claim(s.sessionId, 5000);
		await Promise.resolve();
		expect(broker.state().sessions[0].state).toBe('watching');
		broker.send(req('r2'));
		const out = await pending;
		expect((out as { request: SwAiRequest }).request.id).toBe('r2');
	});

	// The overlay is a task log now, so sending a second prompt while one runs is
	// an ordinary thing to do rather than an error to refuse.
	it('queues a second request instead of refusing it', () => {
		const s = hello();
		broker.link(s.sessionId);
		expect(broker.send(req('r1')).ok).toBe(true);
		expect(broker.send(req('r2')).ok).toBe(true);
		expect(broker.queueLength).toBe(2);
		expect(broker.state().tasks!.map((t) => t.id)).toEqual(['r1', 'r2']);
	});

	it('still refuses once the queue is genuinely full', () => {
		const s = hello();
		broker.link(s.sessionId);
		for (let i = 0; i < 20; i++) expect(broker.send(req('r' + i)).ok).toBe(true);
		expect(broker.send(req('over'))).toEqual({ ok: false, reason: 'queue_full' });
	});

	it('hands them out in order, one claim at a time', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1')); broker.send(req('r2'));
		const a = await broker.claim(s.sessionId, 5000);
		expect((a as { request: { id: string } }).request.id).toBe('r1');
		const b = await broker.claim(s.sessionId, 5000);
		expect((b as { request: { id: string } }).request.id).toBe('r2');
	});

	it('reports against whichever task the agent names, not just the newest', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1')); broker.send(req('r2'));
		await broker.claim(s.sessionId, 5000);   // takes r1
		expect(broker.report(s.sessionId, 'r1', 'done')).toEqual({ ok: true });
		const tasks = broker.state().tasks!;
		expect(tasks.find((t) => t.id === 'r1')!.status).toBe('done');
		expect(tasks.find((t) => t.id === 'r2')!.status).toBe('queued');
	});

	it('keeps a running log, and clearing it spares anything still running', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		await broker.claim(s.sessionId, 5000);
		broker.report(s.sessionId, 'r1', 'done');
		broker.send(req('r2'));
		expect(broker.state().tasks).toHaveLength(2);
		const after = broker.clearCurrent();
		expect(after.tasks!.map((t) => t.id)).toEqual(['r2']);   // r1 (done) swept, r2 (queued) kept
	});

	it('cancels an unclaimed request and frees the composer', () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		expect(broker.cancel('r1')).toEqual({ ok: true });
		expect(broker.queueLength).toBe(0);
		expect(broker.state().current).toBeUndefined();
	});

	it('refuses to cancel work the agent already holds', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		await broker.claim(s.sessionId, 5000);
		expect(broker.cancel('r1')).toEqual({ ok: false, reason: 'not_queued' });
	});

	// Cline kills a tool call at 60s. If that happens between the broker handing
	// over a request and the agent reading it, the request exists nowhere else —
	// so the agent gives it back rather than letting it evaporate.
	it('takes a request back when the agent could not act on it', async () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		await broker.claim(s.sessionId, 5000);
		expect(broker.queueLength).toBe(0);
		expect(broker.state().current!.status).toBe('working');

		expect(broker.release('r1')).toBe(true);
		expect(broker.queueLength).toBe(1);
		expect(broker.state().current!.status).toBe('queued');

		// and the next watch still gets it
		const out = await broker.claim(s.sessionId, 5000);
		expect(out.status).toBe('request');
	});

	it('ignores a release for a request it is not holding', () => {
		const s = hello();
		broker.link(s.sessionId);
		broker.send(req('r1'));
		expect(broker.release('nope')).toBe(false);
	});
});

describe('status is only ever what the agent reported', () => {
	let sid: string;
	beforeEach(async () => {
		const s = hello(ROOT, 'visual');
		sid = s.sessionId;
		broker.link(sid);
		broker.send(req('r1'));
		await broker.claim(sid, 5000);
	});

	it('records done with the files the agent named', () => {
		broker.report(sid, 'r1', 'done', undefined, [{ path: 'src/Button.svelte', mark: 'M', note: '+22 −4' }]);
		const c = broker.state().current!;
		expect(c.status).toBe('done');
		expect(c.filesTouched).toHaveLength(1);
	});

	it('records needs_input only from an explicit report', () => {
		expect(broker.state().current!.status).toBe('working');
		broker.report(sid, 'r1', 'needs_input');
		expect(broker.state().current!.status).toBe('needs_input');
	});

	// The rule that keeps the panel honest: silence is not evidence of success.
	it('stays working forever when the agent never reports', () => {
		clock += 60 * 60 * 1000;
		expect(broker.state().current!.status).toBe('working');
	});

	it('ignores a report for a request that is not current', () => {
		expect(broker.report(sid, 'other', 'done')).toEqual({ ok: false, reason: 'unknown_request' });
		expect(broker.state().current!.status).toBe('working');
	});
});

describe('liveness', () => {
	it('marks a session gone when its keepalive socket drops', async () => {
		const s = hello();
		void broker.ping(s.sessionId, 30_000);
		await Promise.resolve();
		expect(broker.state().sessions[0].state).toBe('connected');
		broker.abandonPing(s.sessionId);
		expect(broker.state().sessions[0].state).toBe('gone');
	});

	it('drops from watching to connected when only the claim dies', async () => {
		const s = hello();
		broker.link(s.sessionId);
		void broker.ping(s.sessionId, 30_000);
		void broker.claim(s.sessionId, 30_000);
		await Promise.resolve();
		expect(broker.state().sessions[0].state).toBe('watching');
		broker.abandonClaim(s.sessionId);
		expect(broker.state().sessions[0].state).toBe('connected');
	});

	it('refresh prunes dead sessions and always answers', () => {
		const s = hello();
		broker.abandonPing(s.sessionId);
		broker.bye(s.sessionId);
		expect(broker.refresh().sessions).toHaveLength(0);
	});

	it('forgets a long-dead session without waiting for Refresh', () => {
		const s = hello();
		void broker.ping(s.sessionId, 30_000);
		broker.abandonPing(s.sessionId);
		expect(broker.state().sessions[0].state).toBe('gone');
		clock += 61_000;
		broker.refresh(); // drives one sweep
		expect(broker.state().sessions).toHaveLength(0);
	});

	// The offline banner offers "Re-link {name}", so the name has to survive.
	it('keeps the bound session listed even after it dies', () => {
		const s = hello(ROOT, 'visual');
		broker.link(s.sessionId);
		void broker.ping(s.sessionId, 30_000);
		broker.abandonPing(s.sessionId);
		clock += 10 * 60 * 1000;
		const st = broker.refresh();
		expect(st.sessions.find((x) => x.name === 'visual')).toBeTruthy();
		expect(st.offline).toBe(true);
	});
});

describe('snapshots', () => {
	it('pushes a snapshot to every subscriber on change', () => {
		const seen: SwAiState[] = [];
		const off = broker.subscribe((s) => seen.push(s));
		expect(seen).toHaveLength(1); // immediate first paint
		hello();
		expect(seen.length).toBeGreaterThan(1);
		expect(seen[seen.length - 1].sessions).toHaveLength(1);
		off();
	});

	it('a throwing subscriber cannot stop the others', () => {
		let got = 0;
		broker.subscribe(() => { throw new Error('boom'); });
		broker.subscribe(() => { got++; });
		hello();
		expect(got).toBeGreaterThan(0);
	});
});
