// The Stylewright overlay panel — a dark, dockable, IDE-style CSS editor.
// Vanilla-TS port of the design prototype: tokenized per-block editor with
// scroll-to-scrub numbers, an inline color picker, keyword + font menus,
// property type-ahead, add/remove declarations, per-file undo/redo, docking and
// resize. State changes re-render the overlay (focus + scroll are preserved).
//
// Pure logic (color math, tokenizer, rules model) lives in sibling modules; this
// file owns state + DOM. Wired to the dev server via the injected PanelHost.

import { el, clear, flushRefs, type ElProps } from './dom.js';
import { PROPS, COLORISH, KEYWORDS, SYSTEM_FONTS, SYS_FAMILIES } from './data.js';
import { tokenize, classify, rankList, type Tok } from './tokenize.js';
import {
	hsvToRgb, rgbToHex, parseColor, formatColor, isColorValue,
	normColor, sameColor, swatchStyle, alphaTrackStyle, type ColorFmt
} from './color.js';
import { fromServerRules, toServerRules, cloneRules, type Rule } from './rules.js';
import { History, type HistState } from './history.js';
import type { SwRule, SwAtRule, SwStyleSaveResponse, SwApplyResponse } from '../shared/protocol.js';
import { describe, resolveFile, shortPath, tagLabel, buildDomTree, pathPrefixes } from './inspect.js';
import type { PickMeta, DomNode } from './inspect.js';
export type { PickMeta } from './inspect.js';

/** Server glue the overlay needs — provided by the boot module. */
export interface PanelHost {
	loadRules(file: string): Promise<{ hasStyle: boolean; rules: SwRule[]; error?: string }>;
	/** Structure-preserving save (POST /apply): patches the exact source rules,
	 *  preserving @media/keyframes/comments. `opts` carries the Phase 4 structural ops
	 *  (id-less rules in `rules` are created; removeIds delete; mediaRenames move a
	 *  breakpoint). This is the save path the panel uses. */
	applyRules(file: string, rules: SwRule[], opts?: { removeIds?: number[]; mediaRenames?: { id: number; params: string }[] }): Promise<SwApplyResponse>;
	/** Legacy flat whole-block save (POST /style). Kept for back-compat; not used by
	 *  the panel anymore because it can't represent at-rules. */
	saveCss(file: string, css: string): Promise<SwStyleSaveResponse>;
}

type Dock = 'left' | 'right' | 'bottom' | 'float';
type View = 'closed' | 'pick' | 'editing' | 'no-meta' | 'no-style';
type StatusKind = 'idle' | 'saving' | 'ok' | 'err';
interface Status { kind: StatusKind; text: string; }
interface Focus { ri: number; di: number; field: 'p' | 'v'; tok?: number | string | null; }
interface ColorSel { ri: number; di: number; tok: number; h: number; s: number; v: number; a: number; fmt: ColorFmt; hexText?: string; }
interface Menu { ri: number; di: number; }
/** Plain viewport rect — stored instead of a DOMRect so setState's JSON-based
 *  change-detection can actually compare it (a DOMRect always stringifies to `{}`,
 *  so hovering between same-tag elements would otherwise leave the box stuck). */
interface Rect { top: number; left: number; width: number; height: number; }
interface Highlight { r: Rect | null; tag: string; file: string | null; }
interface Size { side: number; bottom: number; floatW: number; floatH: number; }
interface FloatPos { x: number | null; y: number | null; }
/** CSS/HTML split fractions: `col` = CSS top-pane height (left/right dock),
 *  `row` = HTML left-pane width (bottom dock). */
interface Split { col: number; row: number; }

interface State {
	dock: Dock;
	view: View;
	float: FloatPos;
	/** Launcher (FAB) position. {null,null} = default bottom-right anchor; once
	 *  dragged, absolute viewport left/top px (clamped on render). In-memory like
	 *  `float` — resets to the anchor on reload. */
	fab: FloatPos;
	size: Size;
	colorHistory: string[];
	focus: Focus | null;
	color: ColorSel | null;
	menu: Menu | null;
	acIndex: number;
	status: Status;
	file: string | null;
	meta: PickMeta | null;
	rules: Rule[];
	hl: Highlight | null;
	/** When true, the editor shows only the rules matching the picked element
	 *  (with a "show all" toggle). Set on each pick; flipped by the focus bar. */
	focusPick: boolean;
	/** CSS/HTML pane split fractions (docked layouts). */
	split: Split;
	/** Which pane the floating layout shows (it's tabbed, not split). */
	floatTab: 'css' | 'html';
	/** DOM-tree expand/collapse overrides, keyed by node path. Absent = default
	 *  (open to a shallow depth + the picked element's ancestors). A plain object,
	 *  NOT a Set — setState's change-detection JSON-stringifies and a Set is `{}`. */
	htmlToggled: Record<string, boolean>;
	/** Whether the DOM-tree pane is shown. Off by default: building the tree on
	 *  every render is the slow path, so it's opt-in via the header toggle. */
	showHtml: boolean;
	/** Bumped only when the tree's CONTENT could change (pick, expand/collapse, show,
	 *  manual refresh). buildTree caches its built node keyed by this, so a hover or a
	 *  CSS keystroke (which re-render the panel) reuse the tree instead of rewalking
	 *  the DOM. CSS edits never change DOM structure, so reuse is safe. */
	treeRev: number;
	/** What-if breakpoint preview: a width to evaluate @media against (editor-dimming
	 *  only — it can't resize the real viewport). null = follow the live width. */
	whatIfWidth: number | null;
	/** The live viewport width — tracked so a resize re-renders the breakpoint dimming
	 *  in Live mode, and shown on the "Live" switcher chip. */
	realW: number;
	/** Rule index whose @media breakpoint is being edited inline (null = none). */
	editBp: number | null;
}

type SvgEl = HTMLElement & SVGElement;
const ic = (size: number, vb: string, opts: ElProps, ...kids: SvgEl[]): SvgEl =>
	el('svg', { width: size, height: size, viewBox: vb, ...opts }, ...kids);
const pth = (d: string, opts?: ElProps): SvgEl => el('path', { d, ...(opts || {}) });
/** DOMRect → plain {top,left,width,height} so it survives setState change-detection. */
const toRect = (r: DOMRect): Rect => ({ top: r.top, left: r.left, width: r.width, height: r.height });
/** Collapse insignificant whitespace so two source selectors compare equal. */
const normSel = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Re-point a restored undo/redo snapshot onto the CURRENT source rules by stable
 *  identity (selector + @media signature) instead of fragile walk-order ids — so an
 *  undo across a structural change patches/creates/removes the right rules rather than
 *  corrupting an unrelated one (COR-7, superseding COR-2's history-reset). A snapshot
 *  rule that matches a current rule carries its id (→ patch); an unmatched snapshot rule
 *  gets no id (→ create); a current rule absent from the snapshot goes in removeIds.
 *  Duplicate (selector+@media) rules are matched positionally within their group. */
export function rekeyToCurrent(snapshot: Rule[], current: Rule[]): { rules: Rule[]; removeIds: number[] } {
	const sig = (r: Rule): string => normSel(r.sel) + '' + (r.media || []).map((m) => m.name + ' ' + String(m.params).trim()).join('');
	const pool = new Map<string, Rule[]>();
	for (const c of current) { const k = sig(c); const a = pool.get(k); if (a) a.push(c); else pool.set(k, [c]); }
	const matched = new Set<Rule>();
	const rules: Rule[] = snapshot.map((s) => {
		const c = pool.get(sig(s))?.shift();
		if (c) { matched.add(c); return { ...s, id: c.id }; }
		return { ...s, id: undefined };
	});
	const removeIds: number[] = [];
	for (const c of current) if (!matched.has(c) && typeof c.id === 'number') removeIds.push(c.id);
	return { rules, removeIds };
}
/** Pull min-width / max-width pixel bounds from a media query's params. Returns null
 *  for a non-width query (orientation, etc.) so the caller falls back to matchMedia. */
function parseWidthQuery(params: string): { min?: number; max?: number } | null {
	const min = params.match(/min-width:\s*([\d.]+)px/);
	const max = params.match(/max-width:\s*([\d.]+)px/);
	if (!min && !max) return null;
	const out: { min?: number; max?: number } = {};
	if (min) out.min = parseFloat(min[1]);
	if (max) out.max = parseFloat(max[1]);
	return out;
}

// syntax colors
const C_SEL = '#e8c98a', C_PROP = '#82aaff', C_PUNCT = '#5c5c66';
const C_NUM = '#f0b86c', C_KW = '#c792ea', C_COLOR = '#dcdce4', C_TEXT = '#c9c9d4', C_FONT = '#7fd1c4';
// DOM-tree row colors + default expand depth (root + its children open by default).
const C_TAG = '#5c8bd6', C_ID = '#e8c98a', C_CLS = '#c792ea';
const TREE_OPEN_DEPTH = 2;
// The FAB stays a plain click (pointer) cursor until you've hovered it this long —
// only then does it reveal the grab hand, so it doesn't read as "always draggable".
const FAB_GRAB_DELAY = 2000;
// The dragged launcher position persists across reloads (the rest of the panel's
// layout stays in-memory). Guarded so private-mode / disabled storage can't throw.
const FAB_POS_KEY = '__stylewright_fab';
function loadFabPos(): FloatPos {
	try {
		const raw = localStorage.getItem(FAB_POS_KEY);
		if (raw) { const p = JSON.parse(raw) as FloatPos; if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }; }
	} catch { /* storage unavailable — fall back to the default anchor */ }
	return { x: null, y: null };
}
function saveFabPos(p: FloatPos): void {
	try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Equality for setState change-detection: identity, then a JSON fallback for the
 *  small plain objects we keep in state (focus/color/status/size/…). */
function stateEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== 'object' || typeof b !== 'object') return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

export class Panel {
	private shadow: ShadowRoot;
	private host: PanelHost;
	private rootEl: HTMLElement;
	private state: State;
	/** The element last picked (page click or DOM-tree click) — selects its tree
	 *  row and auto-expands its ancestors. Not in state; set alongside a pick. */
	private pickedEl: Element | null = null;
	/** Memoized DOM-tree node, reused across renders while `state.treeRev` is
	 *  unchanged (a DOM node can be detached + re-appended, which `render()` does). */
	private treeCache: { rev: number; node: SvgEl } | null = null;
	// Render-hot-path memos. activeMemo/mediaMemo are viewport-dependent → cleared every
	// render; orderCache/selGroupCache are keyed by the selector signature so they
	// survive value-only re-renders (a CSS keystroke). Together these turn the
	// per-render document walk and the O(decls×rules) cascade rescan into ~O(1)
	// lookups on the typing hot path (PERF-1, PERF-3).
	private activeMemo = new Map<Rule, boolean>();
	private mediaMemo = new Map<string, boolean>();
	private orderCache: { key: string; order: number[] } | null = null;
	private selGroupCache: { key: string; map: Map<string, number[]> } | null = null;
	// The DOM-tree model (the buildDomTree walk) cached separately from row rendering so
	// expand/collapse re-renders rows WITHOUT rewalking the document (PERF-4). Bumped on
	// pick / show / manual refresh — not on toggle.
	private domModelRev = 0;
	private domModelCache: { rev: number; roots: DomNode[]; byEl: Map<Element, DomNode> } | null = null;

	// one global undo/redo timeline across every file edited this session
	private history = new History<PickMeta | null>();

	private wantFocus: string | null = null;
	private programmaticFocus = false; // true while WE focus an input — onFocus skips its side-effects
	private rebuilding = false; // true during render teardown — inputs' onBlur ignore the synthetic blur
	private colorWasSeeded = false; // picker opened on an empty value and not yet touched — revert on close
	private fabDragged = false; // a FAB mousedown crossed the drag threshold — suppresses the activate-on-release
	private fabHoverTimer: ReturnType<typeof setTimeout> | undefined; // reveals the grab cursor only after a hover dwell
	private renderQueued = false;
	// animate-once: popovers shown in the previous render (don't replay their entry
	// animation while they stay open — that's what made the color picker flicker).
	private shownPops = new Set<string>();
	private nextPops = new Set<string>();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private keyHandler: (e: KeyboardEvent) => void;
	private downHandler: (e: MouseEvent) => void;
	private reanchorHandler: () => void;
	private onResize: () => void;
	private resizeRaf = 0;

	constructor(shadow: ShadowRoot, host: PanelHost) {
		this.shadow = shadow;
		this.host = host;
		this.rootEl = document.createElement('div');
		this.shadow.appendChild(this.rootEl);
		this.state = {
			dock: 'right',
			view: 'closed',
			float: { x: null, y: null },
			fab: loadFabPos(),
			size: { side: 392, bottom: 300, floatW: 418, floatH: 540 },
			colorHistory: [],
			focus: null, color: null, menu: null, acIndex: 0,
			status: { kind: 'idle', text: 'Pick an element to edit its styles' },
			file: null, meta: null, rules: [], hl: null, focusPick: false,
			split: { col: 0.6, row: 0.4 }, floatTab: 'css', htmlToggled: {}, showHtml: false, treeRev: 0,
			whatIfWidth: null, realW: window.innerWidth, editBp: null
		};

		this.keyHandler = (e) => {
			if (e.key === 'Escape') {
				if (this.state.color) { this.closeColorPicker(); return; }
				this.setState({ view: this.state.view === 'pick' ? 'closed' : this.state.view, menu: null, focus: null });
			}
			const mod = e.metaKey || e.ctrlKey;
			if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
			if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
			if (mod && e.key.toLowerCase() === 's' && this.state.view === 'editing') { e.preventDefault(); this.save(); }
		};
		this.downHandler = (e) => {
			if (!(this.state.color || this.state.menu)) return;
			const path = (e.composedPath ? e.composedPath() : []) as Element[];
			const inPop = path.some((n) => n && n.classList && (n.classList.contains('sw-pop') || n.classList.contains('sw-pop-trigger')));
			if (!inPop) { if (this.state.color) this.closeColorPicker(); if (this.state.menu) this.setState({ menu: null }); }
		};
		// Keep an open popover glued to its trigger when the editor body scrolls or
		// the window resizes — neither of which triggers a re-render on its own.
		this.reanchorHandler = () => this.reanchorPopovers();
		// In "Live" mode the breakpoint dimming follows the real viewport, so a resize
		// needs a re-render. rAF-throttle it; a no-op while previewing a what-if width.
		this.onResize = () => {
			if (this.resizeRaf) return;
			this.resizeRaf = requestAnimationFrame(() => {
				this.resizeRaf = 0;
				if (this.state.realW !== window.innerWidth) this.setState({ realW: window.innerWidth });
			});
		};
		window.addEventListener('keydown', this.keyHandler);
		document.addEventListener('mousedown', this.downHandler);
		window.addEventListener('resize', this.reanchorHandler);
		window.addEventListener('resize', this.onResize);
		this.rootEl.addEventListener('scroll', this.reanchorHandler, true); // capture: scroll doesn't bubble
		this.render();
	}

	destroy(): void {
		window.removeEventListener('keydown', this.keyHandler);
		document.removeEventListener('mousedown', this.downHandler);
		window.removeEventListener('resize', this.reanchorHandler);
		window.removeEventListener('resize', this.onResize);
		if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
		this.rootEl.removeEventListener('scroll', this.reanchorHandler, true);
		clear(this.rootEl);
	}

	/** Re-run the anchoring math on every currently-open popover against its trigger. */
	private reanchorPopovers(): void {
		const anchor = this.popoverRef();
		this.rootEl.querySelectorAll<HTMLElement>('.sw-pop').forEach((node) => anchor(node));
	}

	// ---------- state + render ----------
	private setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
		const p = typeof patch === 'function' ? patch(this.state) : patch;
		// Only re-render when something ACTUALLY changed. Critical: a re-render
		// recreates the focused input and restoreFocus() re-focuses it, firing its
		// onFocus, which setState({focus: same}). Without this guard that loops
		// render → focus → onFocus → render forever and freezes the editor.
		let changed = false;
		const cur = this.state as unknown as Record<string, unknown>;
		const next = p as Record<string, unknown>;
		for (const k in next) {
			if (k === 'rules') { changed = true; break; } // rules patches are always intentional
			if (!stateEq(cur[k], next[k])) { changed = true; break; }
		}
		Object.assign(this.state, p);
		if (!changed) return;
		if (!this.renderQueued) {
			this.renderQueued = true;
			queueMicrotask(() => { this.renderQueued = false; this.render(); });
		}
	}

	private render(): void {
		const prevBody = this.rootEl.querySelector('[data-sw-editor]') as HTMLElement | null;
		const scrollTop = prevBody ? prevBody.scrollTop : 0;
		const prevTree = this.rootEl.querySelector('[data-sw-tree]') as HTMLElement | null;
		const treeScroll = prevTree ? prevTree.scrollTop : 0; // the DOM-tree pane scrolls independently
		const caret = this.captureCaret(); // the rebuild destroys the focused input — keep its caret
		this.activeMemo.clear(); this.mediaMemo.clear(); // viewport-dependent memos: one render's worth
		this.nextPops = new Set(); // fresh set each render (don't clear the committed one — it's aliased)
		// Tearing down the focused input fires a synthetic blur; flag the rebuild so the
		// inputs' onBlur handlers ignore it (a real user blur happens outside a render).
		this.rebuilding = true;
		clear(this.rootEl);
		this.rootEl.appendChild(this.buildOverlay());
		// Restore editor scroll + focus FIRST, so popovers anchor against the final
		// layout; then flush refs (popover positioning) before the browser paints.
		const body = this.rootEl.querySelector('[data-sw-editor]') as HTMLElement | null;
		if (body) body.scrollTop = scrollTop;
		const tree = this.rootEl.querySelector('[data-sw-tree]') as HTMLElement | null;
		if (tree) tree.scrollTop = treeScroll; // don't snap the DOM tree back to the top on re-render
		this.restoreFocus(caret);
		this.rebuilding = false;
		flushRefs();
		this.shownPops = this.nextPops; // commit — these popovers are "already shown" next render
		this.history.record({ file: this.state.file, meta: this.state.meta, rules: this.state.rules }, Date.now());
	}

	/** Emit the entry animation only the first render a popover appears — not on the
	 *  re-renders while it stays open, else a drag re-pops it ~60×/sec (flicker). */
	private popAnim(key: string): string {
		this.nextPops.add(key);
		return this.shownPops.has(key) ? '' : 'sw-pop .13s ease';
	}

	private fk(ri: number, di: number, field: string, tok?: number | string | null): string {
		return ri + '-' + di + '-' + field + '-' + (tok == null ? '_' : tok);
	}
	private focusField(key: string): void {
		// A deliberate cursor move (new declaration, prop→value, etc.). Plain focus +
		// scrollIntoView so a freshly-added off-screen declaration becomes visible.
		this.wantFocus = key;
		setTimeout(() => {
			const node = this.rootEl.querySelector('input[data-fkey="' + key + '"]') as HTMLInputElement | null;
			this.wantFocus = null; // clear even if the target is gone, so focus can never get stuck
			if (node) { this.focusSilently(node); node.scrollIntoView({ block: 'nearest' }); const L = node.value.length; try { node.setSelectionRange(L, L); } catch { /* */ } }
		}, 0);
	}
	/** Read the caret of the currently-focused input (inside the shadow root) so we
	 *  can put it back after the rebuild instead of slamming it to the end. */
	private captureCaret(): { start: number; end: number } | null {
		const a = this.shadow.activeElement as HTMLInputElement | null;
		if (a && a.tagName === 'INPUT') {
			try { return { start: a.selectionStart ?? 0, end: a.selectionEnd ?? 0 }; } catch { return null; }
		}
		return null;
	}
	private restoreFocus(caret: { start: number; end: number } | null): void {
		// Re-focus the tracked input after a re-render. preventScroll keeps the editor
		// scroll stable (we just restored it) so popovers anchor against final layout.
		const deliberate = !!this.wantFocus; // a focusField() move puts the caret at the end
		let key = this.wantFocus;
		if (!key && this.state.focus) { const f = this.state.focus; key = this.fk(f.ri, f.di, f.field, f.tok); }
		if (!key) return;
		const node = this.rootEl.querySelector('input[data-fkey="' + key + '"]') as HTMLInputElement | null;
		this.wantFocus = null; // clear FIRST — a key that fails to resolve must never pin focus forever
		if (!node) return;
		this.focusSilently(node, { preventScroll: true });
		const L = node.value.length;
		let s = L, e = L; // deliberate move → caret at end
		if (!deliberate && caret) { s = Math.min(caret.start, L); e = Math.min(caret.end, L); } // typing → keep the caret
		try { node.setSelectionRange(s, e); } catch { /* */ }
	}
	/** Focus an input WE chose (re-render restore, deliberate move). The flag makes
	 *  the input's onFocus skip its setState — otherwise a programmatic focus would
	 *  loop render→focus→onFocus→render and would also reset acIndex (breaking the
	 *  type-ahead arrow keys). User-initiated focus runs onFocus normally. */
	private focusSilently(node: HTMLInputElement, opts?: FocusOptions): void {
		this.programmaticFocus = true;
		try { node.focus(opts); } finally { this.programmaticFocus = false; }
	}

	// ---------- public picking API (driven by the boot module) ----------
	isPicking(): boolean { return this.state.view === 'pick'; }
	open(): void { this.setState({ view: this.state.file ? 'editing' : 'pick', hl: null }); }
	hover(r: DOMRect, tag: string, file: string | null): void {
		if (this.state.view !== 'pick') return;
		this.setState({ hl: { r: toRect(r), tag, file } });
	}
	/** Highlight a page element from a DOM-tree row hover. Unlike `hover` (the pick
	 *  cursor), this works while the panel is open. */
	private previewEl(elx: Element): void {
		let r: Rect | null = null;
		try { r = toRect(elx.getBoundingClientRect()); } catch { r = null; }
		const file = resolveFile(elx);
		this.setState({ hl: { r, tag: tagLabel(elx), file: file ? shortPath(file) : null } });
	}
	private clearPreview(): void { if (this.state.hl) this.setState({ hl: null }); }
	private onFab(): void {
		const v = this.state.view;
		if (v === 'pick') this.setState({ view: this.state.file ? 'editing' : 'closed', hl: null });
		else this.setState({ view: 'pick', hl: null });
	}
	/** Drag the launcher anywhere. A press that stays put (< the threshold) is a
	 *  click → `onFab()`; once it crosses the threshold it's a drag → reposition.
	 *  Activation fires on release (not via onClick) so a drag that ends off the
	 *  button can't leave a stale flag that swallows the next real click. Mirrors
	 *  `onHeaderDown`: getBoundingClientRect seeds the offset, so the first drag
	 *  continues smoothly from wherever it's currently anchored. */
	private onFabDown(e: MouseEvent): void {
		if (e.button !== 0) return; // left button only
		e.preventDefault(); // don't select page text mid-drag
		clearTimeout(this.fabHoverTimer); // a press cancels the pending grab-cursor reveal
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top, w = r.width, h = r.height;
		this.fabDragged = false;
		const mv = (ev: MouseEvent): void => {
			const dx = ev.clientX - sx, dy = ev.clientY - sy;
			if (!this.fabDragged && Math.abs(dx) + Math.abs(dy) < 4) return; // tolerate click jitter
			if (!this.fabDragged) document.documentElement.style.cursor = 'grabbing';
			this.fabDragged = true;
			const x = Math.max(6, Math.min(window.innerWidth - w - 6, ox + dx));
			const y = Math.max(6, Math.min(window.innerHeight - h - 6, oy + dy));
			this.setState({ fab: { x, y } });
		};
		const up = (): void => {
			document.documentElement.style.cursor = '';
			document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
			if (!this.fabDragged) { this.onFab(); return; } // a press that never moved = a click
			saveFabPos(this.state.fab); // remember where it was dropped, across reloads
			// Drag ended: no re-render follows, so clear the grabbing cursor on the live
			// button and the flag (else the next render would paint it grabbing again).
			this.fabDragged = false;
			const fab = this.rootEl.querySelector<HTMLElement>('.sw-fab');
			if (fab) fab.style.cursor = '';
		};
		document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
	}
	/** Source-index set of rules to focus on (the picked element's rules); drives
	 *  the "focus this element" filter. Null when nothing useful was picked. */
	private pickedRis: Set<number> | null = null;
	/** Display label for the focus bar — the element we actually focused on (which
	 *  may be a styled ancestor of an unstyled thing you clicked). */
	private pickedLabel: string | null = null;
	/** Rules whose selector (with `:global()`/pseudos stripped) matches `target` OR
	 *  any element inside it — i.e. the rules that style what you clicked and its
	 *  contents. Invalid selectors are skipped. */
	private rulesForElement(target: Element, rules: Rule[]): Set<number> {
		const set = new Set<number>();
		rules.forEach((r, i) => {
			const sel = this.matchableSelector(r.sel);
			if (!sel) return;
			try { if (target.matches(sel) || target.querySelector(sel)) set.add(i); } catch { /* invalid selector */ }
		});
		return set;
	}
	private elLabel(elx: Element): string {
		const c = (elx.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
		return c ? '.' + c : elx.tagName.toLowerCase();
	}
	async pick(file: string | null, meta: PickMeta | null, el?: Element | null): Promise<void> {
		this.pickedEl = el || null; // selects this node's tree row + auto-expands its ancestors
		this.domModelRev++; // a pick navigates/selects → the DOM model may have changed (PERF-4)
		const treeRev = this.state.treeRev + 1; // the selection moved → rebuild the tree
		if (!file) { this.setState({ view: 'no-meta', hl: null, file: null, meta, rules: [], treeRev }); return; }
		// Don't touch file/rules until the load resolves — set them atomically so
		// the history records one clean baseline (not an old-rules/new-file blip).
		this.setState({ view: 'editing', hl: null, treeRev, status: { kind: 'saving', text: 'Loading ' + (meta ? meta.fileLabel : file) + ' …' } });
		try {
			const resp = await this.host.loadRules(file);
			if (resp.error) { this.setState({ status: { kind: 'err', text: resp.error } }); return; }
			if (!resp.hasStyle) { this.setState({ view: 'no-style', file, meta, rules: [] }); return; }
			const rules = fromServerRules(resp.rules);
			this.computeFocus(rules);
			this.setState({ file, meta, rules, focusPick: true, status: { kind: 'idle', text: 'Ready · edits write to source on commit' } });
		} catch (err) {
			this.setState({ status: { kind: 'err', text: 'Failed to load: ' + String(err) } });
		}
	}
	/** Compute the focus set (rules styling the picked element or its contents) for a
	 *  freshly-loaded rule list. If the exact element matches no rule (a bare
	 *  <span>/<div> — common in rich components), climb to the nearest styled ancestor
	 *  so a pick always lands somewhere useful. */
	private computeFocus(rules: Rule[]): void {
		let target: Element | null = this.pickedEl;
		let ris = target ? this.rulesForElement(target, rules) : new Set<number>();
		for (let hops = 0; target && ris.size === 0 && hops < 8; hops++) {
			target = target.parentElement;
			if (target) ris = this.rulesForElement(target, rules);
		}
		this.pickedRis = ris.size ? ris : null;
		this.pickedLabel = this.pickedRis && target ? this.elLabel(target) : null;
	}
	/** Re-fetch the current file's rules after a STRUCTURAL change (create/remove/
	 *  rename shifts the walk-order ids), and recompute the focus set. */
	private async reloadRules(okText: string): Promise<void> {
		const file = this.state.file;
		if (!file) return;
		try {
			const resp = await this.host.loadRules(file);
			if (resp.error || !resp.hasStyle) { this.setState({ status: { kind: 'err', text: resp.error || 'No styles after change' } }); return; }
			const rules = fromServerRules(resp.rules);
			this.computeFocus(rules);
			this.setState({ rules, focus: null, color: null, menu: null, editBp: null, status: { kind: 'ok', text: okText } });
		} catch (err) {
			this.setState({ status: { kind: 'err', text: 'Reload failed: ' + String(err) } });
		}
	}
	/** Create a responsive @media override for rule `ri`'s selector (a new rule under a
	 *  min-width breakpoint), then re-fetch. Width defaults to the largest existing
	 *  breakpoint (else 768) — the user adjusts it via the editable @media chip. */
	private async addOverride(ri: number): Promise<void> {
		const file = this.state.file; const base = this.state.rules[ri];
		if (!file || !base) return;
		const { minW } = this.breakpoints();
		const w = minW.length ? minW[minW.length - 1] : 768;
		const newRule: SwRule = { selector: base.sel, media: [{ name: 'media', params: `(min-width: ${w}px)` }], decls: [] };
		this.setState({ status: { kind: 'saving', text: 'Adding @media override …' } });
		try {
			const d = await this.host.applyRules(file, toServerRules(this.state.rules).concat([newRule]));
			if (!d.ok) { this.setState({ status: { kind: 'err', text: d.error || 'Failed to add override' } }); return; }
			await this.reloadRules(`Added override · edit the ≥${w} chip to set its width`);
		} catch (err) { this.setState({ status: { kind: 'err', text: 'Failed: ' + String(err) } }); }
	}
	/** Delete rule `ri` from the source (and prune an emptied @media), then re-fetch. */
	private async removeRule(ri: number): Promise<void> {
		const file = this.state.file; const r = this.state.rules[ri];
		if (!file || !r || typeof r.id !== 'number') return;
		this.setState({ status: { kind: 'saving', text: 'Removing rule …' } });
		try {
			const d = await this.host.applyRules(file, toServerRules(this.state.rules), { removeIds: [r.id] });
			if (!d.ok) { this.setState({ status: { kind: 'err', text: d.error || 'Failed to remove' } }); return; }
			await this.reloadRules('Removed rule');
		} catch (err) { this.setState({ status: { kind: 'err', text: 'Failed: ' + String(err) } }); }
	}
	/** Change rule `ri`'s @media breakpoint width — renames the whole block (every rule
	 *  under it moves), then re-fetch. */
	private async commitBreakpoint(ri: number, width: number): Promise<void> {
		const file = this.state.file; const r = this.state.rules[ri];
		if (!file || !r || typeof r.id !== 'number' || !r.media || !r.media.length) { this.setState({ editBp: null }); return; }
		const params = r.media[0].params.replace(/([\d.]+)px/, width + 'px');
		this.setState({ editBp: null, status: { kind: 'saving', text: 'Updating breakpoint …' } });
		try {
			const d = await this.host.applyRules(file, toServerRules(this.state.rules), { mediaRenames: [{ id: r.id, params }] });
			if (!d.ok) { this.setState({ status: { kind: 'err', text: d.error || 'Failed to update breakpoint' } }); return; }
			await this.reloadRules(`Breakpoint → ${params}`);
		} catch (err) { this.setState({ status: { kind: 'err', text: 'Failed: ' + String(err) } }); }
	}

	// ---------- global undo / redo (one timeline across every file) ----------
	private applyHistState(s: HistState<PickMeta | null>, label: string): void {
		// The restored state may belong to a different file — switch the view to it.
		// The snapshot's source ids may be stale (a structural op since then renumbered
		// them), so DON'T write it back by id; re-key against the live source first.
		this.setState({ file: s.file, meta: s.meta, rules: s.rules, view: s.file ? 'editing' : this.state.view, color: null, menu: null, focus: null, status: { kind: 'saving', text: label } });
		if (s.file) void this.saveRestored(s.file, s.rules, label);
	}
	/** Persist a restored undo/redo snapshot by re-keying it onto the file's CURRENT
	 *  source (selector + @media identity), so an undo across a structural change
	 *  recreates/removes/patches the right rules instead of corrupting one by stale id
	 *  (COR-7). Replaces the old blind, id-keyed save() on the restore path. */
	private async saveRestored(file: string, snapshot: Rule[], label: string): Promise<void> {
		try {
			const resp = await this.host.loadRules(file);
			const current = resp.hasStyle && !resp.error ? fromServerRules(resp.rules) : [];
			const { rules, removeIds } = rekeyToCurrent(snapshot, current);
			const d = await this.host.applyRules(file, toServerRules(rules), removeIds.length ? { removeIds } : undefined);
			if (!d.ok) { this.setState({ status: { kind: 'err', text: d.error || 'Undo save failed' } }); return; }
			// creates/removes shift ids → re-fetch so the editor model + future saves align.
			await this.reloadRules(label);
		} catch (err) {
			this.setState({ status: { kind: 'err', text: 'Undo failed: ' + String(err) } });
		}
	}
	private undo(): void {
		const s = this.history.undo();
		if (!s) { this.setState({ status: { kind: 'idle', text: 'Nothing to undo' } }); return; }
		const n = this.history.remaining();
		this.applyHistState(s, 'Undo · ' + n + ' more step' + (n === 1 ? '' : 's'));
	}
	private redo(): void {
		const s = this.history.redo();
		if (!s) { this.setState({ status: { kind: 'idle', text: 'Nothing to redo' } }); return; }
		this.applyHistState(s, 'Redo');
	}

	// ---------- editing ops ----------
	private curRules(): Rule[] { return this.state.rules; }
	private setRules(updater: (rs: Rule[]) => Rule[]): void {
		const next = updater(cloneRules(this.state.rules));
		this.setState({ rules: next, status: { kind: 'idle', text: 'Edited · ⌘S or blur to write' } });
	}
	private updateDecl(ri: number, di: number, field: 'p' | 'v', val: string): void {
		this.setRules((rs) => { if (field === 'p') rs[ri].decls[di].p = val; else rs[ri].decls[di].v = val; return rs; });
	}
	private removeDecl(ri: number, di: number): void {
		this.setRules((rs) => { rs[ri].decls.splice(di, 1); return rs; });
		this.setState({ focus: null, menu: null, color: null });
		this.save();
	}
	private addDecl(ri: number): void {
		const rs = cloneRules(this.state.rules);
		rs[ri].decls = rs[ri].decls.filter((d) => d.p.trim() || d.v.trim()); // drop any abandoned-empty line first
		rs[ri].decls.push({ p: '', v: '' });
		const di = rs[ri].decls.length - 1;
		this.setState({ rules: rs, focus: { ri, di, field: 'p' }, menu: null, color: null, acIndex: 0 });
		this.focusField(this.fk(ri, di, 'p'));
	}
	private addDeclAfter(ri: number, di: number, seed?: string): void {
		const rs = cloneRules(this.state.rules);
		rs[ri].decls.splice(di + 1, 0, { p: seed || '', v: '' });
		this.setState({ rules: rs, focus: { ri, di: di + 1, field: 'p' }, menu: null, color: null, acIndex: 0, status: { kind: 'idle', text: 'New declaration · type a property' } });
		this.focusField(this.fk(ri, di + 1, 'p'));
	}
	private updateToken(ri: number, di: number, k: number, text: string): void {
		const toks = tokenize(this.curRules()[ri].decls[di].v);
		if (toks[k]) toks[k].x = text; else toks.push({ t: 'word', x: text });
		this.updateDecl(ri, di, 'v', toks.map((t) => t.x).join(''));
	}

	// ---------- save (real: serialize → POST /style) ----------
	private fileLabelText(): string { return this.state.meta ? this.state.meta.fileLabel : (this.state.file || ''); }
	private save(): void {
		const file = this.state.file;
		if (!file) return;
		// Bind the target NOW. If the user repicks another element before the debounce
		// fires, doSave must still write THIS file's rules, not the newly-loaded ones.
		const rules = this.state.rules;
		this.setState({ status: { kind: 'saving', text: 'Writing to ' + this.fileLabelText() + ' …' } });
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.doSave(file, rules), 200);
	}
	private async doSave(file: string, rules: Rule[]): Promise<void> {
		try {
			// Structure-preserving save: send the rule model (each rule keyed by its
			// source id) and let the server patch only those rules in the parsed tree,
			// leaving @media / keyframes / comments intact.
			const d = await this.host.applyRules(file, toServerRules(rules));
			if (!d.ok) this.setState({ status: { kind: 'err', text: d.error || 'Save failed' } });
			else if (d.changed) this.setState({ status: { kind: 'ok', text: 'Saved · HMR repainted from source' } });
			else this.setState({ status: { kind: 'idle', text: 'No change' } });
		} catch (err) {
			this.setState({ status: { kind: 'err', text: 'Save failed: ' + String(err) } });
		}
	}

	// ---------- color picker ----------
	private openColor(ri: number, di: number, k: number): void {
		const toks = tokenize(this.curRules()[ri].decls[di].v);
		const x = toks[k] ? toks[k].x : '#888888';
		const c = parseColor(x);
		this.setState({ color: { ri, di, tok: k, ...c }, menu: null, focus: null });
	}
	private openColorForFirst(ri: number, di: number): void {
		const v = this.curRules()[ri].decls[di].v;
		const toks = tokenize(v);
		let k = toks.findIndex((t) => t.t === 'color');
		if (k < 0) {
			if (v.trim() === '') {
				const seed = '#6d5efc';
				this.updateDecl(ri, di, 'v', seed);
				this.colorWasSeeded = true; // not a real choice yet — revert if closed untouched
				const c = parseColor(seed);
				this.setState({ color: { ri, di, tok: 0, ...c }, menu: null, focus: null });
				return;
			}
			k = Math.max(0, toks.findIndex((t) => t.t !== 'sep'));
		}
		this.openColor(ri, di, k);
	}
	private setColorHSV(part: Partial<ColorSel>): void {
		const c = { ...this.state.color, ...part, hexText: undefined } as ColorSel;
		this.colorWasSeeded = false; // the user is actively choosing a color now
		this.updateToken(c.ri, c.di, c.tok, formatColor(c.h, c.s, c.v, c.a, c.fmt));
		this.setState({ color: c });
		this.save(); // SV/hue/alpha have no input to blur — persist the edit (debounced)
	}
	private pageColors(): string[] {
		const out: string[] = []; const seen: Record<string, number> = {};
		this.state.rules.forEach((rule) => rule.decls.forEach((d) => tokenize(d.v).forEach((t) => {
			if (t.t === 'color') { const n = normColor(t.x); if (!seen[n]) { seen[n] = 1; out.push(t.x); } }
		})));
		return out.slice(0, 18);
	}
	private recordPicked(): void {
		const c = this.state.color; if (!c) return;
		const val = formatColor(c.h, c.s, c.v, c.a == null ? 1 : c.a, c.fmt);
		if (!isColorValue(val)) return;
		this.setState((s) => ({ colorHistory: [val, ...(s.colorHistory || []).filter((x) => !sameColor(x, val))].slice(0, 18) }));
	}
	private closeColorPicker(): void {
		const c = this.state.color;
		if (c) {
			if (this.colorWasSeeded) {
				// opened on an empty value, never touched → don't leave the default seed behind
				this.updateDecl(c.ri, c.di, 'v', '');
				this.save();
			} else {
				this.recordPicked();
			}
		}
		this.colorWasSeeded = false;
		this.setState({ color: null });
	}
	private applySwatch(p: string): void {
		const c = this.state.color; if (!c) return;
		const pc = parseColor(p);
		this.setColorHSV({ h: pc.h, s: pc.s, v: pc.v, a: pc.a == null ? 1 : pc.a });
		this.save();
	}
	// ---- color notation (hex → rgb → hsl), like DevTools ----
	private nextFmt(fmt: ColorFmt): ColorFmt {
		const order: ColorFmt[] = ['hex', 'rgb', 'hsl'];
		return order[(order.indexOf(fmt) + 1) % order.length];
	}
	private cycleFormat(): void { // from the open picker
		const c = this.state.color; if (!c) return;
		const fmt = this.nextFmt(c.fmt);
		this.colorWasSeeded = false;
		this.updateToken(c.ri, c.di, c.tok, formatColor(c.h, c.s, c.v, c.a, fmt));
		this.setState({ color: { ...c, fmt, hexText: undefined } });
		this.save();
	}
	private cycleTokenFormat(ri: number, di: number, k: number): void { // shift-click a swatch
		const toks = tokenize(this.curRules()[ri].decls[di].v);
		const t = toks[k]; if (!t) return;
		const c = parseColor(t.x);
		this.updateToken(ri, di, k, formatColor(c.h, c.s, c.v, c.a == null ? 1 : c.a, this.nextFmt(c.fmt)));
		this.save();
	}

	private loadedFonts(): string[] {
		const set = new Set<string>();
		try { document.fonts.forEach((f) => set.add(f.family.replace(/['"]/g, ''))); } catch { /* */ }
		return [...set].filter((f) => SYS_FAMILIES.indexOf(f.toLowerCase()) < 0).sort();
	}

	// ---------- scrub ----------
	private wheelRefTok(ri: number, di: number, k: number) {
		return (node: HTMLElement): void => {
			const n = node as HTMLElement & { __sw?: boolean };
			if (!node || n.__sw) return;
			n.__sw = true;
			node.addEventListener('wheel', (e: WheelEvent) => {
				const decls = this.curRules()[ri] && this.curRules()[ri].decls[di];
				const toks = tokenize(decls ? decls.v : '');
				const t = toks[k]; if (!t) return;
				const m = t.x.match(/^(-?\d*\.?\d+)(.*)$/); if (!m) return;
				e.preventDefault();
				let num = parseFloat(m[1]); const unit = m[2];
				const step = e.shiftKey ? 10 : (m[1].indexOf('.') >= 0 ? 0.1 : 1);
				num += e.deltaY < 0 ? step : -step;
				num = Math.round(num * 1000) / 1000;
				toks[k] = { t: 'num', x: num + unit };
				this.updateDecl(ri, di, 'v', toks.map((z) => z.x).join(''));
				this.save(); // a hover-scrub has no input to blur — persist it (debounced), like the color sliders
			}, { passive: false });
		};
	}

	// ---------- resize ----------
	private clampN(n: number, a: number, b: number): number { return Math.max(a, Math.min(b, n)); }
	private startResize(dir: string) {
		return (e: MouseEvent): void => {
			e.preventDefault(); e.stopPropagation();
			const sx = e.clientX, sy = e.clientY;
			const st = { ...this.state.size };
			const dock = this.state.dock;
			const fx = this.state.float.x == null ? (window.innerWidth - st.floatW - 16) : this.state.float.x;
			const fy = this.state.float.y == null ? 80 : this.state.float.y;
			const MINW = 300, MINH = 240;
			const mv = (ev: MouseEvent): void => {
				const dx = ev.clientX - sx, dy = ev.clientY - sy;
				if (dock === 'right') { this.setState({ size: { ...st, side: this.clampN(st.side - dx, MINW, window.innerWidth - 60) } }); }
				else if (dock === 'left') { this.setState({ size: { ...st, side: this.clampN(st.side + dx, MINW, window.innerWidth - 60) } }); }
				else if (dock === 'bottom') { this.setState({ size: { ...st, bottom: this.clampN(st.bottom - dy, MINH, window.innerHeight - 90) } }); }
				else {
					let w = st.floatW, h = st.floatH, x = fx, y = fy;
					if (dir.indexOf('r') >= 0) w = this.clampN(st.floatW + dx, MINW, window.innerWidth - fx - 8);
					if (dir.indexOf('l') >= 0) { w = this.clampN(st.floatW - dx, MINW, fx + st.floatW - 8); x = fx + (st.floatW - w); }
					if (dir.indexOf('b') >= 0) h = this.clampN(st.floatH + dy, MINH, window.innerHeight - fy - 8);
					if (dir.indexOf('t') >= 0) { h = this.clampN(st.floatH - dy, MINH, fy + st.floatH - 8); y = fy + (st.floatH - h); }
					this.setState({ size: { ...st, floatW: w, floatH: h }, float: { x, y } });
				}
			};
			const up = (): void => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
			document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
		};
	}
	private buildResizeHandles(): SvgEl[] {
		const dock = this.state.dock;
		const mk = (dir: string, box: Record<string, number | string>, grip: Record<string, number | string> | null, cursor: string): SvgEl =>
			el('div', {
				onMouseDown: this.startResize(dir), style: { position: 'absolute', zIndex: 20, ...box, cursor },
				onMouseEnter: (e: MouseEvent) => { const g = (e.currentTarget as HTMLElement).firstChild as HTMLElement | null; if (g) g.style.opacity = '1'; },
				onMouseLeave: (e: MouseEvent) => { const g = (e.currentTarget as HTMLElement).firstChild as HTMLElement | null; if (g) g.style.opacity = '0'; }
			}, grip ? el('span', { style: { position: 'absolute', background: '#8b7cf6', borderRadius: 3, opacity: 0, transition: 'opacity .12s', ...grip } }) : null);
		if (dock === 'right') return [mk('l', { left: -4, top: 0, bottom: 0, width: 9 }, { left: 3, top: '50%', marginTop: -15, width: 3, height: 30 }, 'ew-resize')];
		if (dock === 'left') return [mk('r', { right: -4, top: 0, bottom: 0, width: 9 }, { right: 3, top: '50%', marginTop: -15, width: 3, height: 30 }, 'ew-resize')];
		if (dock === 'bottom') return [mk('t', { top: -4, left: 0, right: 0, height: 9 }, { top: 3, left: '50%', marginLeft: -15, height: 3, width: 30 }, 'ns-resize')];
		const C = 14;
		return [
			mk('t', { top: -4, left: C, right: C, height: 9 }, { top: 3, left: '50%', marginLeft: -15, height: 3, width: 30 }, 'ns-resize'),
			mk('b', { bottom: -4, left: C, right: C, height: 9 }, { bottom: 3, left: '50%', marginLeft: -15, height: 3, width: 30 }, 'ns-resize'),
			mk('l', { left: -4, top: C, bottom: C, width: 9 }, { left: 3, top: '50%', marginTop: -15, width: 3, height: 30 }, 'ew-resize'),
			mk('r', { right: -4, top: C, bottom: C, width: 9 }, { right: 3, top: '50%', marginTop: -15, width: 3, height: 30 }, 'ew-resize'),
			mk('tl', { top: -4, left: -4, width: C, height: C }, null, 'nwse-resize'),
			mk('tr', { top: -4, right: -4, width: C, height: C }, null, 'nesw-resize'),
			mk('bl', { bottom: -4, left: -4, width: C, height: C }, null, 'nesw-resize'),
			mk('br', { bottom: -4, right: -4, width: C, height: C }, null, 'nwse-resize')
		];
	}

	// ---------- popovers ----------
	private popoverRef() {
		return (node: HTMLElement): void => {
			if (!node) return;
			const wrap = node.parentElement; if (!wrap) return;
			const wr = wrap.getBoundingClientRect();
			const W = node.offsetWidth, H = node.offsetHeight, M = 8, vw = window.innerWidth, vh = window.innerHeight;
			let x = wr.left; if (x + W > vw - M) x = vw - M - W; if (x < M) x = M;
			let y = wr.bottom + 4; if (y + H > vh - M) y = wr.top - H - 4; if (y < M) y = M;
			node.style.left = x + 'px'; node.style.top = y + 'px';
		};
	}
	private suggMenu(items: string[], ac: number, onPick: (s: string) => void, key: string): SvgEl {
		return el('div', { className: 'sw-pop', ref: this.popoverRef(), style: { position: 'fixed', top: 0, left: 0, zIndex: 60, background: '#1c1c22', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, boxShadow: '0 14px 40px -12px rgba(0,0,0,.7)', padding: 4, minWidth: 158, animation: this.popAnim(key) } },
			items.slice(0, 7).map((s, i) => el('div', {
				onMouseDown: (e: MouseEvent) => { e.preventDefault(); onPick(s); },
				onMouseEnter: () => this.setState({ acIndex: i }),
				style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 9px', borderRadius: 6, fontFamily: '"IBM Plex Mono",monospace', fontSize: 12, color: i === ac ? '#ffffff' : '#d6d3e0', cursor: 'pointer', background: i === ac ? 'rgba(139,124,246,.3)' : 'transparent' }
			},
				el('span', null, s),
				i === ac ? el('span', { style: { fontFamily: '"IBM Plex Sans",sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: '#bcb0ff', border: '1px solid rgba(188,176,255,.4)', borderRadius: 3, padding: '0 4px' } }, 'TAB') : null)));
	}
	private keywordMenu(ri: number, di: number, prop: string): SvgEl {
		const opts = KEYWORDS[prop] || []; const cur = this.curRules()[ri].decls[di].v;
		return el('div', { className: 'sw-pop', ref: this.popoverRef(), style: { position: 'fixed', top: 0, left: 0, zIndex: 60, background: '#1c1c22', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, boxShadow: '0 14px 40px -12px rgba(0,0,0,.7)', padding: 4, minWidth: 140, animation: this.popAnim('kw:' + ri + '-' + di) } },
			opts.map((o) => el('div', {
				onClick: () => { this.updateDecl(ri, di, 'v', o); this.setState({ menu: null }); this.save(); },
				onMouseEnter: (e: MouseEvent) => { if (o !== cur) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,.06)'; },
				onMouseLeave: (e: MouseEvent) => { if (o !== cur) (e.currentTarget as HTMLElement).style.background = 'transparent'; },
				style: { display: 'flex', alignItems: 'center', gap: 7, padding: '5px 9px', borderRadius: 6, fontFamily: '"IBM Plex Mono",monospace', fontSize: 12, color: o === cur ? C_KW : '#d6d3e0', cursor: 'pointer', background: o === cur ? 'rgba(199,146,234,.12)' : 'transparent' }
			},
				el('span', { style: { width: 5, height: 5, borderRadius: '50%', background: o === cur ? C_KW : 'transparent', flex: 'none' } }), o)));
	}
	// font choices: fonts actually loaded on the page first, then the system stack.
	private fontOptions(): { label: string; value: string }[] {
		const loaded = this.loadedFonts().map((label) => ({ label, value: '"' + label + '", sans-serif' }));
		return [...loaded, ...SYSTEM_FONTS];
	}
	/** Filter fonts by the typed text — but show everything for an empty value or a
	 *  committed stack (which contains quotes/commas and isn't a search query). */
	private filteredFonts(query: string): { label: string; value: string }[] {
		const opts = this.fontOptions();
		const q = (query || '').trim().toLowerCase();
		if (!q || /["',]/.test(query)) return opts;
		const a = opts.filter((o) => o.label.toLowerCase().startsWith(q));
		const b = opts.filter((o) => !o.label.toLowerCase().startsWith(q) && o.label.toLowerCase().includes(q));
		return [...a, ...b];
	}
	private commitFont(ri: number, di: number, value: string): void {
		this.updateDecl(ri, di, 'v', value);
		this.setState({ focus: null, menu: null });
		this.save();
	}
	private fontMenu(ri: number, di: number, opts: { label: string; value: string }[], ac: number): SvgEl {
		const cur = this.curRules()[ri].decls[di].v;
		const item = (o: { label: string; value: string }, i: number): SvgEl => el('div', {
			onMouseDown: (e: MouseEvent) => { e.preventDefault(); this.commitFont(ri, di, o.value); },
			onMouseEnter: () => this.setState({ acIndex: i }),
			style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 6, fontSize: 12.5, color: o.value === cur ? C_FONT : '#d6d3e0', cursor: 'pointer', background: i === ac ? 'rgba(127,209,196,.2)' : (o.value === cur ? 'rgba(127,209,196,.1)' : 'transparent') }
		},
			el('span', { style: { width: 5, height: 5, borderRadius: '50%', background: o.value === cur ? C_FONT : 'transparent', flex: 'none' } }),
			el('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: o.value } }, o.label),
			el('span', { style: { fontFamily: o.value, color: '#7e7e8c', fontSize: 14, flex: 'none' } }, 'Ag'));
		return el('div', { className: 'sw-pop sw-scroll', ref: this.popoverRef(), style: { position: 'fixed', top: 0, left: 0, zIndex: 60, background: '#1c1c22', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, boxShadow: '0 16px 44px -12px rgba(0,0,0,.75)', padding: 4, minWidth: 208, maxHeight: 262, overflowY: 'auto', animation: this.popAnim('font:' + ri + '-' + di) } }, opts.map(item));
	}
	private colorPopover(): SvgEl | null {
		const c = this.state.color; if (!c) return null;
		const a = c.a == null ? 1 : c.a;
		const hueColor = rgbToHex(...hsvToRgb(c.h, 1, 1));
		const opaque = rgbToHex(...hsvToRgb(c.h, c.s, c.v));
		const cur = formatColor(c.h, c.s, c.v, a, c.fmt);
		const drag = (compute: (x: number, y: number) => void) => (e: MouseEvent): void => {
			const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const move = (ev: MouseEvent): void => {
				const x = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));
				const y = Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height));
				compute(x, y);
			};
			move(e);
			const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
			document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
		};
		const svDown = drag((x, y) => this.setColorHSV({ s: x, v: 1 - y }));
		const hueDown = drag((x) => this.setColorHSV({ h: x * 360 }));
		const alphaDown = drag((x) => this.setColorHSV({ a: Math.round(x * 100) / 100 }));
		return el('div', { className: 'sw-pop', ref: this.popoverRef(), onMouseDown: (e: MouseEvent) => e.stopPropagation(), style: { position: 'fixed', top: 0, left: 0, zIndex: 60, width: 196, background: '#1c1c22', border: '1px solid rgba(255,255,255,.13)', borderRadius: 10, boxShadow: '0 18px 50px -14px rgba(0,0,0,.75)', padding: 10, fontFamily: '"IBM Plex Sans",sans-serif', animation: this.popAnim('color:' + c.ri + '-' + c.di + '-' + c.tok) } },
			el('div', { onMouseDown: svDown, style: { position: 'relative', height: 108, borderRadius: 7, cursor: 'crosshair', background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,${hueColor})` } },
				el('div', { style: { position: 'absolute', left: `calc(${c.s * 100}% - 6px)`, top: `calc(${(1 - c.v) * 100}% - 6px)`, width: 12, height: 12, borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.5)', background: opaque, pointerEvents: 'none' } })),
			el('div', { onMouseDown: hueDown, style: { position: 'relative', height: 12, borderRadius: 6, marginTop: 10, cursor: 'pointer', background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' } },
				el('div', { style: { position: 'absolute', left: `calc(${c.h / 360 * 100}% - 6px)`, top: -2, width: 12, height: 16, borderRadius: 4, border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.5)', background: hueColor, pointerEvents: 'none' } })),
			el('div', { onMouseDown: alphaDown, style: { position: 'relative', height: 12, borderRadius: 6, marginTop: 9, cursor: 'pointer', ...alphaTrackStyle(opaque) } },
				el('div', { style: { position: 'absolute', left: `calc(${a * 100}% - 6px)`, top: -2, width: 12, height: 16, borderRadius: 4, border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.5)', pointerEvents: 'none', ...swatchStyle(cur) } })),
			el('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 } },
				el('span', { style: { width: 24, height: 24, borderRadius: 5, border: '1px solid rgba(255,255,255,.2)', flex: 'none', ...swatchStyle(cur) } }),
				el('input', {
					className: 'sw-in', 'data-fkey': this.fk(c.ri, c.di, 'v', 'hex'),
					value: c.hexText ?? cur, spellCheck: false,
					onFocus: () => { if (this.programmaticFocus) return; this.setState({ focus: { ri: c.ri, di: c.di, field: 'v', tok: 'hex' } }); },
					onChange: (e: Event) => {
						this.colorWasSeeded = false;
						const val = (e.target as HTMLInputElement).value;
						// ALWAYS show the raw text being typed (so "#3b8" doesn't reformat to "#33bb88"
						// mid-type), and sync the model/picker only when it parses to a valid color —
						// keeping the model's color token valid so this popover doesn't vanish.
						const next: ColorSel = { ...c, hexText: val };
						if (isColorValue(val.trim())) { this.updateToken(c.ri, c.di, c.tok, val); Object.assign(next, parseColor(val)); }
						this.setState({ color: next });
					},
					onBlur: () => { if (this.rebuilding || this.programmaticFocus) return; this.setState({ color: this.state.color ? { ...this.state.color, hexText: undefined } : null }); this.save(); }, // finalize to canonical form + persist
					style: { flex: 1, minWidth: 0, color: '#ececf1', fontFamily: '"IBM Plex Mono",monospace', fontSize: 11.5, background: '#101014', border: '1px solid rgba(255,255,255,.1)', borderRadius: 6, padding: '5px 8px' }
				}),
				el('button', { title: 'Cycle notation: hex → rgb → hsl', onClick: () => this.cycleFormat(), style: { flex: 'none', border: '1px solid rgba(255,255,255,.12)', background: '#101014', color: '#9a9aa6', fontFamily: '"IBM Plex Sans",sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', padding: '4px 6px', borderRadius: 5, cursor: 'pointer' } }, c.fmt.toUpperCase())),
			this.swatchSection('IN USE', this.pageColors(), cur),
			this.swatchSection('HISTORY', this.state.colorHistory || [], cur));
	}
	private swatchSection(label: string, colors: string[], cur: string): SvgEl | null {
		if (!colors || !colors.length) return null;
		return el('div', { style: { marginTop: 10 } },
			el('div', { style: { fontSize: 8.5, fontWeight: 700, letterSpacing: '.13em', color: '#5c5c66', marginBottom: 5 } }, label),
			el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 5 } },
				colors.map((p) => { const active = sameColor(p, cur); return el('button', { title: p, onClick: () => this.applySwatch(p), style: { width: '100%', aspectRatio: '1', borderRadius: 5, border: active ? '2px solid #fff' : '1px solid rgba(255,255,255,.14)', cursor: 'pointer', padding: 0, boxShadow: active ? '0 0 0 1px rgba(0,0,0,.4)' : 'none', ...swatchStyle(p) } }); })));
	}

	// ---------- per-token value editor ----------
	private tokInput(ri: number, di: number, k: number, value: string, color: string, kw?: string[] | null): SvgEl {
		return el('input', {
			className: 'sw-in', spellCheck: false, value, 'data-fkey': this.fk(ri, di, 'v', k),
			style: { color, width: Math.max(1, value.length) + 'ch' },
			onChange: (e: Event) => this.updateToken(ri, di, k, (e.target as HTMLInputElement).value),
			onFocus: () => { if (this.programmaticFocus) return; this.setState({ focus: { ri, di, field: 'v', tok: k }, menu: null, color: null, acIndex: 0 }); },
			onBlur: () => { if (this.rebuilding || this.programmaticFocus) return; setTimeout(() => { const f = this.state.focus; if (f && f.ri === ri && f.di === di && f.field === 'v' && f.tok === k) { this.setState({ focus: null }); this.save(); } }, 140); },
			onKeyDown: (e: KeyboardEvent) => {
				const sugg = kw ? rankList(kw, value) : [];
				const ac = Math.min(this.state.acIndex || 0, Math.max(0, sugg.length - 1));
				if (sugg.length && e.key === 'ArrowDown') { e.preventDefault(); this.setState({ acIndex: Math.min(ac + 1, sugg.length - 1) }); }
				else if (sugg.length && e.key === 'ArrowUp') { e.preventDefault(); this.setState({ acIndex: Math.max(ac - 1, 0) }); }
				else if (e.key === 'Tab' && sugg.length) { e.preventDefault(); this.updateToken(ri, di, k, sugg[ac]); this.setState({ focus: null }); this.save(); }
				else if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
			}
		});
	}
	private colorTok(ri: number, di: number, k: number, x: string): SvgEl {
		const open = !!this.state.color && this.state.color.ri === ri && this.state.color.di === di && this.state.color.tok === k;
		return el('span', { className: 'sw-pop-trigger', style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
			el('button', { className: 'sw-pop-trigger', title: 'Edit color · shift-click to cycle hex/rgb/hsl', onClick: (e: MouseEvent) => e.shiftKey ? this.cycleTokenFormat(ri, di, k) : (open ? this.closeColorPicker() : this.openColor(ri, di, k)), style: { width: 11, height: 11, borderRadius: 3, border: '1px solid rgba(255,255,255,.25)', ...swatchStyle(x), cursor: 'pointer', padding: 0, marginRight: 5, boxShadow: '0 0 0 1px rgba(0,0,0,.3)', alignSelf: 'center' } }),
			this.tokInput(ri, di, k, x, C_COLOR),
			open ? this.colorPopover() : null);
	}
	private numTok(ri: number, di: number, k: number, x: string): SvgEl {
		return el('span', { ref: this.wheelRefTok(ri, di, k), title: 'Scroll to adjust · ⇧ ×10', style: { position: 'relative', display: 'inline-block', cursor: 'ns-resize', borderRadius: 3 } },
			this.tokInput(ri, di, k, x, C_NUM));
	}
	private wordTok(ri: number, di: number, k: number, x: string, kw: string[] | null): SvgEl {
		const f = this.state.focus; const isF = !!f && f.ri === ri && f.di === di && f.field === 'v' && f.tok === k;
		const sugg = (kw && isF) ? rankList(kw, x) : [];
		const ac = Math.min(this.state.acIndex || 0, Math.max(0, sugg.length - 1));
		const children: (SvgEl | null)[] = [this.tokInput(ri, di, k, x, kw ? C_KW : C_TEXT, kw)];
		if (sugg.length) children.push(this.suggMenu(sugg, ac, (s) => { this.updateToken(ri, di, k, s); this.setState({ focus: null }); this.save(); }, 'sv:' + ri + '-' + di + '-' + k));
		return el('span', { style: { position: 'relative', display: 'inline-block' } }, children);
	}
	private fontValueInput(ri: number, di: number, value: string): SvgEl {
		const f = this.state.focus;
		const isF = !!f && f.ri === ri && f.di === di && f.field === 'v' && f.tok === 'font';
		const opts = this.filteredFonts(value);
		const ac = Math.min(this.state.acIndex || 0, Math.max(0, opts.length - 1));
		const input = el('input', {
			className: 'sw-in', spellCheck: false, value, 'data-fkey': this.fk(ri, di, 'v', 'font'),
			style: { color: C_FONT, width: Math.max(1, value.length) + 'ch' },
			onChange: (e: Event) => this.updateDecl(ri, di, 'v', (e.target as HTMLInputElement).value),
			onFocus: () => { if (this.programmaticFocus) return; this.setState({ focus: { ri, di, field: 'v', tok: 'font' }, menu: null, color: null, acIndex: 0 }); },
			onBlur: () => { if (this.rebuilding || this.programmaticFocus) return; setTimeout(() => { const g = this.state.focus; if (g && g.ri === ri && g.di === di && g.field === 'v') { this.setState({ focus: null }); this.save(); } }, 140); },
			onKeyDown: (e: KeyboardEvent) => {
				if (opts.length && e.key === 'ArrowDown') { e.preventDefault(); this.setState({ acIndex: Math.min(ac + 1, opts.length - 1) }); }
				else if (opts.length && e.key === 'ArrowUp') { e.preventDefault(); this.setState({ acIndex: Math.max(ac - 1, 0) }); }
				else if (e.key === 'Tab' && opts.length) { e.preventDefault(); this.commitFont(ri, di, opts[ac].value); }
				else if (e.key === 'Enter') { e.preventDefault(); if (opts.length) this.commitFont(ri, di, opts[ac].value); else (e.target as HTMLInputElement).blur(); }
				else if (e.key === 'Escape') { (e.target as HTMLInputElement).blur(); }
			}
		});
		const children: (SvgEl | null)[] = [input];
		if (isF && opts.length) children.push(this.fontMenu(ri, di, opts, ac)); // auto-open on focus, like the attribute type-ahead
		return el('span', { style: { position: 'relative', display: 'inline-block' } }, children);
	}
	/** While a value token is focused, edit the WHOLE value as one free-text input so a
	 *  keystroke can't re-split the token mid-edit ("16px" → "16xp", "1.5" → "15.",
	 *  typing a space, etc). Re-tokenizes back into per-token chips on blur. Keeps the
	 *  keyword type-ahead for keyword props. */
	private rawValueInput(ri: number, di: number, tok: number | string, d: { p: string; v: string }): SvgEl {
		const value = d.v;
		const kw = KEYWORDS[d.p];
		const sugg = kw ? rankList(kw, value) : [];
		const ac = Math.min(this.state.acIndex || 0, Math.max(0, sugg.length - 1));
		const input = el('input', {
			className: 'sw-in', spellCheck: false, value, 'data-fkey': this.fk(ri, di, 'v', tok),
			style: { color: kw ? C_KW : C_TEXT, width: Math.max(1, value.length) + 'ch' },
			onChange: (e: Event) => this.updateDecl(ri, di, 'v', (e.target as HTMLInputElement).value),
			onFocus: () => { if (this.programmaticFocus) return; this.setState({ focus: { ri, di, field: 'v', tok }, menu: null, color: null, acIndex: 0 }); },
			onBlur: () => { if (this.rebuilding || this.programmaticFocus) return; setTimeout(() => { const f = this.state.focus; if (f && f.ri === ri && f.di === di && f.field === 'v') { this.setState({ focus: null }); this.save(); } }, 140); },
			onKeyDown: (e: KeyboardEvent) => {
				if (sugg.length && e.key === 'ArrowDown') { e.preventDefault(); this.setState({ acIndex: Math.min(ac + 1, sugg.length - 1) }); }
				else if (sugg.length && e.key === 'ArrowUp') { e.preventDefault(); this.setState({ acIndex: Math.max(ac - 1, 0) }); }
				else if (e.key === 'Tab' && sugg.length) { e.preventDefault(); this.updateDecl(ri, di, 'v', sugg[ac]); this.setState({ focus: null }); this.save(); }
				else if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
			}
		});
		const children: (SvgEl | null)[] = [input];
		if (sugg.length) children.push(this.suggMenu(sugg, ac, (s) => { this.updateDecl(ri, di, 'v', s); this.setState({ focus: null }); this.save(); }, 'sv:' + ri + '-' + di + '-' + tok));
		return el('span', { style: { position: 'relative', display: 'inline-block' } }, children);
	}
	private valueEditor(ri: number, di: number, d: { p: string; v: string }): SvgEl[] {
		const f = this.state.focus;
		if (f && f.ri === ri && f.di === di && f.field === 'v' && f.tok !== 'font' && f.tok !== 'hex') {
			return [this.rawValueInput(ri, di, f.tok ?? 0, d)];
		}
		let toks = tokenize(d.v); if (toks.length === 0) toks = [{ t: 'word', x: '' }];
		const single = toks.filter((t) => t.t !== 'sep').length === 1; const kw = KEYWORDS[d.p];
		const renderTok = (t: Tok, k: number): SvgEl => {
			if (t.t === 'sep') return el('span', { style: { whiteSpace: 'pre', color: C_PUNCT } }, t.x);
			if (t.t === 'color') return this.colorTok(ri, di, k, t.x);
			if (t.t === 'num') return this.numTok(ri, di, k, t.x);
			return this.wordTok(ri, di, k, t.x, (single && kw) ? kw : null);
		};
		const out: SvgEl[] = []; let i = 0;
		while (i < toks.length) {
			const funcStart = toks[i].t !== 'sep' && toks[i + 1] && toks[i + 1].t === 'sep' && toks[i + 1].x === '(';
			const parenStart = toks[i].t === 'sep' && toks[i].x === '(';
			if (funcStart || parenStart) {
				let j = funcStart ? i + 1 : i, depth = 0;
				for (; j < toks.length; j++) { const t = toks[j]; if (t.t === 'sep') { if (t.x === '(') depth++; else if (t.x === ')') { depth--; if (depth === 0) break; } } }
				const groupEls: SvgEl[] = []; for (let k = i; k <= j && k < toks.length; k++) groupEls.push(renderTok(toks[k], k));
				out.push(el('span', { style: { display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap' } }, groupEls));
				i = j + 1;
			} else { out.push(renderTok(toks[i], i)); i++; }
		}
		return out;
	}

	// ---------- property type-ahead ----------
	private suggestionsFor(ri: number, di: number, field: 'p' | 'v', value: string): string[] {
		if (field === 'p') { const q = value.toLowerCase(); const s = PROPS.filter((p) => p !== value); const a = s.filter((p) => p.startsWith(q)); const b = s.filter((p) => !p.startsWith(q) && p.indexOf(q) >= 0); return [...a, ...b]; }
		const prop = this.curRules()[ri].decls[di].p; const kw = KEYWORDS[prop]; if (!kw) return []; return rankList(kw, value);
	}
	private commitProp(ri: number, di: number, value: string, sugg: string[], ac: number): void {
		let pick: string;
		if (PROPS.indexOf(value) >= 0) pick = value;
		else if (sugg && sugg.length) pick = sugg[ac];
		else pick = value;
		this.pickProp(ri, di, pick || value);
	}
	private pickProp(ri: number, di: number, name: string): void {
		if (name && name !== this.curRules()[ri].decls[di].p) this.updateDecl(ri, di, 'p', name);
		if (COLORISH.indexOf(name) >= 0) this.openColorForFirst(ri, di); else this.focusFirstValue(ri, di);
	}
	/** font-family renders one fontValueInput keyed 'font'; everything else is a value token. */
	private valueFocusTok(ri: number, di: number, last: boolean): number | string {
		if (this.curRules()[ri].decls[di].p === 'font-family') return 'font';
		const toks = tokenize(this.curRules()[ri].decls[di].v);
		let k = -1;
		if (last) { for (let i = 0; i < toks.length; i++) if (toks[i].t !== 'sep') k = i; }
		else k = toks.findIndex((t) => t.t !== 'sep');
		return k < 0 ? 0 : k;
	}
	private focusFirstValue(ri: number, di: number): void {
		const k = this.valueFocusTok(ri, di, false);
		this.setState({ focus: { ri, di, field: 'v', tok: k }, acIndex: 0, menu: null, color: null }); this.focusField(this.fk(ri, di, 'v', k));
	}
	private focusLastValue(ri: number, di: number): void {
		const k = this.valueFocusTok(ri, di, true);
		this.setState({ focus: { ri, di, field: 'v', tok: k }, acIndex: 0, menu: null, color: null }); this.focusField(this.fk(ri, di, 'v', k));
	}
	private editToken(ri: number, di: number): SvgEl {
		const value = this.curRules()[ri].decls[di].p;
		const sugg = this.suggestionsFor(ri, di, 'p', value);
		const f = this.state.focus; const isFocused = !!f && f.ri === ri && f.di === di && f.field === 'p';
		const ac = Math.min(this.state.acIndex || 0, Math.max(0, sugg.length - 1));
		const input = el('input', {
			className: 'sw-in', spellCheck: false, value, 'data-fkey': this.fk(ri, di, 'p'),
			style: { color: C_PROP, width: Math.max(1, value.length) + 'ch' },
			onChange: (e: Event) => this.updateDecl(ri, di, 'p', (e.target as HTMLInputElement).value),
			onFocus: () => { if (this.programmaticFocus) return; this.setState({ focus: { ri, di, field: 'p' }, menu: null, color: null, acIndex: 0 }); },
			onBlur: () => { if (this.rebuilding || this.programmaticFocus) return; setTimeout(() => { const g = this.state.focus; if (!(g && g.ri === ri && g.di === di && g.field === 'p')) return; const d = this.curRules()[ri] && this.curRules()[ri].decls[di]; if (d && !d.p.trim() && !d.v.trim()) this.removeDecl(ri, di); else this.setState({ focus: null }); }, 140); },
			onKeyDown: (e: KeyboardEvent) => {
				if (sugg.length && e.key === 'ArrowDown') { e.preventDefault(); this.setState({ acIndex: Math.min(ac + 1, sugg.length - 1) }); }
				else if (sugg.length && e.key === 'ArrowUp') { e.preventDefault(); this.setState({ acIndex: Math.max(ac - 1, 0) }); }
				else if (e.key === 'Tab' || e.key === 'Enter' || e.key === ':') { e.preventDefault(); this.commitProp(ri, di, value, sugg, ac); }
			}
		});
		const children: (SvgEl | null)[] = [input];
		if (isFocused && sugg.length) children.push(this.suggMenu(sugg, ac, (s) => this.pickProp(ri, di, s), 'sp:' + ri + '-' + di));
		return el('span', { style: { position: 'relative', display: 'inline-block' } }, children);
	}

	// ---------- declaration line + editor ----------
	private declLine(d: { p: string; v: string }, ri: number, di: number): SvgEl {
		const kind = classify(d.p, d.v);
		const left: (SvgEl | null)[] = [
			el('span', { style: { display: 'inline-flex', marginLeft: '-2ch' } }, this.editToken(ri, di)),
			el('span', { style: { color: C_PUNCT } }, ': ')
		];
		if (kind === 'font') left.push(this.fontValueInput(ri, di, d.v));
		else this.valueEditor(ri, di, d).forEach((e) => left.push(e));
		if (kind === 'keyword' || kind === 'font') {
			const mopen = !!this.state.menu && this.state.menu.ri === ri && this.state.menu.di === di;
			// font's dropdown is rendered inline by fontValueInput on focus, so its caret
			// just focuses the value (which auto-opens it); keyword keeps the click menu.
			const onCaret = kind === 'font'
				? () => { this.setState({ focus: { ri, di, field: 'v', tok: 'font' }, menu: null, color: null, acIndex: 0 }); this.focusField(this.fk(ri, di, 'v', 'font')); }
				: () => this.setState({ menu: mopen ? null : { ri, di }, color: null, focus: null });
			left.push(el('span', { className: 'sw-pop-trigger', style: { position: 'relative', display: 'inline-block' } },
				el('button', { className: 'sw-pop-trigger', onClick: onCaret, style: { border: 0, background: 'transparent', color: '#7e7e8c', cursor: 'pointer', padding: '0 2px', verticalAlign: 'middle' } },
					ic(9, '0 0 24 24', { fill: 'currentColor' }, pth('M6 9l6 6 6-6Z'))),
				(kind === 'keyword' && mopen) ? this.keywordMenu(ri, di, d.p) : null));
		}
		left.push(el('span', { style: { color: C_PUNCT } }, ';'));
		const ov = this.overriddenBy(ri, d.p);
		if (ov) left.push(el('span', {
			title: 'Overridden at the current width by ' + ov.full,
			style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: '9.5px', color: '#8a8a96', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 4, padding: '0 5px', lineHeight: '15px', alignSelf: 'center', marginLeft: 6, whiteSpace: 'nowrap', flex: 'none' }
		}, '↓ ' + ov.label));
		const trailing = el('input', {
			className: 'sw-in', 'aria-label': 'insert declaration here', spellCheck: false, value: '',
			onChange: () => { /* trailing zone is write-only via keydown */ },
			style: { flex: 1, minWidth: 24, alignSelf: 'stretch', cursor: 'text', caretColor: '#8b7cf6', color: C_TEXT },
			onKeyDown: (e: KeyboardEvent) => {
				if (e.key === 'Enter') { e.preventDefault(); this.addDeclAfter(ri, di); }
				else if (e.key === 'ArrowLeft') { e.preventDefault(); this.focusLastValue(ri, di); }
				else if (e.key === 'Backspace' || e.key === 'Delete') {
					e.preventDefault();
					const cur = this.curRules()[ri].decls[di].v;
					if ((cur || '').trim() === '') { this.removeDecl(ri, di); }
					else { this.updateDecl(ri, di, 'v', ''); this.save(); this.focusLastValue(ri, di); }
				} else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.addDeclAfter(ri, di, e.key.toLowerCase()); }
			}
		});
		const removeBtn = el('button', {
			className: 'sw-rm', title: 'Remove declaration', onClick: () => this.removeDecl(ri, di),
			onMouseEnter: (e: MouseEvent) => (e.currentTarget as HTMLElement).style.color = '#f87171',
			onMouseLeave: (e: MouseEvent) => (e.currentTarget as HTMLElement).style.color = '#4b4b57',
			style: { border: 0, background: 'transparent', color: '#4b4b57', cursor: 'pointer', marginLeft: 4, opacity: 0, transition: 'opacity .1s', padding: 0, flex: 'none', alignSelf: 'center' }
		}, ic(11, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }, pth('M5 5l14 14M19 5L5 19')));
		return el('div', {
			style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', whiteSpace: 'pre', padding: '1px 4px 1px 4ch', borderRadius: 4, position: 'relative', ...(ov ? { opacity: '0.72' } : {}) },
			onMouseEnter: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.querySelectorAll<HTMLElement>('.sw-rm').forEach((b) => b.style.opacity = '1'); t.style.background = 'rgba(255,255,255,.03)'; },
			onMouseLeave: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.querySelectorAll<HTMLElement>('.sw-rm').forEach((b) => b.style.opacity = '0'); t.style.background = 'transparent'; }
		}, left, trailing, removeBtn);
	}
	private addLine(ri: number): SvgEl {
		return el('div', { style: { whiteSpace: 'pre', padding: '2px 0' } },
			el('span', { style: { whiteSpace: 'pre' } }, '  '),
			el('button', {
				onClick: () => this.addDecl(ri),
				onMouseEnter: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.style.borderColor = 'rgba(139,124,246,.5)'; t.style.color = '#9d8cf8'; },
				onMouseLeave: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.style.borderColor = 'rgba(255,255,255,.14)'; t.style.color = '#6a6a78'; },
				style: { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px dashed rgba(255,255,255,.14)', background: 'transparent', color: '#6a6a78', fontFamily: '"IBM Plex Mono",monospace', fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer' }
			}, ic(11, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }, pth('M12 5v14M5 12h14')), 'add declaration'));
	}
	// ---------- @media awareness + DOM ordering ----------
	/** A live-DOM-matchable form of a source selector: unwrap `:global()`, drop
	 *  pseudo-elements / pseudo-classes so `document.querySelector` can find a
	 *  representative element to order by. */
	private matchableSelector(sel: string): string {
		return sel
			.replace(/:global\(([^)]*)\)/g, '$1')
			.replace(/::[\w-]+/g, '')
			.replace(/:[\w-]+(\([^)]*\))?/g, '')
			.trim();
	}
	/** Does this at-rule apply at the CURRENT viewport? Only @media is evaluated;
	 *  other at-rules are treated as always-on so we don't dim them. */
	private atRuleMatches(m: SwAtRule): boolean {
		if (m.name.toLowerCase() !== 'media') return true;
		const memo = this.mediaMemo.get(m.params);
		if (memo !== undefined) return memo;
		const res = this.computeAtRuleMatch(m.params);
		this.mediaMemo.set(m.params, res);
		return res;
	}
	private computeAtRuleMatch(params: string): boolean {
		const w = this.state.whatIfWidth;
		if (w != null) {
			const q = parseWidthQuery(params);
			// Previewing a width: evaluate width queries against it; a non-width query
			// (orientation, etc.) can't be simulated, so fall through to the real match.
			if (q) return (q.min == null || w >= q.min) && (q.max == null || w <= q.max);
		}
		try { return window.matchMedia(params).matches; } catch { return true; }
	}
	private ruleActive(rule: Rule): boolean {
		const memo = this.activeMemo.get(rule);
		if (memo !== undefined) return memo;
		const res = !rule.media || rule.media.every((m) => this.atRuleMatches(m));
		this.activeMemo.set(rule, res);
		return res;
	}
	/** If `prop` in rule `ri` is overridden at the CURRENT viewport by another ACTIVE
	 *  rule with the same selector later in the cascade (typically a wider @media
	 *  override that's winning), return that winner's label; else null. Same-selector
	 *  only — equal specificity, so source order decides; the common breakpoint case. */
	private overriddenBy(ri: number, prop: string): { label: string; full: string } | null {
		const p = prop.trim();
		if (!p) return null;
		const rs = this.state.rules;
		const base = rs[ri];
		if (!base || !this.ruleActive(base)) return null; // inactive rules are dimmed wholesale already
		const sel = normSel(base.sel);
		// Only same-selector rules can override at equal specificity — look them up
		// instead of rescanning (and re-normSel-ing) the whole rule list per decl (PERF-3).
		const group = this.selGroups().get(sel);
		if (!group || group.length < 2) return null;
		const ord = (r: Rule, i: number) => (typeof r.id === 'number' ? r.id : i);
		let winnerIdx = -1, winnerOrd = ord(base, ri);
		for (const i of group) {
			if (i === ri) continue;
			const r = rs[i];
			if (!this.ruleActive(r)) continue;
			if (!r.decls.some((d) => d.p.trim() === p && d.v.trim())) continue;
			const o = ord(r, i);
			if (o > winnerOrd) { winnerIdx = i; winnerOrd = o; }
		}
		if (winnerIdx < 0) return null;
		const w = rs[winnerIdx];
		const hasMedia = !!(w.media && w.media.length);
		const label = hasMedia ? w.media!.map((m) => this.shortMedia(m).replace('@media ', '')).join(' · ') : 'later rule';
		const full = hasMedia ? w.media!.map((m) => `@${m.name} ${m.params}`).join(' ') : w.sel;
		return { label, full };
	}
	/** Order rules by the document position of their matching element (top-to-bottom),
	 *  so each @media override lands right under its base rule; same-element rules keep
	 *  source order; selectors matching nothing on the page sink to the bottom. Returns
	 *  source indices (ri) in display order — ri stays the array index used for editing. */
	/** normalized-selector → source indices sharing it, in array order. Cached by the
	 *  selector signature, so it's built once per distinct rule set and reused across a
	 *  render's per-declaration overriddenBy() calls (PERF-3). */
	private selGroups(): Map<string, number[]> {
		const rs = this.state.rules;
		const key = rs.map((r) => r.sel).join('');
		if (this.selGroupCache && this.selGroupCache.key === key) return this.selGroupCache.map;
		const map = new Map<string, number[]>();
		rs.forEach((r, i) => { const s = normSel(r.sel); const a = map.get(s); if (a) a.push(i); else map.set(s, [i]); });
		this.selGroupCache = { key, map };
		return map;
	}
	private orderedView(): number[] {
		const rs = this.state.rules;
		// DOM order is invariant under CSS edits, so memoize it keyed by the selector set
		// + treeRev (which bumps on pick/DOM change). A value keystroke reuses it instead
		// of walking the whole document every render (PERF-1).
		const cacheKey = this.state.treeRev + '|' + rs.map((r) => r.sel).join('');
		if (this.orderCache && this.orderCache.key === cacheKey) return this.orderCache.order;
		const idx = rs.map((_, i) => i);
		const FAR = Number.MAX_SAFE_INTEGER;
		let pos: Map<Element, number> | null = null;
		try {
			pos = new Map(Array.from(document.querySelectorAll('*')).map((e, i) => [e, i] as const));
		} catch { pos = null; }
		const domIndex = (sel: string): number => {
			if (!pos) return FAR;
			const cleaned = this.matchableSelector(sel);
			if (!cleaned) return FAR;
			let elx: Element | null = null;
			try { elx = document.querySelector(cleaned); } catch { elx = null; }
			return elx ? (pos.get(elx) ?? FAR) : FAR;
		};
		const key = new Map<number, number>(idx.map((i) => [i, domIndex(rs[i].sel)]));
		const order = idx.sort((a, b) => (key.get(a)! - key.get(b)!) || (a - b));
		this.orderCache = { key: cacheKey, order };
		return order;
	}
	/** Short label for an @media chip, e.g. "@media ≥768". */
	private shortMedia(m: SwAtRule): string {
		const min = m.params.match(/min-width:\s*([\d.]+)px/);
		const max = m.params.match(/max-width:\s*([\d.]+)px/);
		if (min) return `@media ≥${min[1]}`;
		if (max) return `@media ≤${max[1]}`;
		return `@${m.name}`;
	}
	private mediaChip(media: SwAtRule[]): SvgEl {
		const active = media.every((m) => this.atRuleMatches(m));
		const label = media.map((m) => this.shortMedia(m)).join(' · ');
		const full = media.map((m) => `@${m.name} ${m.params}`).join('  ');
		return el('span', {
			title: full + (active ? ' — active at this width' : ' — inactive at this width'),
			style: {
				fontFamily: '"IBM Plex Mono",monospace', fontSize: '10px', padding: '0 6px',
				borderRadius: '4px', lineHeight: '16px', alignSelf: 'center', flex: 'none',
				background: active ? 'rgba(52,211,153,.14)' : 'rgba(255,255,255,.05)',
				color: active ? '#34d399' : '#8a8a96',
				border: `1px solid ${active ? 'rgba(52,211,153,.32)' : 'rgba(255,255,255,.1)'}`
			}
		}, label);
	}
	private ruleHeaderLine(rule: Rule, ri: number): SvgEl {
		const hasMedia = !!(rule.media && rule.media.length);
		const widthBased = hasMedia && !!parseWidthQuery(rule.media![0].params);
		const editing = this.state.editBp === ri;
		let mediaEl: SvgEl | null = null;
		if (hasMedia) {
			if (editing && widthBased) mediaEl = this.bpInput(ri, rule);
			else if (widthBased) mediaEl = el('button', { className: 'sw-pop-trigger', title: 'Edit this breakpoint (moves every rule under it)', onClick: () => this.setState({ editBp: ri, focus: null, color: null, menu: null }), style: { border: 0, background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex' } }, this.mediaChip(rule.media!));
			else mediaEl = this.mediaChip(rule.media!);
		}
		return el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px', flexWrap: 'wrap', whiteSpace: 'pre', padding: '1px 0' } },
			mediaEl,
			el('span', { style: { color: C_SEL } }, rule.sel),
			el('span', { style: { color: C_PUNCT } }, ' {'),
			el('span', { style: { flex: '1' } }),
			hasMedia ? this.removeRuleBtn(ri) : null);
	}
	/** Inline editor for a rule's @media min-width (Enter/blur commits, Esc cancels). */
	private bpInput(ri: number, rule: Rule): SvgEl {
		const cur = (rule.media![0].params.match(/([\d.]+)px/) || [])[1] || '768';
		const commit = (e: Event): void => { const v = parseFloat((e.target as HTMLInputElement).value); if (v > 0) void this.commitBreakpoint(ri, v); else this.setState({ editBp: null }); };
		return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, alignSelf: 'center' } },
			el('span', { style: { color: '#8a8a96', fontSize: '10px', fontFamily: '"IBM Plex Mono",monospace' } }, '@media ≥'),
			el('input', {
				className: 'sw-in', value: cur, spellCheck: false,
				ref: (n: HTMLElement) => setTimeout(() => { const i = n as HTMLInputElement; i.focus(); i.select(); }, 0),
				style: { width: '5ch', color: '#c4baff', fontFamily: '"IBM Plex Mono",monospace', fontSize: '11px', background: '#101014', border: '1px solid rgba(139,124,246,.4)', borderRadius: 4, padding: '1px 4px' },
				onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } else if (e.key === 'Escape') this.setState({ editBp: null }); },
				onBlur: (e: Event) => { if (this.rebuilding) return; commit(e); }
			}),
			el('span', { style: { color: '#8a8a96', fontSize: '10px', fontFamily: '"IBM Plex Mono",monospace' } }, 'px'));
	}
	private removeRuleBtn(ri: number): SvgEl {
		return el('button', {
			title: 'Remove this rule', onClick: () => void this.removeRule(ri),
			onMouseEnter: (e: MouseEvent) => (e.currentTarget as HTMLElement).style.color = '#f87171',
			onMouseLeave: (e: MouseEvent) => (e.currentTarget as HTMLElement).style.color = '#5c5c66',
			style: { border: 0, background: 'transparent', color: '#5c5c66', cursor: 'pointer', padding: '0 2px', flex: 'none', alignSelf: 'center' }
		}, ic(11, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }, pth('M5 5l14 14M19 5L5 19')));
	}
	/** "+ @media override" — creates a responsive override for a base (non-media) rule. */
	private addOverrideLine(ri: number): SvgEl {
		return el('div', { style: { whiteSpace: 'pre', padding: '3px 0 0' } },
			el('span', { style: { whiteSpace: 'pre' } }, '  '),
			el('button', {
				title: 'Add a responsive @media override for this selector', onClick: () => void this.addOverride(ri),
				onMouseEnter: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.style.borderColor = 'rgba(139,124,246,.5)'; t.style.color = '#9d8cf8'; },
				onMouseLeave: (e: MouseEvent) => { const t = e.currentTarget as HTMLElement; t.style.borderColor = 'rgba(255,255,255,.1)'; t.style.color = '#6a6a78'; },
				style: { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px dashed rgba(255,255,255,.1)', background: 'transparent', color: '#6a6a78', fontFamily: '"IBM Plex Mono",monospace', fontSize: 10.5, padding: '2px 8px', borderRadius: 6, cursor: 'pointer' }
			}, ic(10, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }, pth('M12 5v14M5 12h14')), '@media override'));
	}
	/** Bar above the rules: "Focused on .x" with a Show all / Focus toggle. Only
	 *  shown when the picked element matches some-but-not-all of the rules. */
	private focusBar(focused: boolean, total: number): SvgEl {
		const label = this.pickedLabel || (this.state.meta && this.state.meta.selectorLabel) || 'element';
		const txt = focused ? `Focused on ${label}` : `Showing all ${total} rules`;
		const btn = focused ? `Show all (${total})` : `Focus ${label}`;
		return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 4px 8px', marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,.06)' } },
			el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: '10.5px', color: '#8a8a96' } }, txt),
			el('span', { style: { flex: '1' } }),
			el('button', {
				onClick: () => this.setState({ focusPick: !this.state.focusPick }),
				style: { border: '1px solid rgba(139,124,246,.3)', background: 'rgba(139,124,246,.1)', color: '#c4baff', borderRadius: '5px', padding: '2px 9px', cursor: 'pointer', fontFamily: '"IBM Plex Mono",monospace', fontSize: '10.5px' }
			}, btn));
	}
	/** Distinct width breakpoints used by the component's rules (min ascending, max descending). */
	private breakpoints(): { minW: number[]; maxW: number[] } {
		const minSet = new Set<number>(), maxSet = new Set<number>();
		this.state.rules.forEach((r) => (r.media || []).forEach((m) => {
			if (m.name.toLowerCase() !== 'media') return;
			const q = parseWidthQuery(m.params);
			if (q?.min != null) minSet.add(q.min);
			if (q?.max != null) maxSet.add(q.max);
		}));
		return { minW: [...minSet].sort((a, b) => a - b), maxW: [...maxSet].sort((a, b) => b - a) };
	}
	/** A what-if breakpoint switcher built from the component's REAL @media widths. It
	 *  re-evaluates which rules win at a chosen width (dimming only — it can't resize
	 *  the real viewport). Hidden when the component has no width breakpoints. */
	private buildSwitcher(): SvgEl | null {
		const { minW, maxW } = this.breakpoints();
		if (!minW.length && !maxW.length) return null;
		const wi = this.state.whatIfWidth;
		const chip = (label: string, active: boolean, w: number | null, title: string): SvgEl => el('button', {
			title, onClick: () => this.setState({ whatIfWidth: w }),
			style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: '10px', lineHeight: '17px', padding: '0 8px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap', flex: 'none', background: active ? 'rgba(139,124,246,.25)' : 'rgba(255,255,255,.04)', color: active ? '#c4baff' : '#9a9aa6', border: `1px solid ${active ? 'rgba(139,124,246,.5)' : 'rgba(255,255,255,.1)'}` }
		}, label);
		const chips: (SvgEl | null)[] = [chip(`Live · ${this.state.realW}px`, wi == null, null, 'Follow the real viewport width')];
		if (minW.length) { const base = Math.max(0, minW[0] - 1); chips.push(chip('Base', wi === base, base, `Preview below ${minW[0]}px (no min-width overrides active)`)); }
		minW.forEach((w) => chips.push(chip(`≥${w}`, wi === w, w, `Preview at ${w}px`)));
		maxW.forEach((w) => chips.push(chip(`≤${w}`, wi === w, w, `Preview at ${w}px`)));
		return el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '0 4px 10px', marginBottom: 8, borderBottom: '1px solid rgba(255,255,255,.06)' } },
			el('span', { style: { fontFamily: '"IBM Plex Sans",sans-serif', fontSize: '9px', fontWeight: 700, letterSpacing: '.12em', color: '#5c5c66', flex: 'none' } }, 'WIDTH'),
			...chips,
			wi != null ? el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: '9.5px', color: '#8a8a96', flex: 'none' } }, '· preview only') : null);
	}
	private buildEditor(): SvgEl {
		const rs = this.curRules();
		const order = this.orderedView();
		const canFocus = !!(this.pickedRis && this.pickedRis.size > 0 && this.pickedRis.size < rs.length);
		const focused = canFocus && this.state.focusPick;
		const displayRis = focused ? order.filter((ri) => this.pickedRis!.has(ri)) : order;
		const out: SvgEl[] = [];
		if (canFocus) out.push(this.focusBar(focused, rs.length));
		const switcher = this.buildSwitcher();
		if (switcher) out.push(switcher);
		displayRis.forEach((ri, idx) => {
			const rule = rs[ri];
			const active = this.ruleActive(rule);
			const isResp = !!(rule.media && rule.media.length);
			const inner: SvgEl[] = [this.ruleHeaderLine(rule, ri)];
			rule.decls.forEach((d, di) => inner.push(this.declLine(d, ri, di)));
			inner.push(this.addLine(ri));
			inner.push(el('div', { style: { whiteSpace: 'pre', padding: '1px 0' } }, el('span', { style: { color: C_PUNCT } }, '}')));
			if (!isResp) inner.push(this.addOverrideLine(ri));
			out.push(el('div', {
				style: {
					opacity: active ? '1' : '0.5',
					transition: 'opacity .15s',
					marginBottom: idx < displayRis.length - 1 ? '12px' : '0',
					...(isResp ? { borderLeft: '2px solid rgba(139,124,246,.3)', marginLeft: '4px', paddingLeft: '7px' } : {})
				}
			}, inner));
		});
		return el('div', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: 12.5, lineHeight: '22px' } }, out);
	}

	// ---------- overlay chrome ----------
	private onHeaderDown(e: MouseEvent): void {
		if (this.state.dock !== 'float') return;
		const sx = e.clientX, sy = e.clientY; const f = this.state.float;
		const ox = f.x == null ? (window.innerWidth - 432) : f.x; const oy = f.y == null ? 80 : f.y;
		const mv = (ev: MouseEvent): void => this.setState({ float: { x: ox + (ev.clientX - sx), y: Math.max(56, oy + (ev.clientY - sy)) } });
		const up = (): void => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
		document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
	}
	private panelStyle(): string {
		const dock = this.state.dock, sz = this.state.size;
		if (dock === 'right') return `position:fixed;top:64px;right:14px;bottom:14px;width:${sz.side}px;`;
		if (dock === 'left') return `position:fixed;top:64px;left:14px;bottom:14px;width:${sz.side}px;`;
		if (dock === 'bottom') return `position:fixed;left:14px;right:14px;bottom:14px;height:${sz.bottom}px;`;
		const f = this.state.float; const x = f.x == null ? (window.innerWidth - sz.floatW - 16) : f.x; const y = f.y == null ? 80 : f.y;
		return `position:fixed;left:${x}px;top:${y}px;width:${sz.floatW}px;height:${sz.floatH}px;`;
	}
	private dkStyle(active: boolean): Record<string, string | number> {
		return { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 23, height: 21, border: 0, borderRadius: 5, cursor: 'pointer', background: active ? 'rgba(139,124,246,.2)' : 'transparent', color: active ? '#c4baff' : '#7e7e8c' };
	}
	private buildHeader(): SvgEl {
		const dock = this.state.dock;
		const dockBtn = (which: Dock, title: string, ...kids: SvgEl[]): SvgEl =>
			el('button', { title, onClick: () => this.setState({ dock: which }), style: this.dkStyle(dock === which) }, ic(15, '0 0 16 16', { fill: 'none' }, ...kids));
		return el('div', { onMouseDown: (e: MouseEvent) => this.onHeaderDown(e), style: `display:flex;align-items:center;gap:9px;padding:10px 11px 10px 13px;background:#1c1c22;border-bottom:1px solid rgba(255,255,255,.07);flex:none;${dock === 'float' ? 'cursor:grab;' : ''}` },
			el('span', { style: 'width:8px;height:8px;border-radius:2px;background:linear-gradient(135deg,#8b7cf6,#6d5efc);flex:none;box-shadow:0 0 10px rgba(139,124,246,.6);' }),
			el('span', { style: 'font-size:12.5px;font-weight:600;letter-spacing:.01em;' }, 'Stylewright'),
			el('span', { style: 'flex:1;' }),
			el('button', { className: 'sw-iconbtn', title: 'Pick another element', onClick: () => this.setState({ view: 'pick', hl: null }), style: 'display:flex;align-items:center;justify-content:center;width:25px;height:25px;border:0;background:transparent;color:#9a9aa6;border-radius:6px;cursor:pointer;' },
				ic(15, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M12 2v3M12 19v3M2 12h3M19 12h3'), el('circle', { cx: 12, cy: 12, r: 4 }))),
			el('button', { className: 'sw-iconbtn', title: this.state.showHtml ? 'Hide DOM tree' : 'Show DOM tree', onClick: () => { this.domModelRev++; this.bumpTree({ showHtml: !this.state.showHtml }); }, style: `display:flex;align-items:center;justify-content:center;width:25px;height:25px;border:0;border-radius:6px;cursor:pointer;background:${this.state.showHtml ? 'rgba(139,124,246,.2)' : 'transparent'};color:${this.state.showHtml ? '#c4baff' : '#9a9aa6'};` },
				ic(15, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3'))),
			el('div', { style: 'display:flex;align-items:center;gap:2px;background:#101014;border:1px solid rgba(255,255,255,.07);border-radius:7px;padding:2px;' },
				dockBtn('left', 'Dock left', el('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.3 }), el('rect', { x: 2.6, y: 3.6, width: 4, height: 8.8, rx: 1, fill: 'currentColor' })),
				dockBtn('bottom', 'Dock bottom', el('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.3 }), el('rect', { x: 2.6, y: 9, width: 10.8, height: 3.4, rx: 1, fill: 'currentColor' })),
				dockBtn('right', 'Dock right', el('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.3 }), el('rect', { x: 9.4, y: 3.6, width: 4, height: 8.8, rx: 1, fill: 'currentColor' })),
				dockBtn('float', 'Float', el('rect', { x: 2, y: 4, width: 9, height: 7, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.3 }), el('rect', { x: 6, y: 6.5, width: 8, height: 6.5, rx: 1.3, fill: '#16161b', stroke: 'currentColor', strokeWidth: 1.3 }))),
			el('button', { className: 'sw-iconbtn', title: 'Close', onClick: () => this.setState({ view: 'closed' }), style: 'display:flex;align-items:center;justify-content:center;width:25px;height:25px;border:0;background:transparent;color:#9a9aa6;border-radius:6px;cursor:pointer;' },
				ic(15, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }, pth('M5 5l14 14M19 5L5 19'))));
	}
	private buildBreadcrumb(): SvgEl {
		const m = this.state.meta;
		return el('div', { style: 'display:flex;align-items:center;gap:8px;padding:9px 13px;background:#15151a;border-bottom:1px solid rgba(255,255,255,.06);flex:none;flex-wrap:wrap;' },
			ic(13, '0 0 24 24', { fill: C_SEL }, pth('M12 2 2 7l10 5 10-5-10-5Z', { opacity: 0.9 }), pth('M2 12l10 5 10-5M2 17l10 5 10-5', { stroke: C_SEL, strokeWidth: 1.6, fill: 'none', opacity: 0.55 })),
			el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: 12, color: C_SEL } }, m ? m.fileLabel : '—'),
			ic(11, '0 0 24 24', { fill: 'none', stroke: C_PUNCT, strokeWidth: 2.5, strokeLinecap: 'round' }, pth('M9 6l6 6-6 6')),
			el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: 12, color: '#9d8cf8' } }, m ? m.selectorLabel : ''),
			el('span', { style: 'flex:1;' }),
			el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: 10.5, color: '#6a6a78', background: '#101014', border: '1px solid rgba(255,255,255,.06)', padding: '2px 7px', borderRadius: 5 } }, m ? m.dims : ''));
	}
	private buildStatusBar(): SvgEl {
		const st = this.state.status;
		const color = ({ idle: '#9a9aa6', saving: '#c4baff', ok: '#34d399', err: '#f87171' } as Record<StatusKind, string>)[st.kind];
		let badge: SvgEl;
		if (st.kind === 'saving') badge = el('span', { style: 'width:12px;height:12px;border-radius:50%;border:2px solid rgba(139,124,246,.3);border-top-color:#8b7cf6;animation:sw-spin .6s linear infinite;flex:none;' });
		else if (st.kind === 'ok') badge = el('span', { style: 'width:13px;height:13px;border-radius:50%;background:#34d399;display:flex;align-items:center;justify-content:center;flex:none;' }, ic(9, '0 0 24 24', { fill: 'none', stroke: '#0c1410', strokeWidth: 3.5, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M4 12l5 5L20 6')));
		else if (st.kind === 'err') badge = el('span', { style: 'width:13px;height:13px;border-radius:50%;background:#f87171;display:flex;align-items:center;justify-content:center;flex:none;color:#2a0c0c;font-weight:800;font-size:10px;' }, '!');
		else badge = el('span', { style: 'width:7px;height:7px;border-radius:50%;background:#4b4b57;flex:none;' });
		return el('div', { style: 'display:flex;align-items:center;gap:9px;padding:8px 13px;background:#15151a;border-top:1px solid rgba(255,255,255,.07);flex:none;font-size:12px;' },
			badge,
			el('span', { style: `color:${color};flex:1;font-family:"IBM Plex Mono",monospace;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` }, st.text),
			el('span', { style: 'font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:#5c5c66;flex:none;' }, '⌘S'));
	}
	private buildEditBody(): SvgEl {
		return el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;' },
			this.buildBreadcrumb(),
			el('div', { className: 'sw-scroll', 'data-sw-editor': '1', style: 'flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 4px 14px 14px;background:#101014;' }, this.buildEditor()),
			this.buildStatusBar());
	}
	private buildNoMeta(): SvgEl {
		return el('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:34px 28px;text-align:center;' },
			el('div', { style: 'width:46px;height:46px;border-radius:12px;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);display:flex;align-items:center;justify-content:center;color:#f87171;' },
				ic(22, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }, el('circle', { cx: 11, cy: 11, r: 7 }), pth('M21 21l-4-4M11 8v3M11 14h.01'))),
			el('div', { style: 'font-size:14px;font-weight:600;color:#ececf1;' }, 'No source metadata on this element'),
			el('div', { style: 'font-size:12.5px;line-height:1.6;color:#9a9aa6;max-width:250px;' }, "Stylewright resolves components via Svelte's dev metadata. This node has none — it may be outside a component or built without dev mode."),
			el('code', { style: 'font-family:"IBM Plex Mono",monospace;font-size:11px;color:#9d8cf8;background:#101014;border:1px solid rgba(255,255,255,.07);padding:6px 10px;border-radius:7px;' }, 'vite --mode development'));
	}
	private buildNoStyle(): SvgEl {
		const m = this.state.meta;
		return el('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:34px 28px;text-align:center;' },
			el('div', { style: 'width:46px;height:46px;border-radius:12px;background:#1c1c22;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;color:#7e7e8c;font-family:"IBM Plex Mono",monospace;font-size:18px;' }, '{ }'),
			el('div', { style: 'font-size:14px;font-weight:600;color:#ececf1;white-space:nowrap;' }, 'No <style> block yet'),
			el('div', { style: 'font-size:12.5px;line-height:1.6;color:#9a9aa6;max-width:250px;' },
				el('span', { style: { fontFamily: '"IBM Plex Mono",monospace', color: C_SEL } }, m ? m.fileLabel : 'This component'),
				' has no styles. Add one in source and re-pick to edit.'));
	}
	private buildPanel(): SvgEl {
		const v = this.state.view;
		const cssPane = v === 'no-meta' ? this.buildNoMeta() : v === 'no-style' ? this.buildNoStyle() : this.buildEditBody();
		const inner = el('div', { className: 'sw-scroll', style: 'display:flex;flex-direction:column;height:100%;background:#16161b;border:1px solid rgba(255,255,255,.1);border-radius:13px;overflow:hidden;box-shadow:0 24px 70px -20px rgba(0,0,0,.7),0 0 0 1px rgba(0,0,0,.4);color:#ececf1;' },
			this.buildHeader(), this.buildBody(cssPane));
		return el('div', { style: this.panelStyle() }, this.buildResizeHandles(), inner);
	}

	// ---------- CSS + DOM split body ----------
	/** Arrange the CSS pane and the DOM-tree pane per dock: a column split (CSS top /
	 *  HTML bottom) when docked left/right, a row split (HTML left / CSS right) when
	 *  docked bottom, and a tabbed view when floating. */
	private buildBody(cssPane: SvgEl): SvgEl {
		// DOM pane off → CSS only, and crucially the tree isn't built at all (the
		// per-render DOM walk is the slow part). cssPane is already a flex:1 column.
		if (!this.state.showHtml) return cssPane;
		const dock = this.state.dock;
		const htmlPane = this.buildHtmlPane();
		if (dock === 'float') {
			const tab = this.state.floatTab;
			return el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;' },
				this.buildTabStrip(),
				el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;' }, tab === 'html' ? htmlPane : cssPane));
		}
		const sp = this.state.split;
		if (dock === 'bottom') {
			return el('div', { style: 'display:flex;flex-direction:row;flex:1;min-height:0;' },
				el('div', { style: { flex: `0 0 ${(sp.row * 100).toFixed(2)}%`, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, htmlPane),
				this.buildDivider('v'),
				el('div', { style: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, cssPane));
		}
		return el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;' },
			el('div', { style: { flex: `0 0 ${(sp.col * 100).toFixed(2)}%`, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, cssPane),
			this.buildDivider('h'),
			el('div', { style: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, htmlPane));
	}
	private buildTabStrip(): SvgEl {
		const tab = this.state.floatTab;
		const mk = (which: 'css' | 'html', label: string): SvgEl => el('button', {
			onClick: () => this.setState({ floatTab: which }),
			style: { flex: 1, border: 0, borderBottom: `2px solid ${tab === which ? '#8b7cf6' : 'transparent'}`, background: 'transparent', color: tab === which ? '#ececf1' : '#7e7e8c', cursor: 'pointer', padding: '8px 0', fontFamily: '"IBM Plex Sans",sans-serif', fontSize: 12, fontWeight: 600, letterSpacing: '.04em' }
		}, label);
		return el('div', { style: 'display:flex;background:#15151a;border-bottom:1px solid rgba(255,255,255,.06);flex:none;' }, mk('css', 'CSS'), mk('html', 'DOM'));
	}
	/** Draggable divider between the two panes. `h` = horizontal bar (column split),
	 *  `v` = vertical bar (row split). */
	private buildDivider(axis: 'h' | 'v'): SvgEl {
		const horizontal = axis === 'h';
		const grip = el('span', { style: { position: 'absolute', background: '#8b7cf6', borderRadius: 3, opacity: 0, transition: 'opacity .12s', ...(horizontal ? { left: '50%', marginLeft: -15, top: 3, height: 3, width: 30 } : { top: '50%', marginTop: -15, left: 3, width: 3, height: 30 }) } });
		return el('div', {
			onMouseDown: this.startSplitDrag(axis),
			onMouseEnter: (e: MouseEvent) => { const g = (e.currentTarget as HTMLElement).firstChild as HTMLElement | null; if (g) g.style.opacity = '1'; },
			onMouseLeave: (e: MouseEvent) => { const g = (e.currentTarget as HTMLElement).firstChild as HTMLElement | null; if (g) g.style.opacity = '0'; },
			style: { position: 'relative', flex: 'none', background: '#15151a', cursor: horizontal ? 'ns-resize' : 'ew-resize', ...(horizontal ? { height: 9, width: '100%', borderTop: '1px solid rgba(255,255,255,.06)', borderBottom: '1px solid rgba(255,255,255,.06)' } : { width: 9, height: '100%', borderLeft: '1px solid rgba(255,255,255,.06)', borderRight: '1px solid rgba(255,255,255,.06)' }) }
		}, grip);
	}
	private startSplitDrag(axis: 'h' | 'v') {
		return (e: MouseEvent): void => {
			e.preventDefault(); e.stopPropagation();
			const container = (e.currentTarget as HTMLElement).parentElement;
			if (!container) return;
			const rect = container.getBoundingClientRect();
			const mv = (ev: MouseEvent): void => {
				if (axis === 'h') this.setState({ split: { ...this.state.split, col: this.clampN((ev.clientY - rect.top) / (rect.height || 1), 0.2, 0.85) } });
				else this.setState({ split: { ...this.state.split, row: this.clampN((ev.clientX - rect.left) / (rect.width || 1), 0.2, 0.85) } });
			};
			const up = (): void => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
			document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
		};
	}

	// ---------- DOM tree pane ----------
	private buildHtmlPane(): SvgEl {
		return el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;background:#101014;' },
			el('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#15151a;border-bottom:1px solid rgba(255,255,255,.06);flex:none;' },
				ic(13, '0 0 24 24', { fill: 'none', stroke: C_FONT, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3')),
				el('span', { style: 'font-family:"IBM Plex Sans",sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;color:#7e7e8c;' }, 'DOM'),
				el('span', { style: 'flex:1;' }),
				el('span', { style: 'font-family:"IBM Plex Mono",monospace;font-size:10px;color:#5c5c66;white-space:nowrap;' }, 'hover → highlight · click → edit'),
				el('button', { className: 'sw-iconbtn', title: 'Rebuild tree from the live DOM', onClick: () => { this.domModelRev++; this.bumpTree(); }, style: 'display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;background:transparent;color:#7e7e8c;border-radius:5px;cursor:pointer;flex:none;' },
					ic(12, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M21 12a9 9 0 1 1-2.64-6.36'), pth('M21 3v6h-6')))),
			el('div', { className: 'sw-scroll', 'data-sw-tree': '1', style: 'flex:1;min-height:0;overflow:auto;padding:6px 2px 12px;' }, this.buildTree()));
	}
	private buildTree(): SvgEl {
		// Reuse the built node while the tree's content hasn't changed (hover + CSS
		// edits re-render but don't bump treeRev). render() detaches it on clear and
		// re-appends it, which is cheap; this skips the DOM walk + row construction.
		if (this.treeCache && this.treeCache.rev === this.state.treeRev) return this.treeCache.node;
		let body: Element | null = null;
		try { body = document.body; } catch { body = null; }
		if (!body) return el('div', { style: 'padding:14px;color:#7e7e8c;font-size:12px;font-family:"IBM Plex Mono",monospace;' }, 'No document body.');
		// Reuse the walked DOM model across expand/collapse (only rows re-render); rewalk
		// only when domModelRev bumped — pick / show / manual refresh (PERF-4).
		let model = this.domModelCache;
		if (!model || model.rev !== this.domModelRev) {
			const built = buildDomTree(body, this.shadow.host as Element);
			model = { rev: this.domModelRev, roots: built.roots, byEl: built.byEl };
			this.domModelCache = model;
		}
		const { roots, byEl } = model;
		const pickedNode = this.pickedEl ? byEl.get(this.pickedEl) : undefined;
		const autoOpen = pickedNode ? pathPrefixes(pickedNode.path) : new Set<string>();
		const out: SvgEl[] = [];
		for (const r of roots) this.renderTreeNode(r, 0, autoOpen, out);
		const node = el('div', { style: { fontFamily: '"IBM Plex Mono",monospace', fontSize: '11.5px', lineHeight: '1.7' } }, out);
		this.treeCache = { rev: this.state.treeRev, node };
		return node;
	}
	private renderTreeNode(node: DomNode, depth: number, autoOpen: Set<string>, out: SvgEl[]): void {
		const hasKids = node.children.length > 0;
		const open = this.isNodeOpen(node.path, depth, autoOpen);
		out.push(this.treeRow(node, depth, hasKids, open));
		if (hasKids && open) for (const c of node.children) this.renderTreeNode(c, depth + 1, autoOpen, out);
	}
	private isNodeOpen(path: string, depth: number, autoOpen: Set<string>): boolean {
		const t = this.state.htmlToggled;
		if (Object.prototype.hasOwnProperty.call(t, path)) return t[path];
		return autoOpen.has(path) || depth < TREE_OPEN_DEPTH;
	}
	/** Re-render with a freshly-built tree (invalidates the buildTree cache). `extra`
	 *  folds in whatever state change triggered the rebuild. */
	private bumpTree(extra: Partial<State> = {}): void {
		this.setState({ treeRev: this.state.treeRev + 1, ...extra });
	}
	private toggleNode(path: string, open: boolean): void {
		this.bumpTree({ htmlToggled: { ...this.state.htmlToggled, [path]: !open } });
	}
	private treeRow(node: DomNode, depth: number, hasKids: boolean, open: boolean): SvgEl {
		const selected = this.pickedEl === node.el;
		const indent = 8 + depth * 12;
		const caret = hasKids
			? el('button', {
				title: open ? 'Collapse' : 'Expand', onClick: (e: MouseEvent) => { e.stopPropagation(); this.toggleNode(node.path, open); },
				style: { flex: 'none', width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'transparent', color: '#6a6a78', cursor: 'pointer', padding: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }
			}, ic(9, '0 0 24 24', { fill: 'currentColor' }, pth('M9 6l6 6-6 6Z')))
			: el('span', { style: { flex: 'none', width: 14, height: 14, display: 'inline-block' } });
		const parts: (SvgEl | null)[] = [el('span', { style: { color: C_TAG } }, node.tag)];
		if (node.id) parts.push(el('span', { style: { color: C_ID } }, '#' + node.id));
		if (node.classes.length) parts.push(el('span', { style: { color: C_CLS } }, '.' + node.classes.join('.')));
		if (node.ownsFile && node.fileLabel) parts.push(el('span', { title: node.file || '', style: { marginLeft: 6, color: C_FONT, opacity: 0.7, fontSize: '9.5px', whiteSpace: 'nowrap' } }, node.fileLabel));
		return el('div', {
			onClick: () => { void this.pick(node.file, describe(node.el), node.el); },
			onMouseEnter: (e: MouseEvent) => { this.previewEl(node.el); (e.currentTarget as HTMLElement).style.background = selected ? 'rgba(139,124,246,.28)' : 'rgba(255,255,255,.05)'; },
			onMouseLeave: (e: MouseEvent) => { this.clearPreview(); (e.currentTarget as HTMLElement).style.background = selected ? 'rgba(139,124,246,.2)' : 'transparent'; },
			style: { display: 'flex', alignItems: 'center', gap: 4, padding: '1px 8px 1px ' + indent + 'px', whiteSpace: 'nowrap', cursor: 'pointer', borderRadius: 4, background: selected ? 'rgba(139,124,246,.2)' : 'transparent' }
		}, caret, ...parts);
	}
	private buildFab(): SvgEl {
		const v = this.state.view;
		const bg = v === 'pick' ? '#3a3550' : 'linear-gradient(135deg,#8b7cf6,#6d5efc)';
		const ring = v === 'pick' ? ',0 0 0 3px rgba(139,124,246,.4)' : '';
		const f = this.state.fab;
		const pos = (f.x == null || f.y == null)
			? 'bottom:18px;right:18px'
			: `left:${Math.max(6, Math.min(window.innerWidth - 54, f.x))}px;top:${Math.max(6, Math.min(window.innerHeight - 54, f.y))}px`;
		// While dragging, force grabbing (overrides the theme pointer); otherwise the
		// cursor stays pointer until the hover-dwell timer promotes it to grab.
		const cursor = this.fabDragged ? 'cursor:grabbing;' : '';
		return el('button', { className: 'sw-fab', title: 'Stylewright — pick an element (drag to move)',
			onMouseDown: (e: MouseEvent) => this.onFabDown(e),
			onMouseEnter: (e: MouseEvent) => { const btn = e.currentTarget as HTMLElement; clearTimeout(this.fabHoverTimer); this.fabHoverTimer = setTimeout(() => { btn.style.cursor = 'grab'; }, FAB_GRAB_DELAY); },
			onMouseLeave: (e: MouseEvent) => { clearTimeout(this.fabHoverTimer); (e.currentTarget as HTMLElement).style.cursor = ''; },
			style: `position:fixed;${pos};width:48px;height:48px;border-radius:50%;border:0;${cursor}display:flex;align-items:center;justify-content:center;z-index:45;transition:transform .12s ease;color:#fff;background:${bg};box-shadow:0 10px 30px -8px rgba(109,94,252,.7)${ring};` },
			ic(20, '0 0 24 24', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, pth('M12 20h9'), pth('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z')));
	}
	private buildHighlight(): SvgEl | null {
		const hl = this.state.hl; if (!hl || !hl.r) return null;
		const r = hl.r;
		return el('div', { style: `position:fixed;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;z-index:40;pointer-events:none;border:2px solid #8b7cf6;border-radius:6px;background:rgba(139,124,246,.1);box-shadow:0 0 0 1px rgba(139,124,246,.3),0 0 30px -4px rgba(139,124,246,.5);` },
			el('div', { style: 'position:absolute;top:-26px;left:-2px;background:#16161b;border:1px solid rgba(139,124,246,.5);border-radius:6px;padding:3px 8px;font-family:"IBM Plex Mono",monospace;font-size:11px;white-space:nowrap;box-shadow:0 8px 24px -8px rgba(0,0,0,.6);' },
				el('span', { style: 'color:#c4baff;font-weight:600;' }, hl.tag),
				el('span', { style: 'opacity:.5;' }, ' · '),
				el('span', { style: { color: C_SEL } }, hl.file ? hl.file : 'no metadata')));
	}
	private buildHint(): SvgEl {
		return el('div', { style: 'position:fixed;bottom:78px;left:50%;transform:translateX(-50%);background:#16161b;color:#d6d3e0;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 15px;font-size:13px;box-shadow:0 14px 40px -12px rgba(0,0,0,.6);display:flex;align-items:center;gap:9px;z-index:46;animation:sw-pop .18s ease;font-family:"IBM Plex Sans",system-ui,sans-serif;' },
			el('span', { style: 'width:7px;height:7px;border-radius:50%;background:#8b7cf6;animation:sw-pulse 1.3s infinite;' }),
			'Click any element to edit its component styles',
			el('span', { style: 'opacity:.45;' }, '·'),
			el('span', { style: 'font-family:"IBM Plex Mono",monospace;font-size:12px;opacity:.6;' }, 'Esc to cancel'));
	}
	private buildOverlay(): DocumentFragment {
		const frag = document.createDocumentFragment();
		const v = this.state.view;
		if (v === 'pick') { const hlEl = this.buildHighlight(); if (hlEl) frag.appendChild(hlEl); frag.appendChild(this.buildHint()); }
		if (v === 'pick' || v === 'closed') frag.appendChild(this.buildFab());
		else { frag.appendChild(this.buildPanel()); const hlEl = this.buildHighlight(); if (hlEl) frag.appendChild(hlEl); }
		return frag;
	}
}
