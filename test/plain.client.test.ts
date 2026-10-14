// @vitest-environment happy-dom
//
// Plain-HTML mode in the overlay: which configured sources a page uses, showing a
// save without HMR, and the panel's behaviour when rules come from several
// sources — including what Ask AI hands the agent.

import { describe, it, expect, afterEach } from 'vitest';
import { sourcesOnPage, applyLiveUpdates } from '../src/client/plain.js';
import { Panel, rekeyToCurrent, type PanelHost, type PickMeta, type AiHost } from '../src/client/panel.js';
import { fromServerRules } from '../src/client/rules.js';
import { PLAIN_FILE, type SwRule, type SwSource, type SwAiRequest, type SwAiState } from '../src/shared/protocol.js';
import { AI_COPY } from '../src/client/aiCopy.js';

afterEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	// The panel persists its layout (incl. the active tab) across mounts.
	try { localStorage.removeItem('__stylewright_ui'); } catch { /* ignore */ }
});

const BASE = '\n.btn { color: #333; }\n.rail { width: 260px; }\n';
const EXTRA = '.ws .btn{color:#4fa878}';
const src = (key: string, css: string, extra: Partial<SwSource> = {}): SwSource => ({ key, file: key.split('#')[0], css, ...extra });

describe('sourcesOnPage', () => {
	it('finds template-literal sources by their text in a page <style>, even concatenated', () => {
		document.head.innerHTML = `<style>${BASE}${EXTRA}</style>`;
		const on = sourcesOnPage([src('a.js#STYLE', BASE), src('b.js#WS', EXTRA), src('c.js#SETTINGS', '.st{}')]);
		expect([...on]).toEqual(['a.js#STYLE', 'b.js#WS']);
	});

	it('drops a source whose file changed since the page loaded', () => {
		document.head.innerHTML = `<style>${BASE}</style>`;
		expect(sourcesOnPage([src('a.js#STYLE', BASE.replace('#333', '#444'))]).size).toBe(0);
	});

	it('counts a .css file the page links, and ignores sources with an error', () => {
		// Only the link's href matters. A real <link> makes happy-dom fetch it, so
		// stand in for the two queries sourcesOnPage makes.
		const doc = {
			baseURI: 'http://127.0.0.1:5180/p/x',
			querySelectorAll: (q: string) => (q === 'style' ? [] : [{ href: '/assets/app.css?v=2' }])
		} as unknown as Document;
		const on = sourcesOnPage([src('public/assets/app.css', '.x{}'), src('other.css', '.y{}'), src('a.js#S', BASE, { error: 'gone' })], doc);
		expect([...on]).toEqual(['public/assets/app.css']);
	});
});

describe('applyLiveUpdates', () => {
	it('swaps a source\'s old CSS for its new CSS in place', () => {
		document.head.innerHTML = `<style>${BASE}${EXTRA}</style>`;
		const ok = applyLiveUpdates([{ before: BASE, after: BASE.replace('#333', '#e00') }]);
		expect(ok).toBe(true);
		expect(document.querySelector('style')!.textContent).toBe(BASE.replace('#333', '#e00') + EXTRA);
	});

	it('treats $ in CSS literally', () => {
		document.head.innerHTML = '<style>.a{content:"x"}</style>';
		applyLiveUpdates([{ before: '.a{content:"x"}', after: ".a{content:\"$&$'\"}" }]);
		expect(document.querySelector('style')!.textContent).toBe(".a{content:\"$&$'\"}");
	});

	it('reports when an update has nowhere to go', () => {
		document.head.innerHTML = '<style>.other{}</style>';
		expect(applyLiveUpdates([{ before: BASE, after: BASE }])).toBe(false);
	});
});

describe('the panel in plain-HTML mode', () => {
	const RULES: SwRule[] = [
		{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: '#333' }], origin: 'hub/html.js#STYLE' },
		{ id: 1, selector: '.rail', decls: [{ prop: 'width', value: '260px' }], origin: 'hub/html.js#STYLE' },
		{ id: 1_000_000, selector: '.ws .btn', decls: [{ prop: 'color', value: '#4fa878' }], origin: 'hub/ws.js#WS' }
	];
	const META: PickMeta = { fileLabel: '', selectorLabel: '.btn', dims: '10 × 10', tag: '<button class="btn">' };
	const mounted: Panel[] = [];
	afterEach(() => { while (mounted.length) mounted.pop()!.destroy(); });

	const tick = async (): Promise<void> => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	};

	function mount() {
		document.body.innerHTML = '<div class="ws"><nav class="rail"><button class="btn">Go</button></nav></div>';
		const hostEl = document.createElement('div');
		document.body.appendChild(hostEl);
		const shadow = hostEl.attachShadow({ mode: 'open' });
		const sent: SwAiRequest[] = [];
		const applied: { file: string; rules: SwRule[] }[] = [];
		let state: SwAiState = { sessions: [{ id: 's1', name: 'gk', tool: 'Claude Code', cwd: '/x', sameProject: true, state: 'watching', connectedAt: 1, lastSeenAt: 1 }], boundId: 's1', offline: false };
		const ai: AiHost = {
			state: async () => state, link: async () => state, unlink: async () => state, refresh: async () => state,
			clear: async () => state, cancel: async () => state,
			send: async (r) => { sent.push(r); state = { ...state, current: { requestId: r.id, status: 'queued', startedAt: 1, updatedAt: 1 } }; return { ok: true, requestId: r.id, status: 'queued' }; },
			subscribe: (fn) => { fn(state); return () => {}; }
		};
		const host: PanelHost = {
			loadRules: async () => ({ hasStyle: true, rules: RULES }),
			applyRules: async (file, rules) => { applied.push({ file, rules }); return { ok: true, changed: true, updates: [{ key: 'hub/html.js#STYLE', before: '', after: '' }], livePatched: true }; },
			saveCss: async () => ({ ok: true, changed: true }),
			ai
		};
		const panel = new Panel(shadow, host);
		mounted.push(panel);
		return { panel, shadow, sent, applied, btn: document.querySelector('.btn')! };
	}

	it('names the source of each rule, and the file holding the element\'s most specific rule', async () => {
		const { panel, shadow, btn } = mount();
		await panel.pick(PLAIN_FILE, META, btn);
		await tick();
		const text = shadow.textContent || '';
		expect(text).toContain('html.js');
		expect(text).toContain('ws.js');
		// `.ws .btn` is the last rule that matches the button itself.
		expect(text).toContain('hub/ws.js');
	});

	it('sends Ask AI the real source file and the rules that style the element', async () => {
		const { panel, shadow, sent, btn } = mount();
		await panel.pick(PLAIN_FILE, META, btn);
		await tick();
		[...shadow.querySelectorAll<HTMLElement>('button')].find((b) => (b.textContent || '').trim() === AI_COPY.tabs.ai)!.click();
		await tick();
		const box = shadow.querySelector<HTMLTextAreaElement>('textarea[data-fkey="ai-prompt"]')!;
		box.value = 'make it the primary green';
		box.dispatchEvent(new Event('input'));
		await tick();
		[...shadow.querySelectorAll<HTMLElement>('button')].find((b) => (b.textContent || '').trim() === AI_COPY.composer.send)!.click();
		await tick();
		expect(sent).toHaveLength(1);
		const r = sent[0];
		expect(r.source.file).toBe('hub/ws.js');
		expect(r.source.componentName).toBeUndefined();
		const sels = r.context.styleRules!.map((x) => x.selector);
		expect(sels.slice(0, 2).sort()).toEqual(['.btn', '.ws .btn']);
		expect(r.context.styleRules!.every((x) => x.origin)).toBe(true);
		// No component boundary to stop at: the path climbs the page.
		expect(r.element.selector).toBe('.ws > .rail > .btn');
	});

	it('saves to the page key and says the page was updated', async () => {
		const { panel, shadow, applied, btn } = mount();
		await panel.pick(PLAIN_FILE, META, btn);
		await tick();
		(panel as unknown as { updateDecl(ri: number, di: number, f: 'v', v: string): void }).updateDecl(0, 0, 'v', '#e00');
		(panel as unknown as { save(): void }).save();
		await new Promise((r) => setTimeout(r, 260));
		await tick();
		expect(applied[0].file).toBe(PLAIN_FILE);
		expect(applied[0].rules.every((x) => x.origin)).toBe(true);
		expect(shadow.textContent).toContain('Saved · page updated');
	});

	it('keeps a restored pick\'s saved label — with no element there is no evidence to relabel it', async () => {
		const { panel, shadow } = mount();
		await panel.pick(PLAIN_FILE, { ...META, fileLabel: 'hub/ws.js' }, null, { restore: true });
		await tick();
		expect(shadow.textContent).toContain('hub/ws.js');
		expect(shadow.textContent).not.toContain('hub/html.js');
	});

	it('never re-keys an undo across sources', () => {
		const snap = fromServerRules([{ id: 5, selector: '.btn', decls: [], origin: 'a.js#A' }]);
		const current = fromServerRules([{ id: 1_000_000, selector: '.btn', decls: [], origin: 'b.js#B' }]);
		const { rules, removeIds } = rekeyToCurrent(snap, current);
		expect(rules[0].id).toBeUndefined();
		expect(rules[0].origin).toBe('a.js#A');
		expect(removeIds).toEqual([1_000_000]);
	});
});
