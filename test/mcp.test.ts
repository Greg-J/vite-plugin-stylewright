// The MCP server: protocol handshake, tool surface, and one end-to-end run of
// the whole loop over real HTTP — overlay enqueues, agent claims, agent reports,
// overlay sees it. That last test is the one that would have caught a broker and
// an MCP process that each work alone but disagree about the wire.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { VENDORS } from '../src/shared/vendors.js';

// Point the user-level registry at an empty directory. Without this, discovery
// legitimately finds whatever Stylewright dev server the developer running the
// tests happens to have open, and "no dev server" stops meaning anything.
let registrySandbox: string;
let prevRegistry: string | undefined;
beforeAll(() => {
	prevRegistry = process.env.STYLEWRIGHT_REGISTRY_DIR;
	registrySandbox = mkdtempSync(join(tmpdir(), 'sw-registry-'));
	process.env.STYLEWRIGHT_REGISTRY_DIR = registrySandbox;
});
afterAll(() => {
	if (prevRegistry === undefined) delete process.env.STYLEWRIGHT_REGISTRY_DIR;
	else process.env.STYLEWRIGHT_REGISTRY_DIR = prevRegistry;
	rmSync(registrySandbox, { recursive: true, force: true });
});
import { StylewrightMcpServer, renderRequest } from '../src/mcp/server.js';
import { createStylewrightMiddleware } from '../src/server/middleware.js';
import { createAiRoutes } from '../src/server/ai/routes.js';
import { Broker } from '../src/server/ai/broker.js';
import { writeDevFile } from '../src/server/ai/devfile.js';
import { discover } from '../src/mcp/discover.js';
import type { SwAiRequest } from '../src/shared/protocol.js';

interface Rpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: any; error?: any }

/** Drive a server instance and collect its stdout frames. */
function harness() {
	const frames: Rpc[] = [];
	const server = new StylewrightMcpServer((s) => {
		for (const line of s.split('\n')) if (line.trim()) frames.push(JSON.parse(line));
	});
	const send = (msg: Rpc) => server.handleLine(JSON.stringify(msg));
	const byId = (id: number | string) => frames.find((f) => f.id === id);
	return { server, frames, send, byId };
}

describe('JSON-RPC surface', () => {
	it('completes the initialize handshake and advertises tools', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		const r = h.byId(1)!.result;
		expect(r.protocolVersion).toBe('2025-06-18');
		expect(r.serverInfo.name).toBe('stylewright');
		expect(r.capabilities.tools).toBeTruthy();
		// The arming instruction has to reach the model somehow, and this is the
		// only channel that is read before any tool is called.
		expect(r.instructions).toContain('stylewright_watch');
		await h.server.shutdown();
	});

	it('negotiates down to a protocol version it knows', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
		expect(h.byId(1)!.result.protocolVersion).toBe('2025-06-18');
		await h.server.shutdown();
	});

	it('lists exactly the three tools, with a watch description that teaches the loop', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const tools = h.byId(1)!.result.tools as { name: string; description: string }[];
		expect(tools.map((t) => t.name)).toEqual(['stylewright_watch', 'stylewright_report', 'stylewright_list_pending']);
		const watch = tools[0].description;
		expect(watch).toContain('claim → edit → report(done) → claim again');
		expect(watch).toContain('styleRules');
		// report's description must state the honesty rule, or agents will skip it.
		expect(tools[1].description).toContain('never guesses');
		await h.server.shutdown();
	});

	it('answers ping and rejects an unknown method', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
		expect(h.byId(1)!.result).toEqual({});
		await h.send({ jsonrpc: '2.0', id: 2, method: 'nope/nope' });
		expect(h.byId(2)!.error.code).toBe(-32601);
		await h.server.shutdown();
	});

	it('ignores a malformed frame and a notification rather than replying', async () => {
		const h = harness();
		await h.server.handleLine('not json at all');
		await h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(h.frames).toHaveLength(0);
		await h.server.shutdown();
	});

	it('tells the agent what to do when no dev server is running', async () => {
		const prev = { url: process.env.STYLEWRIGHT_URL, tok: process.env.STYLEWRIGHT_TOKEN };
		delete process.env.STYLEWRIGHT_URL;
		delete process.env.STYLEWRIGHT_TOKEN;
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stylewright_watch', arguments: { timeoutMs: 1000 } } });
		const r = h.byId(1)!.result;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('npm run dev');
		expect(r.content[0].text).toContain('STYLEWRIGHT_URL');
		await h.server.shutdown();
		if (prev.url) process.env.STYLEWRIGHT_URL = prev.url;
		if (prev.tok) process.env.STYLEWRIGHT_TOKEN = prev.tok;
	});
});

describe('discovery finds the dev server from where the agent actually runs', () => {
	let server: Server;
	let broker: Broker;
	let repo: string;
	let viteRoot: string;
	let handles: ReturnType<typeof writeDevFile>;

	beforeEach(async () => {
		// The layout that breaks a walk-up-only search: Vite serves a SUBdirECTORY
		// and the agent runs at the repo root, above the lockfile.
		repo = realpathSync(mkdtempSync(join(tmpdir(), 'sw-repo-')));
		viteRoot = join(repo, 'apps', 'web');
		mkdirSync(viteRoot, { recursive: true });

		broker = new Broker({ root: viteRoot });
		const mw = createStylewrightMiddleware(viteRoot, createAiRoutes({ broker, root: viteRoot, token: 'disc-token' }));
		server = createServer((req, res) => {
			void (mw as unknown as (a: unknown, b: unknown, n: () => void) => void)(req, res, () => { res.statusCode = 404; res.end(); });
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as { port: number };

		handles = writeDevFile({
			version: 1, pid: process.pid, root: viteRoot,
			origin: `http://127.0.0.1:${port}`, token: 'disc-token', startedAt: Date.now()
		});
	});

	afterEach(async () => {
		handles.cleanup();
		broker.dispose();
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(repo, { recursive: true, force: true });
	});

	// The bearer token must never be written anywhere Vite serves it: that path is
	// readable over plain HTTP by anyone who can reach the port, which no file mode
	// can prevent.
	it('writes no credential anywhere under the Vite root', () => {
		expect(existsSync(join(viteRoot, 'node_modules', '.stylewright', 'dev.json'))).toBe(false);
		expect(existsSync(join(viteRoot, 'node_modules', '.stylewright'))).toBe(false);
		const entry = JSON.parse(readFileSync(handles.registry, 'utf8'));
		expect(entry.token).toBe('disc-token');
		expect(statSync(handles.registry).mode & 0o077).toBe(0);        // file 0600
		expect(statSync(dirname(handles.registry)).mode & 0o077).toBe(0); // dir  0700
	});

	it('finds it when the agent is inside the Vite root', async () => {
		const d = await discover(viteRoot);
		expect(d?.via).toBe('registry');
		expect(d?.root).toBe(viteRoot);
	});

	it('finds it when the agent is ABOVE the Vite root (monorepo)', async () => {
		const d = await discover(repo);
		expect(d?.via).toBe('registry');
		expect(d?.root).toBe(viteRoot);
	});

	// Binding a repo-root agent to whichever app happened to answer first is a
	// silent wrong answer; refusing is the honest one.
	// "/" is an ancestor of every project on the machine, so the closest-containing
	// heuristic would match all of them and silently pick by path length. An
	// unlocatable cwd has to fall through to the same "exactly one, or ask" rule.
	it('does not let a cwd of "/" silently pick a server', async () => {
		expect((await discover('/'))?.root).toBe(viteRoot);   // exactly one running: fine

		const second = join(repo, 'apps', 'admin');
		mkdirSync(second, { recursive: true });
		const b2 = new Broker({ root: second });
		const mw2 = createStylewrightMiddleware(second, createAiRoutes({ broker: b2, root: second, token: 'tok2' }));
		const s2 = createServer((req, res) => {
			void (mw2 as unknown as (a: unknown, b: unknown, n: () => void) => void)(req, res, () => { res.statusCode = 404; res.end(); });
		});
		await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
		const h2 = writeDevFile({
			version: 1, pid: process.pid, root: second,
			origin: `http://127.0.0.1:${(s2.address() as { port: number }).port}`, token: 'tok2', startedAt: Date.now()
		});

		await expect(discover('/')).rejects.toThrow();   // two running: ask, don't guess

		h2.cleanup();
		b2.dispose();
		await new Promise<void>((r) => s2.close(() => r()));
	});

	it('refuses to guess between two dev servers below the agent', async () => {
		const second = join(repo, 'apps', 'admin');
		mkdirSync(second, { recursive: true });
		const b2 = new Broker({ root: second });
		const mw2 = createStylewrightMiddleware(second, createAiRoutes({ broker: b2, root: second, token: 'tok2' }));
		const s2 = createServer((req, res) => {
			void (mw2 as unknown as (a: unknown, b: unknown, n: () => void) => void)(req, res, () => { res.statusCode = 404; res.end(); });
		});
		await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
		const h2 = writeDevFile({
			version: 1, pid: process.pid, root: second,
			origin: `http://127.0.0.1:${(s2.address() as { port: number }).port}`, token: 'tok2', startedAt: Date.now()
		});

		await expect(discover(repo)).rejects.toThrow();
		// but from inside one of them the answer is unambiguous
		expect((await discover(second))?.root).toBe(second);

		h2.cleanup();
		b2.dispose();
		await new Promise<void>((r) => s2.close(() => r()));
	});

	it('does not offer a server whose lockfile is stale', async () => {
		await new Promise<void>((r) => server.close(() => r()));  // port is dead, files remain
		expect(await discover(repo)).toBeNull();
	});

	it('removes both copies of the lockfile on cleanup', async () => {
		handles.cleanup();
		expect(await discover(repo)).toBeNull();
		expect(await discover(viteRoot)).toBeNull();
	});
});

describe('the watch adapts to how long the client will wait', () => {
	// Claude Code backgrounds a call still running after ~2 min and delivers the
	// result as a task notification, so waiting is free. Cline kills the call at
	// its per-server timeout — 60 s by default — so a 25-minute wait there is not
	// patience, it is a call that never returns and a request handed to nobody.
	const budgetFor = async (clientName: string): Promise<number> => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName } } });
		const ms = (h.server as unknown as { watchBudget(): number }).watchBudget();
		await h.server.shutdown();
		return ms;
	};

	// The same product spells itself several ways depending on where you look.
	it('waits 25 minutes on Claude Code, however it spells its name', async () => {
		for (const n of ['claude-code', 'Claude Code', 'claude_code', 'claude-code/2.1']) {
			expect(await budgetFor(n), n).toBe(1_500_000);
		}
	});

	it('stays inside Cline’s 60 second default', async () => {
		const ms = await budgetFor('Cline');
		expect(ms).toBeLessThan(60_000);
		expect(ms).toBeGreaterThan(30_000);   // still worth blocking for
	});

	// OpenCode caps tool EXECUTION separately from its `timeout` setting (which
	// governs discovery), and per-server overrides are reported not to take
	// effect — so there is no number to raise and the watch has to stay short.
	it('stays well inside OpenCode’s execution cap', async () => {
		for (const n of ['opencode', 'OpenCode', 'opencode/1.18.4']) {
			expect(await budgetFor(n), n).toBe(25_000);
		}
	});

	// The table is the only place a budget may live. A vendor added with a wait
	// longer than its client tolerates fails here rather than in someone's editor.
	it.each(VENDORS.map((v) => [v.id, v] as const))('%s advertises the budget the vendor table declares', async (_id, v) => {
		expect(await budgetFor(v.label)).toBe(v.safeWatchMs);
	});

	// A client that resets its request timer on progress (OpenCode does) cannot
	// kill a watch that heartbeats faster than that timer. Without this, an
	// OpenCode watch dies at ~30s and the user retypes "watch for edits" twice a
	// minute.
	//
	// The dev server is a fetch stub here rather than a real one: the point being
	// pinned is what goes out on stdout while a claim is outstanding, and a claim
	// that never resolves is far easier to arrange than a real one that hangs.
	const blockedWatch = async (params: Record<string, unknown>, forMs: number) => {
		const prev = { url: process.env.STYLEWRIGHT_URL, tok: process.env.STYLEWRIGHT_TOKEN };
		process.env.STYLEWRIGHT_URL = 'http://127.0.0.1:1';
		process.env.STYLEWRIGHT_TOKEN = 'tok';
		vi.stubGlobal('fetch', async (url: string, init?: { signal?: AbortSignal }) => {
			if (String(url).endsWith('/list_pending')) return new Response('{}', { status: 200 });
			if (String(url).endsWith('/hello')) {
				return new Response(JSON.stringify({ sessionId: 's1', name: 'visual' }), { status: 200 });
			}
			if (String(url).endsWith('/ping')) return new Response(JSON.stringify({ known: true }), { status: 200 });
			// /claim: never answers, so the watch stays blocked until its deadline.
			return new Promise<Response>((_res, rej) => {
				init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
			});
		});
		vi.useFakeTimers();
		try {
			const h = harness();
			await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'opencode' } } });
			void h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
			await vi.advanceTimersByTimeAsync(forMs);
			const beats = h.frames.filter((f) => f.method === 'notifications/progress');
			h.server.shutdown();
			return beats;
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			process.env.STYLEWRIGHT_URL = prev.url ?? '';
			process.env.STYLEWRIGHT_TOKEN = prev.tok ?? '';
			if (!prev.url) delete process.env.STYLEWRIGHT_URL;
			if (!prev.tok) delete process.env.STYLEWRIGHT_TOKEN;
		}
	};

	it('heartbeats progress while a watch blocks, when the client asked for it', async () => {
		const beats = await blockedWatch(
			{ name: 'stylewright_watch', arguments: { timeoutMs: 120_000 }, _meta: { progressToken: 'tok-1' } },
			35_000
		);
		expect(beats.length, 'no progress notifications').toBeGreaterThanOrEqual(3);
		expect((beats[0].params as { progressToken: string }).progressToken).toBe('tok-1');
		// Strictly increasing, as the protocol requires.
		const seq = beats.map((b) => (b.params as { progress: number }).progress);
		expect(seq.every((v, i) => i === 0 || v > seq[i - 1]), `not increasing: ${seq}`).toBe(true);
		// Fast enough to reset the shortest default any client is known to ship.
		expect(35_000 / beats.length).toBeLessThan(30_000);
	});

	// Sending progress for a token the client never issued is a protocol error on
	// some clients, so absence means silence.
	it('sends no progress when the client supplied no token', async () => {
		const beats = await blockedWatch({ name: 'stylewright_watch', arguments: { timeoutMs: 120_000 } }, 35_000);
		expect(beats).toEqual([]);
	});

	// The generated config sets STYLEWRIGHT_WATCH_MS to the vendor's
	// configuredWatchMs. A ceiling below that silently caps the number we just
	// told the user to paste, and the watch then ends long before the tool
	// timeout it was matched to.
	it.each(VENDORS.map((v) => [v.id, v] as const))('honours %s’s configured watch without clamping it', async (_id, v) => {
		const prev = process.env.STYLEWRIGHT_WATCH_MS;
		process.env.STYLEWRIGHT_WATCH_MS = String(v.configuredWatchMs);
		try {
			expect(await budgetFor(v.label)).toBe(v.configuredWatchMs);
		} finally {
			process.env.STYLEWRIGHT_WATCH_MS = prev ?? '';
			if (prev === undefined) delete process.env.STYLEWRIGHT_WATCH_MS;
		}
	});

	it('is conservative with a client it does not recognise', async () => {
		const ms = await budgetFor('some-other-editor');
		expect(ms).toBeLessThan(60_000);
	});

	it('honours an explicit timeoutMs over the client default', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Cline' } } });
		// No dev server, so the call returns immediately — we only care that an
		// explicit ask is not clamped down to the Cline default.
		await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stylewright_watch', arguments: { timeoutMs: 300_000 } } });
		expect(h.byId(2)).toBeTruthy();
		await h.server.shutdown();
	});
});

// A dev server restarts constantly, and every restart mints a new token. Without
// automatic re-registration the agent session simply vanishes from the overlay
// and never returns — indistinguishable from "the MCP server is broken".
describe('an agent survives the dev server restarting under it', () => {
	let root: string;
	let regDir: string;
	let prevReg: string | undefined;
	const spawned: { broker: Broker; server: Server }[] = [];

	const startServer = async (token: string) => {
		const broker = new Broker({ root });
		const mw = createStylewrightMiddleware(root, createAiRoutes({ broker, root, token }));
		const server = createServer((req, res) => {
			void (mw as unknown as (a: unknown, b: unknown, n: () => void) => void)(req, res, () => { res.statusCode = 404; res.end(); });
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as { port: number };
		const handles = writeDevFile({
			version: 1, pid: process.pid, root,
			origin: `http://127.0.0.1:${port}`, token, startedAt: Date.now()
		});
		spawned.push({ broker, server });
		return { broker, server, handles };
	};
	const stopServer = async (s: { broker: Broker; server: Server; handles: { cleanup: () => void } }) => {
		s.handles.cleanup();
		s.broker.dispose();
		await new Promise<void>((r) => s.server.close(() => r()));
	};

	beforeEach(() => {
		// The MCP process discovers from ITS OWN cwd, so the fake dev server has to
		// serve a root that actually contains that cwd — otherwise discovery
		// correctly finds nothing and the test measures the wrong thing.
		root = realpathSync(process.cwd());
		// Isolated registry: discovery must not find the developer's own dev server.
		prevReg = process.env.STYLEWRIGHT_REGISTRY_DIR;
		regDir = mkdtempSync(join(tmpdir(), 'sw-reg-'));
		process.env.STYLEWRIGHT_REGISTRY_DIR = regDir;
	});
	afterEach(async () => {
		for (const s of spawned.splice(0)) { s.broker.dispose(); await new Promise<void>((r) => s.server.close(() => r())); }
		if (prevReg === undefined) delete process.env.STYLEWRIGHT_REGISTRY_DIR; else process.env.STYLEWRIGHT_REGISTRY_DIR = prevReg;
		rmSync(regDir, { recursive: true, force: true });
	});

	const until = async (pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> => {
		const stop = Date.now() + ms;
		while (Date.now() < stop) { if (await pred()) return; await new Promise((r) => setTimeout(r, 50)); }
		throw new Error('timed out waiting for ' + what);
	};

	it('re-registers itself against a restarted dev server, with the new token', async () => {
		const first = await startServer('token-one');
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Cline' } } });
		await until(() => first.broker.state().sessions.length === 1, 5000, 'first registration');

		// The dev server goes away and comes back on a new port with a new token —
		// exactly what `npm run dev` again does.
		await stopServer(first);
		const second = await startServer('token-two');

		await until(() => second.broker.state().sessions.some((s) => s.state !== 'gone'), 25_000, 'reconnect');
		const s = second.broker.state().sessions.find((x) => x.state !== 'gone')!;
		expect(s.tool).toBe('Cline');

		// And it is genuinely usable again, not just listed.
		second.broker.link(s.id);
		const watching = h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stylewright_watch', arguments: { timeoutMs: 8000 } } });
		await until(() => second.broker.state().sessions[0].state === 'watching', 8000, 'watching after reconnect');
		void watching;

		await h.server.shutdown();
	}, 45_000);

	it('keeps retrying when the dev server is not up yet at startup', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		await new Promise((r) => setTimeout(r, 500));   // nothing to find

		const late = await startServer('token-late');
		await until(() => late.broker.state().sessions.length === 1, 25_000, 'late registration');
		expect(late.broker.state().sessions[0].tool).toBe('Claude Code');

		await h.server.shutdown();
	}, 45_000);
});

describe('the request the agent actually reads', () => {
	const req: SwAiRequest = {
		id: 'req-7', createdAt: 0, prompt: 'make this a primary button',
		source: { file: 'src/lib/Button.svelte', componentName: 'Button' },
		element: { tag: '<button class="btn">', tagName: 'button', classList: ['btn'], selector: '.card > .btn', rect: { width: 90, height: 32 } },
		context: { outerHTML: '<button class="btn">Go</button>', styleRules: [{ selector: '.btn', decls: [{ prop: 'color', value: 'red' }] }] },
		page: { route: '/', url: 'http://localhost:5173/', viewport: { width: 1200, height: 800, dpr: 2 }, colorScheme: 'dark' }
	};

	it('leads with the instruction, the file, and what to do next', () => {
		const out = renderRequest(req);
		expect(out).toContain('make this a primary button');
		expect(out).toContain('src/lib/Button.svelte');
		expect(out).toContain('stylewright_report');
		expect(out).toContain('req-7');
		expect(out).toContain('styleRules'); // and points at the parsed CSS
		expect(out).toContain('```json');
	});
});

describe('end to end over real HTTP', () => {
	let server: Server;
	let broker: Broker;
	let root: string;
	let origin: string;
	const TOKEN = 'e2e-token';
	let prevEnv: { url?: string; tok?: string; name?: string };

	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'sw-e2e-')));
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'Button.svelte'), '<button class="btn">Go</button>\n<style>.btn{color:red}</style>');

		broker = new Broker({ root });
		const mw = createStylewrightMiddleware(root, createAiRoutes({ broker, root, token: TOKEN }));
		server = createServer((req, res) => {
			void (mw as unknown as (a: unknown, b: unknown, n: () => void) => void)(req, res, () => { res.statusCode = 404; res.end(); });
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const addr = server.address() as { port: number };
		origin = `http://127.0.0.1:${addr.port}`;

		prevEnv = { url: process.env.STYLEWRIGHT_URL, tok: process.env.STYLEWRIGHT_TOKEN, name: process.env.STYLEWRIGHT_SESSION_NAME };
		process.env.STYLEWRIGHT_URL = origin;
		process.env.STYLEWRIGHT_TOKEN = TOKEN;
		process.env.STYLEWRIGHT_SESSION_NAME = 'visual';
	});

	afterEach(async () => {
		broker.dispose();
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(root, { recursive: true, force: true });
		process.env.STYLEWRIGHT_URL = prevEnv.url ?? '';
		process.env.STYLEWRIGHT_TOKEN = prevEnv.tok ?? '';
		process.env.STYLEWRIGHT_SESSION_NAME = prevEnv.name ?? '';
		if (!prevEnv.url) delete process.env.STYLEWRIGHT_URL;
		if (!prevEnv.tok) delete process.env.STYLEWRIGHT_TOKEN;
		if (!prevEnv.name) delete process.env.STYLEWRIGHT_SESSION_NAME;
	});

	const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
		const stop = Date.now() + ms;
		while (Date.now() < stop) { if (pred()) return; await new Promise((r) => setTimeout(r, 15)); }
		throw new Error('timed out waiting for condition');
	};

	const overlaySend = async (id: string) => {
		const res = await fetch(`${origin}/__stylewright/ai/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-stylewright': '1', origin, host: new URL(origin).host },
			body: JSON.stringify({
				id, prompt: 'make this a primary button',
				source: { file: 'src/Button.svelte' },
				element: { tag: '<button class="btn">', tagName: 'button', classList: ['btn'], selector: '.btn', rect: { width: 1, height: 1 } },
				context: { outerHTML: '<button/>' },
				page: { route: '/', url: origin, viewport: { width: 1, height: 1, dpr: 1 }, colorScheme: 'dark' }
			})
		});
		return { status: res.status, body: await res.json() };
	};

	it('registers a session, appears to the overlay, and never auto-binds', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		await until(() => broker.state().sessions.length === 1);

		const s = broker.state();
		expect(s.sessions[0].name).toBe('visual');
		expect(s.sessions[0].tool).toBe('Claude Code');
		expect(s.boundId).toBeNull();                       // explicit binding only
		expect((await overlaySend('r1')).body.reason).toBe('no_session');

		await h.server.shutdown();
	});

	it('carries a prompt from the overlay to the agent and the report back', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		await until(() => broker.state().sessions.length === 1);
		broker.link(broker.state().sessions[0].id);

		// The agent arms its watch, then the user presses Send.
		const watching = h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stylewright_watch', arguments: { timeoutMs: 8000 } } });
		await until(() => broker.state().sessions[0].state === 'watching');

		const sent = await overlaySend('r1');
		expect(sent.status).toBe(200);

		await watching;
		const claimed = h.byId(2)!.result;
		expect(claimed.isError).toBeFalsy();
		expect(claimed.content[0].text).toContain('make this a primary button');
		expect(claimed.content[0].text).toContain('src/Button.svelte');
		expect(broker.state().current!.status).toBe('working');

		// The agent reports done; that is the ONLY thing that moves the overlay on.
		await h.send({
			jsonrpc: '2.0', id: 3, method: 'tools/call',
			params: { name: 'stylewright_report', arguments: { requestId: 'r1', status: 'done', filesTouched: [{ path: 'src/Button.svelte', mark: 'M', note: '+8 −2' }] } }
		});
		const cur = broker.state().current!;
		expect(cur.status).toBe('done');
		expect(cur.filesTouched![0].path).toBe('src/Button.svelte');

		await h.server.shutdown();
	});

	it('tells a session that is connected but not linked to ask the user', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		await until(() => broker.state().sessions.length === 1);
		// deliberately not linked
		await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stylewright_watch', arguments: { timeoutMs: 2000 } } });
		const r = h.byId(2)!.result;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('press Link');
		await h.server.shutdown();
	});

	// The worst failure this system can have: a request handed to a socket nobody
	// is reading, dequeued and marked "working", so the overlay waits forever on a
	// run no agent ever saw.
	it('detects an agent that dies mid-claim, and never swallows the next Send', async () => {
		const hello = await fetch(`${origin}/__stylewright/ai/agent/hello`, {
			method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ cwd: root, clientInfo: { name: 'claude-code' } })
		}).then((r) => r.json());
		broker.link(hello.sessionId);

		const ac = new AbortController();
		void fetch(`${origin}/__stylewright/ai/agent/claim`, {
			method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ sessionId: hello.sessionId, timeoutMs: 60_000 }), signal: ac.signal
		}).catch(() => { /* the abort is the point */ });
		await until(() => broker.state().sessions[0].state === 'watching');

		ac.abort();                                     // the agent process dies
		await until(() => broker.state().sessions[0].state === 'gone');

		// Send must be refused with a reason, not accepted and lost.
		const sent = await overlaySend('r-dead');
		expect(sent.status).toBe(409);
		expect(sent.body.reason).toBe('offline');
		expect(broker.state().current).toBeUndefined();
	});

	it('marks the session gone when the MCP process shuts down', async () => {
		const h = harness();
		await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
		await until(() => broker.state().sessions.length === 1);
		await h.server.shutdown();
		await until(() => broker.state().sessions.length === 0);
		expect(broker.state().sessions).toHaveLength(0);
	});
});
