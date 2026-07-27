// @vitest-environment happy-dom
//
// The Ask AI tab, driven through the real Panel. Two things are being pinned
// here: that every state in the design is reachable with the right words on it,
// and that adding a second tab did not quietly change the CSS editor underneath
// it (the caret, the undo timeline, and ⌘S all live one keystroke away).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Panel, vendorConfigJson, humanDuration, copyText, type PanelHost, type PickMeta, type AiHost } from '../src/client/panel.js';
import { VENDORS, vendorById } from '../src/shared/vendors.js';
import type { SwRule, SwAiState, SwAiSession, SwAiRequest, SwAiTask } from '../src/shared/protocol.js';
import { AI_COPY } from '../src/client/aiCopy.js';

const META: PickMeta = { fileLabel: 'Button.svelte', selectorLabel: '.btn', dims: '10 × 10', tag: '<button class="btn">' };
const RULES: SwRule[] = [{ selector: '.btn', decls: [{ prop: 'color', value: '#333' }], id: 0 }];

let origRemoveChild: typeof Node.prototype.removeChild;
/** Panel registers window-level listeners, so a mount that is never destroyed
 *  keeps reacting to keys fired by later tests. Tracking and tearing them down
 *  keeps each test isolated — and exercises destroy() while we are at it. */
const mounted: Panel[] = [];

beforeEach(() => {
	// The panel now persists its layout, active tab and tool choice. That is the
	// point — but it also means one test's choices become the next test's starting
	// state unless the slate is wiped.
	try { localStorage.removeItem('__stylewright_ui'); } catch { /* ignore */ }
	origRemoveChild = Node.prototype.removeChild;
	Node.prototype.removeChild = function <T extends Node>(child: T): T {
		// Browser parity: removing a subtree containing the focused element blurs
		// it. Wrapped because happy-dom's ShadowRoot.activeElement getter throws
		// once a second shadow root exists — which any test that mounts two panels
		// does, and the throw surfaces as an unrenderable panel rather than
		// anything resembling its cause.
		try {
			const root = this.getRootNode?.() as ShadowRoot | undefined;
			const active = root && (root as ShadowRoot).activeElement;
			if (active && (child === (active as unknown as Node) || (child as unknown as Element).contains?.(active))) {
				active.dispatchEvent(new Event('blur'));
			}
		} catch { /* not a focus situation we can observe here */ }
		return origRemoveChild.call(this, child) as T;
	};
});
afterEach(() => {
	while (mounted.length) mounted.pop()!.destroy();
	Node.prototype.removeChild = origRemoveChild;
	document.body.innerHTML = '';
});

const session = (over: Partial<SwAiSession> = {}): SwAiSession => ({
	id: 's1', name: 'visual', tool: 'Claude Code', cwd: '/Users/dev/app',
	sameProject: true, state: 'watching', connectedAt: 1, lastSeenAt: 1, ...over
});
const emptyState = (): SwAiState => ({ sessions: [], boundId: null, offline: false });

function makeAi(initial: SwAiState) {
	let cur = initial;
	const sent: SwAiRequest[] = [];
	let push: ((s: SwAiState) => void) | null = null;
	const set = (s: SwAiState): SwAiState => { cur = s; push?.(s); return s; };
	const ai: AiHost = {
		state: async () => cur,
		link: async (id) => set({ ...cur, boundId: id, offline: false }),
		unlink: async () => set({ ...cur, boundId: null }),
		refresh: async () => set(cur),
		clear: async () => set({ ...cur, current: undefined }),
		cancel: async () => set({ ...cur, current: undefined }),
		send: async (r) => { sent.push(r); set({ ...cur, current: { requestId: r.id, status: 'queued', startedAt: 1, updatedAt: 1 } }); return { ok: true, requestId: r.id, status: 'queued' }; },
		subscribe: (fn) => { push = fn; fn(cur); return () => { push = null; }; }
	};
	return { ai, sent, set, get current() { return cur; } };
}

function mount(initial: SwAiState = emptyState(), rules: SwRule[] = RULES) {
	const hostEl = document.createElement('div');
	document.body.appendChild(hostEl);
	const shadow = hostEl.attachShadow({ mode: 'open' });
	const saved: { rules: SwRule[] | null } = { rules: null };
	const fake = makeAi(initial);
	const host: PanelHost = {
		loadRules: async () => ({ hasStyle: true, rules }),
		applyRules: async (_f, sentRules) => { saved.rules = sentRules; return { ok: true, changed: true }; },
		saveCss: async () => ({ ok: true, changed: true }),
		ai: fake.ai
	};
	const panel = new Panel(shadow, host);
	mounted.push(panel);
	return { panel, shadow, host, saved, fake };
}

/** Drain queued renders. A macrotask hop at the end matters once a test mounts
 *  more than one panel: microtasks alone can return before the second panel's
 *  first re-render has run, and the assertion then reads a stale DOM. */
const tick = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 4; i++) await Promise.resolve();
};
const text = (s: ShadowRoot): string => s.textContent || '';
const byText = (s: ShadowRoot, t: string): HTMLElement | null =>
	[...s.querySelectorAll<HTMLElement>('button,a')].find((b) => (b.textContent || '').trim() === t) || null;
const ta = (s: ShadowRoot): HTMLTextAreaElement | null => s.querySelector('textarea[data-fkey="ai-prompt"]');
/** Settings is a body tab, reached from the header gear. */
const openSettings = async (ctx: { shadow: ShadowRoot }): Promise<void> => {
	ctx.shadow.querySelector<HTMLElement>('button[aria-label="Settings"]')!.click();
	await tick();
};
/** Settings → Agents → that vendor's Setup button. */
const openVendorSetup = async (ctx: { shadow: ShadowRoot }, label = 'Claude Code'): Promise<void> => {
	await openSettings(ctx);
	const row = ctx.shadow.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!.parentElement!;
	[...row.querySelectorAll<HTMLElement>('button')]
		.find((b) => (b.textContent || '').trim() === AI_COPY.settings.setupFor)!.click();
	await tick();
};

async function openAi(initial: SwAiState = emptyState()) {
	const ctx = mount(initial);
	await ctx.panel.pick('src/Button.svelte', META);
	await tick();
	byText(ctx.shadow, AI_COPY.tabs.ai)!.click();
	await tick();
	return ctx;
}

describe('tab row', () => {
	it('shows both tabs and keeps the CSS editor under Styles', async () => {
		const { shadow } = await openAi();
		expect(byText(shadow, AI_COPY.tabs.styles)).toBeTruthy();
		expect(ta(shadow)).toBeTruthy();
		byText(shadow, AI_COPY.tabs.styles)!.click();
		await tick();
		expect(ta(shadow)).toBeNull();
		expect(shadow.querySelector('input[data-fkey="0-0-p-_"]')).toBeTruthy(); // the real editor
	});

	it('is hidden entirely when the host has no AI support', async () => {
		const hostEl = document.createElement('div');
		document.body.appendChild(hostEl);
		const shadow = hostEl.attachShadow({ mode: 'open' });
		const panel = new Panel(shadow, {
			loadRules: async () => ({ hasStyle: true, rules: RULES }),
			applyRules: async () => ({ ok: true, changed: true }),
			saveCss: async () => ({ ok: true, changed: true })
		});
		mounted.push(panel);
		await panel.pick('src/Button.svelte', META);
		await tick();
		expect(byText(shadow, AI_COPY.tabs.ai)).toBeNull();
	});
});

describe('session chip', () => {
	// The header chip and the send-bar pill said the same thing twice; the pill
	// won, because it sits where you look when you press Send.
	it('reads "no session linked" with nothing bound', async () => {
		const { shadow } = await openAi();
		expect(text(shadow)).toContain(AI_COPY.composer.destNone);
		expect(shadow.querySelector('[data-sw-chip]'), 'the pill is the session control').toBeTruthy();
	});

	it('reads just the name when bound and watching', async () => {
		const { shadow } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		expect(text(shadow)).toContain('visual');
		expect(text(shadow)).not.toContain(AI_COPY.composer.destNone);
		expect(text(shadow)).not.toContain('offline');
	});

	it('reads "· offline" — lower case, no parentheses — when the session is gone', async () => {
		const { shadow } = await openAi({ sessions: [session({ state: 'gone' })], boundId: 's1', offline: true });
		expect(text(shadow)).toContain('visual · offline');
		expect(text(shadow)).not.toContain('(disconnected)');
	});
});

// Settings → Agents. Three vendors' instructions stacked behind a picker is
// noise when you only ever run one, so the list is yours to trim — but trimming
// it must never leave the setup screen with nothing to say.
// A session that has just taken a request stops "watching" until it re-arms.
// The nudge fired in that window, next to a card saying that same session was
// running the task — which reads as a bug in the panel.
describe('the arming nudge knows the difference between idle and busy', () => {
	const withSession = (state: SwAiSession['state'], current?: SwAiState['current']): SwAiState => ({
		sessions: [session({ state })], boundId: 's1', offline: false, current
	});

	it('nudges a linked session that is merely connected', async () => {
		const { shadow } = await openAi(withSession('connected'));
		expect(text(shadow)).toContain(AI_COPY.arm.cmd);
	});

	it('stays quiet while that session is working on a request', async () => {
		const { shadow } = await openAi(withSession('connected', { requestId: 'r1', status: 'working', startedAt: 1, updatedAt: 1 }));
		expect(text(shadow)).not.toContain(AI_COPY.arm.cmd);
	});

	it('comes back once the request is done and the session still has not re-armed', async () => {
		const { shadow } = await openAi(withSession('connected', { requestId: 'r1', status: 'done', startedAt: 1, updatedAt: 1 }));
		expect(text(shadow)).toContain(AI_COPY.arm.cmd);
	});
});

describe('Settings lists the agents and controls which ones are offered', () => {
	const openSettings = async (initial: SwAiState = emptyState()) => {
		const ctx = await openAi(initial);
		ctx.shadow.querySelector<HTMLElement>('[aria-label="Settings"]')!.click();
		await tick();
		return ctx;
	};
	/** The toggle for one vendor, by its accessible name. */
	const sw = (shadow: ShadowRoot, label: string): HTMLElement | null =>
		shadow.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
	/** That vendor's Setup button, from its row. */
	const setupBtn = (shadow: ShadowRoot, label: string): HTMLElement | null =>
		[...(sw(shadow, label)!.parentElement!.querySelectorAll<HTMLElement>('button'))]
			.find((b) => (b.textContent || '').trim() === AI_COPY.settings.setupFor) || null;

	it('lists every vendor with a switch and a Setup button', async () => {
		const { shadow } = await openSettings();
		for (const v of VENDORS) {
			expect(sw(shadow, v.label), `no switch for ${v.id}`).toBeTruthy();
			expect(sw(shadow, v.label)!.getAttribute('aria-checked')).toBe('true');
		}
		const setups = [...shadow.querySelectorAll<HTMLElement>('button')]
			.filter((b) => (b.textContent || '').trim() === AI_COPY.settings.setupFor);
		expect(setups.length).toBe(VENDORS.length);
	});

	it('Setup jumps straight to that vendor’s instructions', async () => {
		const { shadow } = await openSettings({
			sessions: [], boundId: null, offline: false,
			setup: { command: 'npx vite-plugin-stylewright mcp', published: true, binPath: null }
		});
		setupBtn(shadow, 'OpenCode')!.click();
		await tick();
		const t = text(shadow);
		expect(t).toContain(AI_COPY.empty.step1Json.replace('{tool}', 'OpenCode'));
		expect(t).toContain(vendorById('opencode')!.register.json!.where);
		expect(t).not.toContain('claude mcp add');
	});

	// Switched off, a tool stays listed — otherwise there would be no way to
	// switch it back on — but it stops offering its setup.
	it('switching a vendor off takes away its Setup button, reversibly', async () => {
		const { shadow } = await openSettings();
		expect(setupBtn(shadow, 'Cline')).toBeTruthy();
		sw(shadow, 'Cline')!.click();
		await tick();
		expect(sw(shadow, 'Cline')!.getAttribute('aria-checked')).toBe('false');
		expect(setupBtn(shadow, 'Cline')).toBeNull();
		expect(setupBtn(shadow, 'OpenCode'), 'took the wrong row away').toBeTruthy();

		sw(shadow, 'Cline')!.click();
		await tick();
		expect(setupBtn(shadow, 'Cline'), 'could not switch it back on').toBeTruthy();
	});

	// A blank setup screen would be a dead end with no way back, so the last one
	// declines rather than obeying.
	it('refuses to switch off the last vendor', async () => {
		const { shadow } = await openSettings();
		for (const v of VENDORS) { sw(shadow, v.label)!.click(); await tick(); }
		const on = VENDORS.filter((v) => sw(shadow, v.label)!.getAttribute('aria-checked') === 'true');
		expect(on.length).toBe(1);
	});

	// The live sessions belong beside the tools that produce them, not only in a
	// dropdown at the other end of the panel.
	it('lists the connected sessions in the Agents section', async () => {
		const { shadow } = await openSettings({
			sessions: [session({ name: 'visual', state: 'watching' })], boundId: null, offline: false
		});
		expect(text(shadow)).toContain(AI_COPY.settings.sessions);
		expect(text(shadow)).toContain('visual');
		expect(byText(shadow, AI_COPY.pop.link), 'no way to link from Settings').toBeTruthy();
	});

	it('says so plainly when nothing has connected yet', async () => {
		const { shadow } = await openSettings();
		expect(text(shadow)).toContain(AI_COPY.pop.none);
	});

	// Stored as the OFF list precisely so this holds: someone who saved settings
	// before OpenCode existed still gets OpenCode.
	it('a vendor added after the user saved settings still shows up', async () => {
		localStorage.setItem('__stylewright_ui', JSON.stringify({ v: 1, vendorsOff: ['cline'] }));
		const { shadow } = await openSettings();
		expect(sw(shadow, 'Cline')!.getAttribute('aria-checked')).toBe('false');
		expect(sw(shadow, 'OpenCode')!.getAttribute('aria-checked')).toBe('true');
		expect(sw(shadow, 'Claude Code')!.getAttribute('aria-checked')).toBe('true');
	});
});

// One location. This screen used to exist twice — as a floating panel behind the
// destination chip, and again in Settings — so "how do I connect an agent" had
// two answers that had to be kept in step.
describe('setting up an agent lives in Settings and nowhere else', () => {
	it('shows all four steps and no red', async () => {
		const ctx = await openAi();
		await openVendorSetup(ctx);
		const t = text(ctx.shadow);
		for (const x of [AI_COPY.empty.step1, AI_COPY.empty.step2.replace('{tool}', 'Claude Code'), AI_COPY.empty.step3, AI_COPY.empty.step4]) expect(t).toContain(x);
		expect(ctx.shadow.innerHTML).not.toContain('#f87171'); // danger is for errors, not setup
	});

	// The regression this whole change is about: the chip must not carry a second
	// copy of the instructions.
	it('the destination chip lists sessions and does not repeat the steps', async () => {
		const { shadow } = await openAi({ sessions: [session()], boundId: null, offline: false });
		shadow.querySelector<HTMLElement>('[data-sw-chip]')!.click();
		await tick();
		const t = text(shadow);
		expect(t).toContain(AI_COPY.pop.title);
		expect(t).not.toContain(AI_COPY.empty.step1);
		expect(t).not.toContain(AI_COPY.empty.step3);
	});

	it('the chip’s setup button opens Settings rather than another panel', async () => {
		const ctx = await openAi();
		ctx.shadow.querySelector<HTMLElement>('[data-sw-chip]')!.click();
		await tick();
		expect(text(ctx.shadow)).toContain(AI_COPY.pop.none);   // nothing to link yet
		byText(ctx.shadow, AI_COPY.pop.setup)!.click();
		await tick();
		expect((ctx.panel as unknown as { state: { aiTab: string } }).state.aiTab).toBe('settings');
		expect(text(ctx.shadow)).toContain(AI_COPY.settings.agents);
	});

	// The command is the step people get stuck on, so it is ON this screen rather
	// than behind a disclosure — and it is the command the DEV SERVER computed for
	// this machine, never a published name that would 404 from a checkout.
	it('shows the registration command the server computed, inline', async () => {
		const ctx = await openAi({
			sessions: [], boundId: null, offline: false,
			setup: { command: 'node /abs/path/dist/mcp.js mcp', published: false, binPath: '/abs/path/dist/mcp.js' }
		});
		await openVendorSetup(ctx);
		expect(text(ctx.shadow)).toContain('claude mcp add stylewright -- node /abs/path/dist/mcp.js mcp');
	});

	it('uses the short published form when the plugin is a real dependency', async () => {
		const ctx = await openAi({
			sessions: [], boundId: null, offline: false,
			setup: { command: 'npx vite-plugin-stylewright mcp', published: true, binPath: null }
		});
		await openVendorSetup(ctx);
		expect(text(ctx.shadow)).toContain('claude mcp add stylewright -- npx vite-plugin-stylewright mcp');
	});

	// Printing a command that cannot work is worse than admitting there isn't one.
	it('says what to do when the MCP bin has not been built', async () => {
		const ctx = await openAi();   // no `setup` in the snapshot
		await openVendorSetup(ctx);
		expect(text(ctx.shadow)).toContain(AI_COPY.empty.setupNoBin);
		expect(text(ctx.shadow)).not.toContain('npx vite-plugin-stylewright mcp');
	});

	it('offers Cline the JSON it actually wants, with command and args split', () => {
		const cfg = JSON.parse(vendorConfigJson(vendorById('cline')!, 'node /abs/dist/mcp.js mcp')).mcpServers.stylewright;
		expect(cfg.command).toBe('node');
		expect(cfg.args).toEqual(['/abs/dist/mcp.js', 'mcp']);
	});

	it('offers OpenCode a single command array, which is the shape it reads', () => {
		const cfg = JSON.parse(vendorConfigJson(vendorById('opencode')!, 'node /abs/dist/mcp.js mcp')).mcp.stylewright;
		expect(cfg.type).toBe('local');
		expect(cfg.command).toEqual(['node', '/abs/dist/mcp.js', 'mcp']);
		expect(cfg.enabled).toBe(true);
	});

	// Kimi reads the Claude-shaped `mcpServers` object, but names its timeout
	// differently and in another unit — the one thing a hand-written config here
	// would get wrong, since the neighbouring vendor spells it `timeout`.
	it('offers Kimi the Claude-shaped object with its timeout in milliseconds', () => {
		const cfg = JSON.parse(vendorConfigJson(vendorById('kimi')!, 'node /abs/dist/mcp.js mcp')).mcpServers.stylewright;
		expect(cfg.command).toBe('node');
		expect(cfg.args).toEqual(['/abs/dist/mcp.js', 'mcp']);
		expect(cfg.toolTimeoutMs).toBe(3_600_000);
		expect(cfg).not.toHaveProperty('timeout');
	});

	// Every client kills a tool call eventually, and a watch that outlives its
	// client's limit is not patient — it is killed mid-call, which ends the agent's
	// turn and makes the user retype "watch for Stylewright edits". So whatever
	// timeout a vendor's config ships with, the watch it also ships has to fit.
	it.each(VENDORS.map((v) => [v.id, v] as const))('%s: the watch budget fits inside the timeout it ships with', (_id, v) => {
		expect(v.configuredWatchMs).toBeGreaterThan(0);
		expect(v.safeWatchMs).toBeGreaterThan(0);
		if (!v.register.json) return;
		const cfg = JSON.parse(vendorConfigJson(v, 'node /x mcp'));
		const entry = (cfg.mcpServers || cfg.mcp).stylewright;
		const env = entry.env || entry.environment;
		expect(Number(env.STYLEWRIGHT_WATCH_MS), 'config and watch budget disagree').toBe(v.configuredWatchMs);
		// Only some vendors express a timeout; where one exists the watch ends inside it.
		if (typeof entry.timeout === 'number') expect(v.configuredWatchMs).toBeLessThan(entry.timeout * 1000);
		// Kimi spells it `toolTimeoutMs`, already in milliseconds.
		if (typeof entry.toolTimeoutMs === 'number') expect(v.configuredWatchMs).toBeLessThan(entry.toolTimeoutMs);
	});

	it('states how long a watch really lasts rather than promising "once per session"', async () => {
		const { shadow } = await openAi({
			sessions: [session({ state: 'connected', watchMs: 3_540_000 })], boundId: 's1', offline: false
		});
		expect(text(shadow)).toContain('One watch lasts 59 minutes here');
		expect(text(shadow)).not.toContain('once per session is enough');
	});

	it('says why the window is short when the client caps it', async () => {
		const { shadow } = await openAi({
			sessions: [session({ state: 'connected', watchMs: 50_000 })], boundId: 's1', offline: false
		});
		expect(text(shadow)).toContain('One watch lasts 50 seconds here');
		expect(text(shadow)).toContain(AI_COPY.arm.short);
	});

	describe('copy to clipboard', () => {
		const setupState = (): SwAiState => ({
			sessions: [], boundId: null, offline: false,
			setup: { command: 'node /abs/dist/mcp.js mcp', published: false, binPath: '/abs/dist/mcp.js' }
		});
		const openSetup = async (label = 'Claude Code') => {
			const ctx = await openAi(setupState());
			await openVendorSetup(ctx, label);
			return ctx;
		};
		const copyBtn = (s: ShadowRoot) => s.querySelector<HTMLElement>('button[aria-label="Copy to clipboard"]');

		/** Swap in a fake clipboard for one test and always put it back. */
		const withClipboard = async (impl: { writeText(t: string): Promise<void> } | undefined, fn: () => Promise<void>) => {
			const had = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
			const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
			Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: impl });
			try { await fn(); } finally {
				if (had && orig) Object.defineProperty(navigator, 'clipboard', orig);
				else delete (navigator as unknown as Record<string, unknown>).clipboard;
			}
		};

		it('puts a copy control on the command block', async () => {
			const { shadow } = await openSetup();
			expect(copyBtn(shadow)).toBeTruthy();
		});

		it('copies the exact command and confirms it', async () => {
			const written: string[] = [];
			await withClipboard({ writeText: async (t) => { written.push(t); } }, async () => {
				const { shadow } = await openSetup();
				copyBtn(shadow)!.click();
				await tick();
				expect(written).toEqual(['claude mcp add stylewright -- node /abs/dist/mcp.js mcp']);
				expect(copyBtn(shadow)!.textContent).toContain(AI_COPY.empty.copied);
			});
		});

		it('copies the Cline JSON when that tool is selected', async () => {
			const written: string[] = [];
			await withClipboard({ writeText: async (t) => { written.push(t); } }, async () => {
				const { shadow } = await openSetup(vendorById('cline')!.label);
				copyBtn(shadow)!.click();
				await tick();
				expect(JSON.parse(written[0]).mcpServers.stylewright.command).toBe('node');
			});
		});

		// navigator.clipboard needs a secure context, and `vite --host` serves plain
		// http:// on a LAN IP — which is not one. copyText is exercised directly
		// because faking an insecure context inside happy-dom is more fragile than
		// the behaviour it would be testing.
		it('reports failure rather than pretending, when nothing can copy', async () => {
			await withClipboard(undefined, async () => {
				const exec = document.execCommand;
				(document as unknown as { execCommand: () => boolean }).execCommand = () => false;
				try {
					expect(await copyText('anything')).toBe(false);
				} finally {
					(document as unknown as { execCommand: unknown }).execCommand = exec;
				}
			});
		});

		it('falls back to the legacy path when the clipboard API is missing', async () => {
			await withClipboard(undefined, async () => {
				const exec = document.execCommand;
				let used = false;
				(document as unknown as { execCommand: () => boolean }).execCommand = () => { used = true; return true; };
				try {
					expect(await copyText('anything')).toBe(true);
					expect(used).toBe(true);
				} finally {
					(document as unknown as { execCommand: unknown }).execCommand = exec;
				}
			});
		});
	});

	it('rounds durations to something a human reads', () => {
		expect(humanDuration(50_000)).toBe('50 seconds');
		expect(humanDuration(3_540_000)).toBe('59 minutes');
		expect(humanDuration(1_500_000)).toBe('25 minutes');
	});

	// Every step has to be something you can DO. "Make sure X is connected" was a
	// state to verify with no hint of how, on the one screen that has to work.
	it('states an action in every step', async () => {
		const ctx = await openAi();
		await openVendorSetup(ctx);
		const t = text(ctx.shadow);
		expect(t).toContain(AI_COPY.empty.step3);
		expect(t).toContain('watch for Stylewright edits');   // the arming phrase, verbatim
		expect(t).not.toContain('Make sure the stylewright MCP server is connected');
	});
});

// Gating setup on "the list is empty" meant the only explanation of how to
// connect an agent vanished the instant one connected — so you could never add a
// second tool, or re-read what you configured.
describe('setup stays reachable once an agent is connected', () => {
	const withSession = () => openAi({ sessions: [session({ state: 'connected' })], boundId: null, offline: false,
		setup: { command: 'node /abs/dist/mcp.js mcp', published: false, binPath: '/abs/dist/mcp.js' } });

	// Gating setup on "the list is empty" meant the only explanation of how to
	// connect an agent vanished the instant one connected — so you could never add
	// a second tool, or re-read what you had done. Settings does not know or care
	// how many sessions exist.
	it('is reachable from Settings with a session already connected', async () => {
		const ctx = await withSession();
		await openVendorSetup(ctx);
		const t = text(ctx.shadow);
		expect(t).toContain(AI_COPY.empty.step3);
		expect(t).toContain('claude mcp add stylewright -- node /abs/dist/mcp.js mcp');
	});

	it('the chip still offers a route to it', async () => {
		const ctx = await withSession();
		ctx.shadow.querySelector<HTMLElement>('[data-sw-chip]')!.click();
		await tick();
		expect(text(ctx.shadow)).toContain(AI_COPY.pop.title);      // the list
		const btn = byText(ctx.shadow, AI_COPY.pop.setup);
		expect(btn, 'no way to reach setup from the list').toBeTruthy();
		btn!.click();
		await tick();
		expect(text(ctx.shadow)).toContain(AI_COPY.settings.agents);
	});

	// Refresh used to force you back to the list, throwing away the instructions
	// you had deliberately opened. There is no list to be thrown back to now.
	it('Refresh does not eject you from the setup you opened', async () => {
		const ctx = await withSession();
		await openVendorSetup(ctx);
		byText(ctx.shadow, AI_COPY.pop.refresh)!.click();
		await tick();
		expect(text(ctx.shadow)).toContain(AI_COPY.empty.step3);   // still on setup
	});

	it('says the entry is not per-project — the thing nobody guesses', async () => {
		const ctx = await openAi();
		await openSettings(ctx);
		expect(text(ctx.shadow)).toContain(AI_COPY.empty.oneEntry);
	});
});

describe('Send is never disabled and never silently drops the prompt', () => {
	// The refusal is stated next to the button that produced it, not inside a
	// surface you can dismiss with a stray click and never read.
	it('says so inline, keeps the draft, and sends nothing', async () => {
		const { shadow, fake } = await openAi();
		const box = ta(shadow)!;
		box.value = 'make this a primary button';
		box.dispatchEvent(new Event('input'));
		await tick();

		byText(shadow, AI_COPY.composer.send)!.click();
		await tick();

		expect(fake.sent).toHaveLength(0);
		expect(text(shadow)).toContain(AI_COPY.empty.blocked); // "Nothing was sent…"
		expect(ta(shadow)!.value).toBe('make this a primary button');
		// …and the notice survives the click that dismisses the dropdown.
		document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await tick();
		expect(text(shadow)).toContain(AI_COPY.empty.blocked);
	});

	it('keeps the same text after linking, and sends it', async () => {
		const { shadow, fake } = await openAi({ sessions: [session()], boundId: null, offline: false });
		const box = ta(shadow)!;
		box.value = 'add a loading spinner';
		box.dispatchEvent(new Event('input'));
		await tick();

		byText(shadow, AI_COPY.composer.send)!.click();   // blocked → session list
		await tick();
		expect(text(shadow)).toContain(AI_COPY.pop.title);

		byText(shadow, AI_COPY.pop.link)!.click();        // link it
		await tick();
		expect(ta(shadow)!.value).toBe('add a loading spinner');

		byText(shadow, AI_COPY.composer.send)!.click();
		await tick();
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].prompt).toBe('add a loading spinner');
	});

	it('does nothing at all on an empty prompt', async () => {
		const { shadow, fake } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		byText(shadow, AI_COPY.composer.send)!.click();
		await tick();
		expect(fake.sent).toHaveLength(0);
		expect(text(shadow)).not.toContain(AI_COPY.empty.blocked);   // nothing to refuse
	});

	it('sends the resolved source file and the parsed style rules', async () => {
		const { shadow, fake } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		const box = ta(shadow)!;
		box.value = 'tighten the padding';
		box.dispatchEvent(new Event('input'));
		await tick();
		byText(shadow, AI_COPY.composer.send)!.click();
		await tick();
		const r = fake.sent[0];
		expect(r.source.file).toBe('src/Button.svelte');
		expect(r.source.componentName).toBe('Button');
		expect(r.context.styleRules?.[0].selector).toBe('.btn');
	});
});

describe('the task log', () => {
	const withTasks = (tasks: Partial<SwAiTask>[]): SwAiState => ({
		sessions: [session()], boundId: 's1', offline: false,
		tasks: tasks.map((t, i) => ({
			id: 't' + i, prompt: 'make it blue', file: 'src/Button.svelte',
			status: 'done', createdAt: i, updatedAt: i, ...t
		})) as SwAiTask[]
	});

	it('keeps the composer on screen while a task runs — no dismiss step', async () => {
		const { shadow } = await openAi(withTasks([{ status: 'working' }]));
		expect(ta(shadow), 'composer vanished while working').toBeTruthy();
		expect(byText(shadow, AI_COPY.composer.send)).toBeTruthy();
		expect(text(shadow)).not.toContain('Send another');
	});

	it('shows each request as its own card, oldest first', async () => {
		const { shadow } = await openAi(withTasks([
			{ id: 'a', prompt: 'round the corners', status: 'done' },
			{ id: 'b', prompt: 'make it teal', status: 'working' }
		]));
		const t = text(shadow);
		expect(t).toContain('round the corners');
		expect(t).toContain('make it teal');
		expect(t.indexOf('round the corners')).toBeLessThan(t.indexOf('make it teal'));
	});

	it('carries the file list on a finished card', async () => {
		const { shadow } = await openAi(withTasks([
			{ status: 'done', filesTouched: [{ path: 'src/lib/Button.svelte', mark: 'M', note: '+22 −4' }] }
		]));
		const t = text(shadow);
		expect(t).toContain('src/lib/Button.svelte');
		expect(t).toContain('+22 −4');
		expect(t).toContain('1 files written · HMR ok');
	});

	it('offers Cancel only while a card is still queued', async () => {
		const q = await openAi(withTasks([{ status: 'queued' }]));
		expect(byText(q.shadow, AI_COPY.status.cancel)).toBeTruthy();
		const w = await openAi(withTasks([{ status: 'working' }]));
		expect(byText(w.shadow, AI_COPY.status.cancel)).toBeNull();
	});

	it('puts a failed prompt back in the box to retry', async () => {
		const { shadow } = await openAi(withTasks([{ status: 'error', prompt: 'add a shadow', message: 'the session stopped' }]));
		expect(text(shadow)).toContain('the session stopped');
		byText(shadow, AI_COPY.status.retry)!.click();
		await tick();
		expect(ta(shadow)!.value).toBe('add a shadow');
	});

	it('explains itself when there is nothing in the log yet', async () => {
		const { shadow } = await openAi({ sessions: [session()], boundId: 's1', offline: false, tasks: [] });
		expect(text(shadow)).toContain(AI_COPY.log.empty);
	});

	it('offers Clear history only once there is history', async () => {
		const none = await openAi({ sessions: [session()], boundId: 's1', offline: false, tasks: [] });
		expect(byText(none.shadow, AI_COPY.log.clear)).toBeNull();
		const some = await openAi(withTasks([{ status: 'done' }]));
		expect(byText(some.shadow, AI_COPY.log.clear)).toBeTruthy();
	});

	it('announces status changes politely for a screen reader', async () => {
		const { shadow } = await openAi(withTasks([{ status: 'working' }]));
		expect(shadow.querySelector('[aria-live="polite"]')).toBeTruthy();
	});
});

describe('a session that disappears mid-task', () => {
	it('flips the chip amber and keeps the prompt', async () => {
		const { shadow, fake } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		const box = ta(shadow)!;
		box.value = 'round the corners';
		box.dispatchEvent(new Event('input'));
		await tick();

		fake.set({ sessions: [session({ state: 'gone' })], boundId: 's1', offline: true });
		await tick();

		expect(text(shadow)).toContain('visual · offline');
		expect(text(shadow)).toContain(AI_COPY.offline.body);
		expect(ta(shadow)!.value).toBe('round the corners');
	});
});

describe('the linked-but-not-watching gap', () => {
	// An MCP server cannot make an idle agent start working. A session that is
	// linked but not watching will never claim the request, so the overlay has to
	// say so rather than queue forever.
	it('nudges when the bound session is connected but not watching', async () => {
		const { shadow } = await openAi({ sessions: [session({ state: 'connected' })], boundId: 's1', offline: false });
		expect(text(shadow)).toContain('visual isn’t watching yet');
		expect(text(shadow)).toContain(AI_COPY.arm.cmd);
	});

	it('says nothing when the session is actually watching', async () => {
		const { shadow } = await openAi({ sessions: [session({ state: 'watching' })], boundId: 's1', offline: false });
		expect(text(shadow)).not.toContain('isn’t watching yet');
	});
});

// Targeting an element in the AI tab is half a sentence: the other half is typed.
// Making someone click into the box between the two is friction with no purpose.
describe('picking an element in the AI tab', () => {
	it('puts the caret in the composer', async () => {
		const ctx = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		ta(ctx.shadow)!.blur();
		await tick();
		await ctx.panel.pick('src/Card.svelte', { ...META, fileLabel: 'Card.svelte', selectorLabel: '.card' });
		await tick();
		expect(ctx.shadow.activeElement).toBe(ta(ctx.shadow));
	});

	it('leaves focus alone while a request is in flight, when the log is the point', async () => {
		const ctx = await openAi({
			sessions: [session()], boundId: 's1', offline: false,
			current: { id: 'r1', prompt: 'make it wider', status: 'working', files: [] }
		} as unknown as SwAiState);
		ta(ctx.shadow)?.blur();
		await tick();
		await ctx.panel.pick('src/Card.svelte', { ...META, fileLabel: 'Card.svelte' });
		await tick();
		expect(ctx.shadow.activeElement).not.toBe(ta(ctx.shadow));
	});

	// `current` outlives the work so the finished request keeps rendering its file
	// list. Treating "there is a current" as "the agent is busy" meant the composer
	// stopped taking focus for the rest of the session after the very first request —
	// which is exactly when you go target the next thing and type.
	it('still takes focus once an earlier request has finished', async () => {
		const ctx = await openAi({
			sessions: [session()], boundId: 's1', offline: false,
			current: { id: 'r1', prompt: 'add a third button', status: 'done', files: [] }
		} as unknown as SwAiState);
		ta(ctx.shadow)?.blur();
		await tick();
		await ctx.panel.pick('src/Card.svelte', { ...META, fileLabel: 'Card.svelte' });
		await tick();
		expect(ctx.shadow.activeElement).toBe(ta(ctx.shadow));
	});

	it('does not steal focus for a pick made from the Styles tab', async () => {
		const ctx = await openAi();
		byText(ctx.shadow, AI_COPY.tabs.styles)!.click();
		await tick();
		await ctx.panel.pick('src/Card.svelte', { ...META, fileLabel: 'Card.svelte' });
		await tick();
		expect(ta(ctx.shadow)).toBeNull(); // composer isn't even mounted
	});
});

describe('the CSS editor is not collateral damage', () => {
	it('keeps the caret in the prompt box across the re-render every keystroke causes', async () => {
		const { shadow } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		const box = ta(shadow)!;
		box.focus();
		box.value = 'make it wider';
		box.setSelectionRange(4, 4);
		box.dispatchEvent(new Event('input'));
		await tick();
		const after = ta(shadow)!;
		expect(shadow.activeElement).toBe(after);
		expect(after.selectionStart).toBe(4); // not slammed to the end
	});

	it('does not write CSS when ⌘S is pressed in the Ask AI tab', async () => {
		const { shadow, saved } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		expect(saved.rules).toBeNull();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
		await tick();
		expect(saved.rules).toBeNull(); // ⌘S in this tab edits no CSS, so it writes none
		void shadow;
	});

	it('leaves ⌘Z to the browser in the prompt box instead of driving CSS undo', async () => {
		const { shadow } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
		window.dispatchEvent(ev);
		await tick();
		expect(ev.defaultPrevented).toBe(false); // the panel did not swallow it
		expect(ta(shadow)).toBeTruthy();
	});

	it('still handles ⌘S in the Styles tab', async () => {
		const { shadow, saved } = await openAi({ sessions: [session()], boundId: 's1', offline: false });
		byText(shadow, AI_COPY.tabs.styles)!.click();
		await tick();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
		await tick();
		vi.useFakeTimers();
		vi.advanceTimersByTime(300);
		vi.useRealTimers();
		await tick();
		await new Promise((r) => setTimeout(r, 250));
		expect(saved.rules).not.toBeNull();
	});
});

// A dev overlay is used ACROSS reloads. Losing the panel, the tab and the layout
// on every refresh means repeating the same clicks each time.
describe('the panel remembers itself across a reload', () => {
	const KEY = '__stylewright_ui';
	beforeEach(() => localStorage.removeItem(KEY));
	afterEach(() => localStorage.removeItem(KEY));

	/** Tear the panel down (as a reload does) and mount a fresh one. */
	const reload = async (initial: SwAiState = emptyState()) => {
		while (mounted.length) mounted.pop()!.destroy();
		document.body.innerHTML = '';
		const ctx = mount(initial);
		await tick();
		return ctx;
	};

	it('reopens on the component it was editing, on the tab it was on', async () => {
		const a = await openAi();
		expect(ta(a.shadow)).toBeTruthy();               // on Ask AI, editing Button.svelte

		const b = await reload();
		expect(byText(b.shadow, AI_COPY.tabs.styles), 'panel is open, not closed').toBeTruthy();
		expect(byText(b.shadow, AI_COPY.tabs.ai)).toBeTruthy();
		expect(ta(b.shadow), 'came back on the Styles tab').toBeTruthy();
	});

	it('keeps the dock, the DOM pane and the tool choice', async () => {
		const a = await openAi();
		const st = (p: Panel) => (p as unknown as { state: Record<string, unknown> }).state;
		const setState = (p: Panel, patch: Record<string, unknown>): void =>
			(p as unknown as { setState(x: Record<string, unknown>): void }).setState(patch);
		setState(a.panel, { dock: 'bottom', showHtml: true, aiTool: 'cline' });
		await tick();

		const b = await reload();
		expect(st(b.panel).dock).toBe('bottom');
		expect(st(b.panel).showHtml).toBe(true);
		expect(st(b.panel).aiTool).toBe('cline');
	});

	it('stays closed if it was closed', async () => {
		const a = mount();
		mounted.push(a.panel);
		await tick();                                     // never opened
		const b = await reload();
		expect(ta(b.shadow)).toBeNull();
		expect(b.shadow.querySelector('.sw-fab')).toBeTruthy();
	});

	it('ignores a stale or corrupt entry rather than failing to boot', async () => {
		localStorage.setItem(KEY, '{"v":999,"dock":"sideways","size":{"side":"huge"}}');
		const b = await reload();
		const st = (b.panel as unknown as { state: Record<string, unknown> }).state;
		expect(st.dock).toBe('right');                    // the default, not "sideways"
		expect((st.size as { side: number }).side).toBeGreaterThanOrEqual(300);
	});

	it('survives storage being unavailable', async () => {
		const orig = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() { throw new Error('blocked in private mode'); }
		});
		try {
			const b = await reload();
			expect(b.shadow.querySelector('.sw-fab')).toBeTruthy();   // still boots
		} finally {
			if (orig) Object.defineProperty(window, 'localStorage', orig);
		}
	});
});

describe('settings', () => {
	const gear = (s: ShadowRoot) => s.querySelector<HTMLElement>('button[aria-label="Settings"]');
	const st = (p: Panel) => (p as unknown as { state: Record<string, unknown> }).state;
	const open = async (ctx: { shadow: ShadowRoot }) => { gear(ctx.shadow)!.click(); await tick(); };

	it('opens from the header', async () => {
		const ctx = await openAi();
		expect(gear(ctx.shadow)).toBeTruthy();
		await open(ctx);
		expect(text(ctx.shadow)).toContain(AI_COPY.settings.autoPick);
	});

	// Each setting is a row in one array, so a future one is a line of data
	// rather than another control wedged into a 300px header.
	it('renders every setting as a switch with a reason', async () => {
		const ctx = await openAi();
		await open(ctx);
		const switches = ctx.shadow.querySelectorAll('[role="switch"]');
		expect(switches.length).toBeGreaterThanOrEqual(3);
		expect(text(ctx.shadow)).toContain(AI_COPY.settings.autoPickHint);
	});

	it('turning off "Click to select" stops the picker arming itself', async () => {
		const ctx = await openAi();
		expect(ctx.panel.isPicking()).toBe(true);
		await open(ctx);
		byText(ctx.shadow, AI_COPY.settings.autoPick)?.click()
			?? (ctx.shadow.querySelector('[role="switch"]') as HTMLElement).click();
		await tick();
		expect(st(ctx.panel).autoPick).toBe(false);
		expect(ctx.panel.isPicking()).toBe(false);
	});

	it('survives a reload', async () => {
		const a = await openAi();
		await open(a);
		(a.shadow.querySelector('[role="switch"]') as HTMLElement).click();
		await tick();
		while (mounted.length) mounted.pop()!.destroy();
		document.body.innerHTML = '';
		const b = mount();
		await tick();
		expect(st(b.panel).autoPick).toBe(false);
	});

	// It is a pane now, not a popover, so an outside click must NOT close it —
	// clicking the page is how you re-target an element, and losing the pane to
	// every stray click would make it unusable.
	it('is a tab, and the gear goes back to where you came from', async () => {
		const ctx = await openAi();
		expect(st(ctx.panel).aiTab).toBe('ai');
		await open(ctx);
		expect(st(ctx.panel).aiTab).toBe('settings');
		document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await tick();
		expect(st(ctx.panel).aiTab, 'an outside click closed the pane').toBe('settings');
		await open(ctx);
		expect(st(ctx.panel).aiTab).toBe('ai');
	});

	// Escape backs out one level rather than jumping straight out of Settings.
	it('Escape leaves a vendor’s setup before it leaves Settings', async () => {
		const ctx = await openAi();
		await open(ctx);
		[...ctx.shadow.querySelectorAll<HTMLElement>('[role="switch"][aria-label="Cline"]')[0]
			.parentElement!.querySelectorAll<HTMLElement>('button')]
			.find((b) => (b.textContent || '').trim() === AI_COPY.settings.setupFor)!.click();
		await tick();
		expect(st(ctx.panel).settingsVendor).toBe('cline');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await tick();
		expect(st(ctx.panel).settingsVendor).toBeNull();
		expect(st(ctx.panel).aiTab).toBe('settings');
	});

	// Settings is somewhere you go to change one thing. Being dropped back into
	// it on every reload would be a bug, not a convenience.
	it('is never the tab you come back to', async () => {
		const a = await openAi();
		await open(a);
		expect(st(a.panel).aiTab).toBe('settings');
		while (mounted.length) mounted.pop()!.destroy();
		document.body.innerHTML = '';
		const b = mount();
		await tick();
		expect(st(b.panel).aiTab).not.toBe('settings');
	});
});

describe('the picker', () => {
	it('is live as soon as the panel is open — no arming click', async () => {
		const ctx = await openAi();
		expect(ctx.panel.isPicking()).toBe(true);
	});

	it('is off while the panel is closed', async () => {
		const ctx = mount();
		await tick();
		expect(ctx.panel.isPicking()).toBe(false);
	});

	// Returning early over our own UI used to leave the last page element
	// highlighted, so the panel looked like it was still aiming at something
	// while you were reading the panel.
	it('drops the highlight when the pointer moves onto the panel', async () => {
		const ctx = await openAi();
		const st = (ctx.panel as unknown as { state: { hl: unknown } }).state;
		ctx.panel.hover(new DOMRect(0, 0, 10, 10), '<div>', 'a.svelte');
		await tick();
		expect(st.hl).toBeTruthy();
		ctx.panel.clearHover();
		await tick();
		expect(st.hl).toBeNull();
	});
});

describe('Escape ladder', () => {
	it('closes the session dropdown before it cancels anything else', async () => {
		const { shadow } = await openAi();
		shadow.querySelector<HTMLElement>('[data-sw-chip]')!.click();
		await tick();
		expect(text(shadow)).toContain(AI_COPY.pop.title);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await tick();
		expect(text(shadow)).not.toContain(AI_COPY.pop.title);
		expect(ta(shadow)).toBeTruthy(); // still on the AI tab, nothing else cancelled
	});
});
