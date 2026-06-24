// @vitest-environment happy-dom
//
// Integration tests that drive the REAL Panel through the interaction sequences
// that kept breaking (render loops, menus closing on hover/type, caret jumps,
// stranded empty declarations). happy-dom is faithful for shadow DOM, focus/blur
// events and selection — but it does NOT fire `blur` when a focused node is
// removed (the browser does, and that's what caused the menu-close bug), so we
// shim that one documented behavior. A `render` counter turns any infinite
// re-render loop into a fast, clear failure instead of a hang.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Panel, rekeyToCurrent, type PanelHost, type PickMeta } from '../src/client/panel.js';
import type { SwRule } from '../src/shared/protocol.js';
import { fromServerRules, type Rule } from '../src/client/rules.js';

const META: PickMeta = { fileLabel: 'Button.svelte', selectorLabel: '.btn', dims: '0 × 0', tag: '<button class="btn">' };
const RULES: SwRule[] = [
	{ selector: '.btn', decls: [{ prop: 'color', value: '#333' }, { prop: 'display', value: 'flex' }] }
];

let origRemoveChild: typeof Node.prototype.removeChild;

beforeEach(() => {
	vi.useFakeTimers();
	// Browser parity: removing a subtree that contains the focused element blurs it.
	origRemoveChild = Node.prototype.removeChild;
	Node.prototype.removeChild = function <T extends Node>(child: T): T {
		const root = this.getRootNode?.() as Document | ShadowRoot | undefined;
		const active = root && (root as ShadowRoot).activeElement;
		if (active && (child === (active as unknown as Node) || (child as unknown as Element).contains?.(active))) {
			active.dispatchEvent(new Event('blur'));
		}
		return origRemoveChild.call(this, child) as T;
	};
});
afterEach(() => {
	Node.prototype.removeChild = origRemoveChild;
	vi.useRealTimers();
	document.body.innerHTML = '';
});

function makePanel(rules: SwRule[] = RULES) {
	const hostEl = document.createElement('div');
	document.body.appendChild(hostEl);
	const shadow = hostEl.attachShadow({ mode: 'open' });
	const saved: { rules: SwRule[] | null; opts: { removeIds?: number[]; mediaRenames?: { id: number; params: string }[] } | undefined } = { rules: null, opts: undefined };
	const host: PanelHost = {
		loadRules: async () => ({ hasStyle: true, rules }),
		applyRules: async (_file, sent, opts) => { saved.rules = sent; saved.opts = opts; return { ok: true, changed: true }; },
		saveCss: async () => ({ ok: true, changed: true }) // legacy path, unused by the panel
	};
	const panel = new Panel(shadow, host);
	// Turn an infinite render loop into a fast failure rather than a timeout.
	let renders = 0;
	const orig = (panel as unknown as { render: () => void }).render.bind(panel);
	(panel as unknown as { render: () => void }).render = () => {
		if (++renders > 500) throw new Error(`render loop detected (${renders} renders)`);
		orig();
	};
	return { panel, shadow, saved, renderCount: () => renders };
}

/** Drain queued microtask renders (and the el() ref-flush microtask). */
async function tick(): Promise<void> { for (let i = 0; i < 6; i++) await Promise.resolve(); }
const q = (s: ShadowRoot, sel: string) => s.querySelector(sel) as HTMLElement | null;
const qi = (s: ShadowRoot, sel: string) => s.querySelector(sel) as HTMLInputElement | null;
const fkeyOf = (s: ShadowRoot) => (s.activeElement as HTMLElement | null)?.getAttribute('data-fkey') ?? null;
const menuOpen = (s: ShadowRoot) => !!s.querySelector('.sw-pop');
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
/** Type each character into whatever input is currently focused (re-querying after each render). */
async function typeInto(shadow: ShadowRoot, text: string): Promise<void> {
	for (const ch of text) {
		const el = shadow.activeElement as HTMLInputElement;
		el.value += ch;
		try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* */ }
		el.dispatchEvent(new Event('input'));
		await tick();
	}
}
const rules = (panel: Panel) => (panel as unknown as { state: { rules: { decls: { p: string; v: string }[] }[] } }).state.rules;

async function openEditor(customRules?: SwRule[]) {
	const ctx = makePanel(customRules);
	await ctx.panel.pick('Button.svelte', META);
	await tick();
	return ctx;
}

describe('Panel: focus does not loop', () => {
	it('focusing a value token settles (no infinite re-render)', async () => {
		const { shadow, renderCount } = await openEditor();
		const before = renderCount();
		q(shadow, 'input[data-fkey="0-1-v-0"]')!.focus(); // display: "flex"
		await tick();
		vi.advanceTimersByTime(300);
		await tick();
		expect(renderCount() - before).toBeLessThan(10); // a couple renders, not thousands
		expect(fkeyOf(shadow)).toBe('0-1-v-0'); // still focused after the rebuilds
	});
});

describe('Panel: type-ahead menu survives interaction', () => {
	it('stays open while hovering its suggestions', async () => {
		const { shadow } = await openEditor();
		const prop = qi(shadow, 'input[data-fkey="0-0-p-_"]')!; // "color"
		prop.value = ''; prop.focus(); prop.dispatchEvent(new Event('input')); // empty -> all suggestions
		await tick();
		expect(menuOpen(shadow)).toBe(true);
		const item = q(shadow, '.sw-pop')!.children[0] as HTMLElement;
		item.dispatchEvent(new Event('mouseenter'));
		await tick();
		vi.advanceTimersByTime(200); // the 140ms onBlur timer would have fired by now
		await tick();
		expect(menuOpen(shadow)).toBe(true); // menu must NOT close on hover
		expect(fkeyOf(shadow)).toBe('0-0-p-_'); // focus retained
	});

	it('stays open while typing into the property', async () => {
		const { shadow } = await openEditor();
		const prop = qi(shadow, 'input[data-fkey="0-0-p-_"]')!;
		prop.focus();
		await tick();
		prop.value = 'colo'; prop.dispatchEvent(new Event('input'));
		await tick();
		vi.advanceTimersByTime(200);
		await tick();
		expect(menuOpen(shadow)).toBe(true);
		expect(fkeyOf(shadow)).toBe('0-0-p-_');
	});
});

describe('Panel: add declaration', () => {
	it('opens an empty declaration with the property focused and typing works', async () => {
		const { shadow } = await openEditor();
		const addBtn = [...shadow.querySelectorAll('button')].find((b) => b.textContent?.includes('add declaration'))!;
		addBtn.dispatchEvent(new MouseEvent('click'));
		await tick();
		// new decl at index 2, property focused
		expect(fkeyOf(shadow)).toBe('0-2-p-_');
		const prop = qi(shadow, 'input[data-fkey="0-2-p-_"]')!;
		prop.value = 'm'; prop.dispatchEvent(new Event('input'));
		await tick();
		vi.advanceTimersByTime(200);
		await tick();
		expect(menuOpen(shadow)).toBe(true); // suggestions for "m" still open
		expect(fkeyOf(shadow)).toBe('0-2-p-_'); // didn't lose focus after a keystroke
	});

	it('removes the declaration if the property is abandoned empty (real blur)', async () => {
		const { panel, shadow } = await openEditor();
		const addBtn = [...shadow.querySelectorAll('button')].find((b) => b.textContent?.includes('add declaration'))!;
		addBtn.dispatchEvent(new MouseEvent('click'));
		await tick();
		const decls = () => (panel as unknown as { state: { rules: { decls: unknown[] }[] } }).state.rules[0].decls.length;
		expect(decls()).toBe(3);
		// genuine user blur (outside a render): the empty decl should be cleaned up
		q(shadow, 'input[data-fkey="0-2-p-_"]')!.dispatchEvent(new Event('blur'));
		vi.advanceTimersByTime(200);
		await tick();
		expect(decls()).toBe(2);
	});
});

describe('Panel: caret', () => {
	it('preserves the caret position when typing mid-string', async () => {
		const { shadow } = await openEditor();
		const prop = q(shadow, 'input[data-fkey="0-0-p-_"]')!; // "color"
		prop.focus();
		await tick();
		const live = q(shadow, 'input[data-fkey="0-0-p-_"]') as HTMLInputElement; // re-query after focus render
		live.value = 'coXlor';
		live.setSelectionRange(3, 3); // caret right after the inserted X
		live.dispatchEvent(new Event('input'));
		await tick();
		const after = q(shadow, 'input[data-fkey="0-0-p-_"]') as HTMLInputElement;
		expect(after.value).toBe('coXlor');
		expect(after.selectionStart).toBe(3); // NOT slammed to 6 (end)
	});
});

describe('Panel: value editing never corrupts', () => {
	it('typing a multi-char unit yields exactly "16px" (not "16xp")', async () => {
		const { panel, shadow } = await openEditor();
		qi(shadow, 'input[data-fkey="0-1-v-0"]')!.focus(); // display: flex
		await tick();
		const live = shadow.activeElement as HTMLInputElement;
		live.value = ''; live.dispatchEvent(new Event('input')); await tick();
		await typeInto(shadow, '16px');
		expect(rules(panel)[0].decls[1].v).toBe('16px');
	});

	it('typing a decimal yields exactly "1.5" (not "15.")', async () => {
		const { panel, shadow } = await openEditor();
		qi(shadow, 'input[data-fkey="0-1-v-0"]')!.focus();
		await tick();
		const live = shadow.activeElement as HTMLInputElement;
		live.value = ''; live.dispatchEvent(new Event('input')); await tick();
		await typeInto(shadow, '1.5rem');
		expect(rules(panel)[0].decls[1].v).toBe('1.5rem');
	});
});

describe('Panel: font-family commit', () => {
	it('focuses the font value input and does not wedge focus globally', async () => {
		const { shadow } = await openEditor();
		[...shadow.querySelectorAll('button')].find((b) => b.textContent?.includes('add declaration'))!.dispatchEvent(new MouseEvent('click'));
		await tick();
		qi(shadow, 'input[data-fkey="0-2-p-_"]')!.value = 'font-family';
		qi(shadow, 'input[data-fkey="0-2-p-_"]')!.dispatchEvent(new Event('input')); await tick();
		key(qi(shadow, 'input[data-fkey="0-2-p-_"]')!, 'Enter'); // re-query: the input was rebuilt
		await tick(); vi.advanceTimersByTime(10); await tick();
		expect(fkeyOf(shadow)).toBe('0-2-v-font'); // the single font input, not a missing numeric key
		// focus must not be wedged: a later click still takes focus
		qi(shadow, 'input[data-fkey="0-0-v-0"]')!.focus(); await tick();
		expect(fkeyOf(shadow)).toBe('0-0-v-0');
	});
});

describe('Panel: color hex typing', () => {
	it('types a hex incrementally without losing focus or reverting', async () => {
		const { panel, shadow } = await openEditor();
		(panel as unknown as { openColor: (a: number, b: number, c: number) => void }).openColor(0, 0, 0);
		await tick();
		qi(shadow, 'input[data-fkey="0-0-v-hex"]')!.focus(); await tick();
		const live = shadow.activeElement as HTMLInputElement;
		live.value = ''; live.dispatchEvent(new Event('input')); await tick();
		await typeInto(shadow, '#3b'); // partial — not a valid color
		expect(fkeyOf(shadow)).toBe('0-0-v-hex'); // focus retained through the partial
		expect(qi(shadow, 'input[data-fkey="0-0-v-hex"]')!.value).toBe('#3b'); // shows the partial, not the old color
		await typeInto(shadow, '82f6');
		expect(rules(panel)[0].decls[0].v.toLowerCase()).toBe('#3b82f6');
	});
});

describe('Panel: scrub + add cleanup + color seed', () => {
	it('wheel-scrubbing a number writes a save', async () => {
		const { shadow, saved } = await openEditor([{ selector: '.btn', decls: [{ prop: 'padding', value: '8px' }] }]);
		qi(shadow, 'input[data-fkey="0-0-v-0"]')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(250); await tick();
		expect(saved.rules?.some((r) => r.decls.some((d) => d.prop === 'padding'))).toBe(true); // persisted, not lost
	});

	it('adding a declaration prunes a prior abandoned-empty one', async () => {
		const { panel, shadow } = await openEditor();
		const addBtn = () => [...shadow.querySelectorAll('button')].find((b) => b.textContent?.includes('add declaration'))!;
		addBtn().dispatchEvent(new MouseEvent('click')); await tick();
		expect(rules(panel)[0].decls.length).toBe(3);
		addBtn().dispatchEvent(new MouseEvent('click')); await tick();
		expect(rules(panel)[0].decls.length).toBe(3); // pruned the empty, added one — not 4
	});

	it('tabbing into a font-family value auto-opens the font dropdown; typing filters + Tab commits', async () => {
		const { panel, shadow } = await openEditor([{ selector: '.btn', decls: [{ prop: 'color', value: '#333' }, { prop: 'font-family', value: '' }] }]);
		qi(shadow, 'input[data-fkey="0-1-p-_"]')!.focus(); await tick();
		key(qi(shadow, 'input[data-fkey="0-1-p-_"]')!, 'Enter'); // commit the font-family property → Tab into value
		await tick(); vi.advanceTimersByTime(10); await tick();
		expect(fkeyOf(shadow)).toBe('0-1-v-font'); // value focused
		expect(menuOpen(shadow)).toBe(true); // dropdown auto-opened
		await typeInto(shadow, 'geo'); // filter to Georgia
		key(shadow.activeElement!, 'Tab'); // commit highlighted
		await tick(); vi.advanceTimersByTime(160); await tick();
		expect(rules(panel)[0].decls[1].v).toContain('Georgia');
	});

	it('cycles the color notation hex → rgb → hsl from the picker', async () => {
		const { panel, shadow } = await openEditor([{ selector: '.btn', decls: [{ prop: 'color', value: '#ff0000' }] }]);
		(panel as unknown as { openColor: (a: number, b: number, c: number) => void }).openColor(0, 0, 0); await tick();
		const cycleBtn = () => [...shadow.querySelectorAll('button')].find((b) => ['HEX', 'RGB', 'HSL'].includes(b.textContent?.trim() ?? ''))!;
		expect(cycleBtn().textContent).toBe('HEX');
		cycleBtn().dispatchEvent(new MouseEvent('click')); await tick(); vi.advanceTimersByTime(250); await tick();
		expect(rules(panel)[0].decls[0].v).toBe('rgb(255, 0, 0)');
		cycleBtn().dispatchEvent(new MouseEvent('click')); await tick(); vi.advanceTimersByTime(250); await tick();
		expect(rules(panel)[0].decls[0].v).toBe('hsl(0, 100%, 50%)');
	});

	it('reverts an auto-seeded color closed untouched', async () => {
		const { panel } = await openEditor([{ selector: '.btn', decls: [{ prop: 'color', value: '' }] }]);
		const p = panel as unknown as { openColorForFirst: (a: number, b: number) => void; closeColorPicker: () => void };
		p.openColorForFirst(0, 0); await tick();
		expect(rules(panel)[0].decls[0].v).toBe('#6d5efc'); // seeded
		p.closeColorPicker(); await tick();
		expect(rules(panel)[0].decls[0].v).toBe(''); // reverted — no stray default left behind
	});
});

describe('Panel: @media awareness', () => {
	it('labels a responsive rule with an @media chip', async () => {
		const { shadow } = await openEditor([
			{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] },
			{ id: 1, selector: '.btn', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'color', value: 'navy' }] }
		]);
		expect(shadow.textContent || '').toContain('@media ≥768'); // chip rendered on the override
	});

	it('still renders a plain rule with no chip', async () => {
		const { shadow } = await openEditor([{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] }]);
		expect(shadow.textContent || '').not.toContain('≥'); // no @media chip on a plain rule (the "+ @media override" button is expected)
	});
});

describe('Panel: overridden-here flag', () => {
	let origMM: typeof window.matchMedia;
	beforeEach(() => { origMM = window.matchMedia; });
	afterEach(() => { window.matchMedia = origMM; });
	const stubMatch = (matches: boolean) => { (window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({ matches }); };
	const RESP = [
		{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] },
		{ id: 1, selector: '.btn', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'color', value: 'navy' }] }
	];

	it('flags a base decl overridden by an ACTIVE wider @media rule', async () => {
		stubMatch(true);
		const { shadow } = await openEditor(RESP);
		expect(shadow.textContent || '').toContain('↓'); // the override chip
	});

	it('does not flag when the wider rule is INACTIVE at the current width', async () => {
		stubMatch(false);
		const { shadow } = await openEditor(RESP);
		expect(shadow.textContent || '').not.toContain('↓');
	});

	it('does not flag when the override targets a DIFFERENT property', async () => {
		stubMatch(true);
		const { shadow } = await openEditor([
			{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] },
			{ id: 1, selector: '.btn', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'background', value: 'navy' }] }
		]);
		expect(shadow.textContent || '').not.toContain('↓');
	});
});

describe('Panel: structural ops (Phase 4 — create / remove / edit breakpoint)', () => {
	const TWO = [
		{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] },
		{ id: 1, selector: '.btn', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'color', value: 'navy' }] }
	];

	it('"+ @media override" sends an id-less rule carrying the base selector', async () => {
		const ctx = makePanel([{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] }]);
		await ctx.panel.pick('Button.svelte', META); await tick();
		[...ctx.shadow.querySelectorAll('button')].find((b) => b.title.includes('responsive @media override'))!
			.dispatchEvent(new MouseEvent('click'));
		await tick();
		const created = ctx.saved.rules!.find((r) => r.id == null);
		expect(created).toBeTruthy();
		expect(created!.selector).toBe('.btn');
		expect(created!.media?.[0].params).toContain('min-width');
	});

	it('the × on a responsive rule sends removeIds for that rule', async () => {
		const ctx = makePanel(TWO);
		await ctx.panel.pick('Button.svelte', META); await tick();
		[...ctx.shadow.querySelectorAll('button')].find((b) => b.title === 'Remove this rule')!
			.dispatchEvent(new MouseEvent('click'));
		await tick();
		expect(ctx.saved.opts?.removeIds).toEqual([1]);
	});

	it('editing a breakpoint sends a mediaRename for that rule id', async () => {
		const ctx = makePanel(TWO);
		await ctx.panel.pick('Button.svelte', META); await tick();
		[...ctx.shadow.querySelectorAll('button')].find((b) => b.title.includes('Edit this breakpoint'))!
			.dispatchEvent(new MouseEvent('click'));
		await tick();
		const input = [...ctx.shadow.querySelectorAll('input')].find((i) => (i as HTMLInputElement).value === '768') as HTMLInputElement;
		expect(input).toBeTruthy();
		input.value = '1024';
		input.dispatchEvent(new Event('blur'));
		await tick(); vi.advanceTimersByTime(10); await tick();
		expect(ctx.saved.opts?.mediaRenames?.[0]).toEqual({ id: 1, params: '(min-width: 1024px)' });
	});
});

describe('Panel: breakpoint switcher', () => {
	let origMM: typeof window.matchMedia;
	beforeEach(() => { origMM = window.matchMedia; });
	afterEach(() => { window.matchMedia = origMM; });
	const RESP = [
		{ id: 0, selector: '.btn', decls: [{ prop: 'padding', value: '8px' }] },
		{ id: 1, selector: '.btn', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'padding', value: '16px' }] }
	];

	it('shows Live + Base + a chip per real @media width', async () => {
		const { shadow } = await openEditor(RESP);
		const text = shadow.textContent || '';
		expect(text).toContain('Live');
		expect(text).toContain('Base');
		expect(text).toContain('≥768');
	});

	it('has no switcher when the component has no width @media', async () => {
		const { shadow } = await openEditor([{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'red' }] }]);
		expect(shadow.textContent || '').not.toContain('WIDTH'); // the switcher's label
	});

	it('previews a chosen width without the real viewport (what-if dimming)', async () => {
		(window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({ matches: false }); // real width: @media inactive
		const ctx = makePanel(RESP);
		await ctx.panel.pick('Button.svelte', META); await tick();
		expect(ctx.shadow.textContent || '').not.toContain('↓'); // Live + inactive → nothing overridden
		[...ctx.shadow.querySelectorAll('button')].find((b) => (b.textContent || '') === '≥768' && b.title.includes('Preview'))!
			.dispatchEvent(new MouseEvent('click'));
		await tick();
		expect((ctx.panel as unknown as { state: { whatIfWidth: number | null } }).state.whatIfWidth).toBe(768);
		expect(ctx.shadow.textContent || '').toContain('↓'); // under what-if 768 the @media wins → base overridden
	});
});

describe('Panel: focus the picked element', () => {
	it('shows only the clicked element’s rules, with a Show all toggle', async () => {
		const btn = document.createElement('button');
		btn.className = 'btn primary';
		document.body.appendChild(btn);
		const ctx = makePanel([
			{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] },
			{ id: 1, selector: '.btn.primary', decls: [{ prop: 'color', value: 'navy' }] },
			{ id: 2, selector: '.sidebar', decls: [{ prop: 'width', value: '200px' }] }
		]);
		await ctx.panel.pick('X.svelte', META, btn);
		await tick();
		expect(ctx.shadow.textContent || '').toContain('Show all'); // focus bar present (2 of 3)
		expect(ctx.shadow.textContent || '').not.toContain('.sidebar'); // non-matching rule hidden while focused
		// toggling reveals everything
		const allBtn = [...ctx.shadow.querySelectorAll('button')].find((b) => b.textContent?.includes('Show all'))!;
		allBtn.click();
		await tick();
		expect(ctx.shadow.textContent || '').toContain('.sidebar'); // now visible
	});

	it('climbs to the nearest styled ancestor when you click an UNSTYLED element', async () => {
		// rich-component shape: a class-less <span> deep inside styled boxes (the
		// golfability case — clicking bare text used to focus nothing).
		const card = document.createElement('div'); card.className = 'card';
		const label = document.createElement('div'); label.className = 'label';
		const bare = document.createElement('span'); bare.textContent = 'x'; // NO class — what you click
		label.appendChild(bare); card.appendChild(label); document.body.appendChild(card);
		const ctx = makePanel([
			{ id: 0, selector: '.card', decls: [{ prop: 'padding', value: '8px' }] },
			{ id: 1, selector: '.card .label', decls: [{ prop: 'color', value: 'red' }] },
			{ id: 2, selector: '.other', decls: [{ prop: 'width', value: '10px' }] }
		]);
		await ctx.panel.pick('X.svelte', META, bare);
		await tick();
		const text = ctx.shadow.textContent || '';
		expect(text).toContain('Focused on .label'); // climbed from bare <span> → .label
		expect(text).toContain('.card .label'); // its rule is shown
		expect(text).not.toContain('.other'); // unrelated rule stays hidden
	});

	it('includes descendant rules when you click a container', async () => {
		const card = document.createElement('div'); card.className = 'card';
		const label = document.createElement('div'); label.className = 'label';
		card.appendChild(label); document.body.appendChild(card);
		const ctx = makePanel([
			{ id: 0, selector: '.card', decls: [{ prop: 'padding', value: '8px' }] },
			{ id: 1, selector: '.card .label', decls: [{ prop: 'color', value: 'red' }] },
			{ id: 2, selector: '.other', decls: [{ prop: 'width', value: '10px' }] }
		]);
		await ctx.panel.pick('X.svelte', META, card);
		await tick();
		const text = ctx.shadow.textContent || '';
		expect(text).toContain('.card .label'); // descendant rule pulled in
		expect(text).not.toContain('.other');
	});
});

describe('Panel: DOM tree pane', () => {
	const pickableRow = (s: ShadowRoot, needle: string) =>
		[...s.querySelectorAll('div')].find((d) => d.style.cursor === 'pointer' && (d.textContent || '').includes(needle))!;
	// the header toggle's title flips Show/Hide — both end with "DOM tree"
	const toggleTree = (s: ShadowRoot) =>
		[...s.querySelectorAll('button')].find((b) => /DOM tree$/.test(b.title))!.dispatchEvent(new MouseEvent('click'));

	it('is hidden by default and the header toggle shows/hides it', async () => {
		document.body.appendChild(Object.assign(document.createElement('div'), { className: 'widget' }));
		const ctx = makePanel();
		await ctx.panel.pick('Button.svelte', META);
		await tick();
		expect(ctx.shadow.textContent || '').not.toContain('highlight'); // pane off by default
		toggleTree(ctx.shadow); await tick();
		expect(ctx.shadow.textContent || '').toContain('highlight'); // shown (pane header text)
		toggleTree(ctx.shadow); await tick();
		expect(ctx.shadow.textContent || '').not.toContain('highlight'); // hidden again
	});

	it('renders the page element tree; a row click picks that element', async () => {
		const card = document.createElement('div'); card.className = 'card';
		const cta = document.createElement('button'); cta.className = 'cta';
		(cta as unknown as { __svelte_meta?: unknown }).__svelte_meta = { loc: { file: 'src/lib/Cta.svelte' } };
		card.appendChild(cta); document.body.appendChild(card);
		const ctx = makePanel([{ id: 0, selector: '.btn', decls: [{ prop: 'color', value: 'white' }] }]);
		await ctx.panel.pick('Button.svelte', META); // open the panel (no element → tree default-expanded)
		await tick();
		toggleTree(ctx.shadow); await tick(); // DOM pane is off by default
		const text = ctx.shadow.textContent || '';
		expect(text).toContain('DOM');   // pane header
		expect(text).toContain('.card'); // tree row for the card
		expect(text).toContain('.cta');  // and its child button
		// clicking the .cta row picks it and loads its component
		pickableRow(ctx.shadow, '.cta').dispatchEvent(new MouseEvent('click'));
		await tick();
		const state = (ctx.panel as unknown as { state: { file: string | null; view: string } }).state;
		expect(state.file).toBe('src/lib/Cta.svelte');
		expect(state.view).toBe('editing');
	});

	it('reuses the built tree on hover but rebuilds it on expand/collapse', async () => {
		const outer = document.createElement('div'); outer.className = 'outer';
		const inner = document.createElement('div'); inner.className = 'inner';
		outer.appendChild(inner); document.body.appendChild(outer);
		const ctx = makePanel();
		await ctx.panel.pick('Button.svelte', META);
		await tick();
		toggleTree(ctx.shadow); await tick();
		const treeNode = () => ctx.shadow.querySelector('[data-sw-tree]')!.firstElementChild;
		const before = treeNode();
		// hover changes only the highlight → the tree node must be REUSED
		pickableRow(ctx.shadow, '.outer').dispatchEvent(new MouseEvent('mouseenter'));
		await tick();
		expect(treeNode()).toBe(before);
		// expand/collapse changes the tree → it must be REBUILT (new node)
		[...ctx.shadow.querySelectorAll('button')].find((b) => b.title === 'Collapse' || b.title === 'Expand')!
			.dispatchEvent(new MouseEvent('click'));
		await tick();
		expect(treeNode()).not.toBe(before);
	});

	it('hovering a tree row sets a page highlight', async () => {
		const hero = document.createElement('section'); hero.className = 'hero';
		document.body.appendChild(hero);
		const ctx = makePanel();
		await ctx.panel.pick('Button.svelte', META);
		await tick();
		toggleTree(ctx.shadow); await tick(); // DOM pane is off by default
		pickableRow(ctx.shadow, '.hero').dispatchEvent(new MouseEvent('mouseenter'));
		await tick();
		const hl = (ctx.panel as unknown as { state: { hl: { tag: string } | null } }).state.hl;
		expect(hl).toBeTruthy();
		expect(hl!.tag).toContain('section'); // tagLabel of the hovered element
	});
});

describe('Panel: undo survives structural ops via re-keying (COR-7)', () => {
	type Internals = {
		history: { canUndo(): boolean };
		removeRule(ri: number): Promise<void>;
		updateDecl(ri: number, di: number, field: 'p' | 'v', val: string): void;
		undo(): void;
	};
	it('a rule removal leaves earlier edits undoable, and an undo replays without throwing', async () => {
		const RULES_IDS: SwRule[] = [
			{ id: 0, selector: '.a', decls: [{ prop: 'color', value: 'red' }] },
			{ id: 1, selector: '.b', decls: [{ prop: 'color', value: 'blue' }] }
		];
		const ctx = makePanel(RULES_IDS);
		await ctx.panel.pick('Button.svelte', META);
		await tick();
		const p = ctx.panel as unknown as Internals;
		p.updateDecl(0, 0, 'v', 'green');
		await tick();
		expect(p.history.canUndo()).toBe(true);
		// COR-7: a structural op no longer wipes history (COR-2 did); the restore re-keys
		// onto the live source, so undo stays available and replays safely.
		await p.removeRule(0);
		await tick();
		expect(p.history.canUndo()).toBe(true);
		ctx.saved.rules = null; // ignore the removeRule save; watch for the undo's save
		p.undo();
		await tick();
		expect(ctx.saved.rules).not.toBeNull(); // the re-keyed undo issued a save, no throw
	});
});

describe('rekeyToCurrent — re-point a snapshot onto live source (COR-7)', () => {
	const sv = (id: number | undefined, sel: string, v: string, media?: { name: string; params: string }[]): SwRule => ({ id, selector: sel, decls: [{ prop: 'color', value: v }], media });
	it('recreates a snapshot rule the current source no longer has (undo of a remove)', () => {
		const snapshot: Rule[] = fromServerRules([sv(0, '.a', 'red'), sv(1, '.b', 'blue')]); // had both
		const current: Rule[] = fromServerRules([sv(0, '.b', 'blue')]);                        // .a was removed → reindexed
		const { rules, removeIds } = rekeyToCurrent(snapshot, current);
		expect(removeIds).toEqual([]);                                  // nothing to delete
		const a = rules.find((r) => r.sel === '.a')!, b = rules.find((r) => r.sel === '.b')!;
		expect(a.id).toBeUndefined();                                  // .a → create (recreate it)
		expect(b.id).toBe(0);                                          // .b → patch the CURRENT id (0, not stale 1)
	});
	it('removes a current rule the snapshot does not have (undo of an add)', () => {
		const snapshot: Rule[] = fromServerRules([sv(0, '.a', 'red')]);                  // before the add
		const current: Rule[] = fromServerRules([sv(0, '.a', 'red'), sv(1, '.x', 'p', [{ name: 'media', params: '(min-width: 768px)' }])]);
		const { rules, removeIds } = rekeyToCurrent(snapshot, current);
		expect(removeIds).toEqual([1]);                                // the added .x → remove
		expect(rules.find((r) => r.sel === '.a')!.id).toBe(0);        // .a → patch
	});
	it('distinguishes same-selector rules by their @media signature', () => {
		const base = sv(0, '.a', 'red');
		const resp = sv(1, '.a', 'navy', [{ name: 'media', params: '(min-width: 768px)' }]);
		const { rules, removeIds } = rekeyToCurrent(fromServerRules([base, resp]), fromServerRules([base, resp]));
		expect(removeIds).toEqual([]);
		expect(rules.map((r) => r.id)).toEqual([0, 1]); // each matched its same-selector+media twin
	});
});
