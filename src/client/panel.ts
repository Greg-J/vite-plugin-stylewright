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
import { fromServerRules, serializeRules, cloneRules, type Rule } from './rules.js';
import { History, type HistState } from './history.js';
import type { SwRule, SwStyleSaveResponse } from '../shared/protocol.js';

/** Server glue the overlay needs — provided by the boot module. */
export interface PanelHost {
	loadRules(file: string): Promise<{ hasStyle: boolean; rules: SwRule[]; error?: string }>;
	saveCss(file: string, css: string): Promise<SwStyleSaveResponse>;
}

type Dock = 'left' | 'right' | 'bottom' | 'float';
type View = 'closed' | 'pick' | 'editing' | 'no-meta' | 'no-style';
type StatusKind = 'idle' | 'saving' | 'ok' | 'err';
interface Status { kind: StatusKind; text: string; }
interface Focus { ri: number; di: number; field: 'p' | 'v'; tok?: number | string | null; }
interface ColorSel { ri: number; di: number; tok: number; h: number; s: number; v: number; a: number; fmt: ColorFmt; hexText?: string; }
interface Menu { ri: number; di: number; }
interface Highlight { r: DOMRect | null; tag: string; file: string | null; }
/** Display strings for the picked element, computed by the boot module. */
export interface PickMeta { fileLabel: string; selectorLabel: string; dims: string; tag: string; }
interface Size { side: number; bottom: number; floatW: number; floatH: number; }
interface FloatPos { x: number | null; y: number | null; }

interface State {
	dock: Dock;
	view: View;
	float: FloatPos;
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
}

type SvgEl = HTMLElement & SVGElement;
const ic = (size: number, vb: string, opts: ElProps, ...kids: SvgEl[]): SvgEl =>
	el('svg', { width: size, height: size, viewBox: vb, ...opts }, ...kids);
const pth = (d: string, opts?: ElProps): SvgEl => el('path', { d, ...(opts || {}) });

// syntax colors
const C_SEL = '#e8c98a', C_PROP = '#82aaff', C_PUNCT = '#5c5c66';
const C_NUM = '#f0b86c', C_KW = '#c792ea', C_COLOR = '#dcdce4', C_TEXT = '#c9c9d4', C_FONT = '#7fd1c4';

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

	// one global undo/redo timeline across every file edited this session
	private history = new History<PickMeta | null>();

	private wantFocus: string | null = null;
	private programmaticFocus = false; // true while WE focus an input — onFocus skips its side-effects
	private rebuilding = false; // true during render teardown — inputs' onBlur ignore the synthetic blur
	private colorWasSeeded = false; // picker opened on an empty value and not yet touched — revert on close
	private renderQueued = false;
	// animate-once: popovers shown in the previous render (don't replay their entry
	// animation while they stay open — that's what made the color picker flicker).
	private shownPops = new Set<string>();
	private nextPops = new Set<string>();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private keyHandler: (e: KeyboardEvent) => void;
	private downHandler: (e: MouseEvent) => void;
	private reanchorHandler: () => void;

	constructor(shadow: ShadowRoot, host: PanelHost) {
		this.shadow = shadow;
		this.host = host;
		this.rootEl = document.createElement('div');
		this.shadow.appendChild(this.rootEl);
		this.state = {
			dock: 'right',
			view: 'closed',
			float: { x: null, y: null },
			size: { side: 392, bottom: 300, floatW: 418, floatH: 540 },
			colorHistory: [],
			focus: null, color: null, menu: null, acIndex: 0,
			status: { kind: 'idle', text: 'Pick an element to edit its styles' },
			file: null, meta: null, rules: [], hl: null
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
		window.addEventListener('keydown', this.keyHandler);
		document.addEventListener('mousedown', this.downHandler);
		window.addEventListener('resize', this.reanchorHandler);
		this.rootEl.addEventListener('scroll', this.reanchorHandler, true); // capture: scroll doesn't bubble
		this.render();
	}

	destroy(): void {
		window.removeEventListener('keydown', this.keyHandler);
		document.removeEventListener('mousedown', this.downHandler);
		window.removeEventListener('resize', this.reanchorHandler);
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
		const caret = this.captureCaret(); // the rebuild destroys the focused input — keep its caret
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
		this.setState({ hl: { r, tag, file } });
	}
	private onFab(): void {
		const v = this.state.view;
		if (v === 'pick') this.setState({ view: this.state.file ? 'editing' : 'closed', hl: null });
		else this.setState({ view: 'pick', hl: null });
	}
	async pick(file: string | null, meta: PickMeta | null): Promise<void> {
		if (!file) { this.setState({ view: 'no-meta', hl: null, file: null, meta, rules: [] }); return; }
		// Don't touch file/rules until the load resolves — set them atomically so
		// the history records one clean baseline (not an old-rules/new-file blip).
		this.setState({ view: 'editing', hl: null, status: { kind: 'saving', text: 'Loading ' + (meta ? meta.fileLabel : file) + ' …' } });
		try {
			const resp = await this.host.loadRules(file);
			if (resp.error) { this.setState({ status: { kind: 'err', text: resp.error } }); return; }
			if (!resp.hasStyle) { this.setState({ view: 'no-style', file, meta, rules: [] }); return; }
			const rules = fromServerRules(resp.rules);
			this.setState({ file, meta, rules, status: { kind: 'idle', text: 'Ready · edits write to source on commit' } });
		} catch (err) {
			this.setState({ status: { kind: 'err', text: 'Failed to load: ' + String(err) } });
		}
	}

	// ---------- global undo / redo (one timeline across every file) ----------
	private applyHistState(s: HistState<PickMeta | null>, label: string): void {
		// The restored state may belong to a different file — switch the view to it
		// and write it back to that file's source.
		this.setState({ file: s.file, meta: s.meta, rules: s.rules, view: s.file ? 'editing' : this.state.view, color: null, menu: null, focus: null, status: { kind: 'idle', text: label } });
		this.save();
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
		const css = serializeRules(rules);
		try {
			const d = await this.host.saveCss(file, css);
			if (!d.ok) this.setState({ status: { kind: 'err', text: d.error || 'Save failed' } });
			else if (d.invalid) this.setState({ status: { kind: 'idle', text: 'Incomplete CSS — not saved yet' } });
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
			style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', whiteSpace: 'pre', padding: '1px 4px 1px 4ch', borderRadius: 4, position: 'relative' },
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
	private buildEditor(): SvgEl {
		const rs = this.curRules();
		const out: SvgEl[] = [];
		rs.forEach((rule, ri) => {
			out.push(el('div', { style: { whiteSpace: 'pre', padding: '1px 0' } }, el('span', { style: { color: C_SEL } }, rule.sel), el('span', { style: { color: C_PUNCT } }, ' {')));
			rule.decls.forEach((d, di) => out.push(this.declLine(d, ri, di)));
			out.push(this.addLine(ri));
			out.push(el('div', { style: { whiteSpace: 'pre', padding: '1px 0' } }, el('span', { style: { color: C_PUNCT } }, '}')));
			if (ri < rs.length - 1) out.push(el('div', { style: { height: 12 } }));
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
		const body = v === 'no-meta' ? this.buildNoMeta() : v === 'no-style' ? this.buildNoStyle() : this.buildEditBody();
		const inner = el('div', { className: 'sw-scroll', style: 'display:flex;flex-direction:column;height:100%;background:#16161b;border:1px solid rgba(255,255,255,.1);border-radius:13px;overflow:hidden;box-shadow:0 24px 70px -20px rgba(0,0,0,.7),0 0 0 1px rgba(0,0,0,.4);color:#ececf1;' },
			this.buildHeader(), body);
		return el('div', { style: this.panelStyle() }, this.buildResizeHandles(), inner);
	}
	private buildFab(): SvgEl {
		const v = this.state.view;
		const bg = v === 'pick' ? '#3a3550' : 'linear-gradient(135deg,#8b7cf6,#6d5efc)';
		const ring = v === 'pick' ? ',0 0 0 3px rgba(139,124,246,.4)' : '';
		return el('button', { className: 'sw-fab', title: 'Stylewright — pick an element', onClick: () => this.onFab(), style: `position:fixed;bottom:18px;right:18px;width:48px;height:48px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:45;transition:transform .12s ease;color:#fff;background:${bg};box-shadow:0 10px 30px -8px rgba(109,94,252,.7)${ring};` },
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
		else frag.appendChild(this.buildPanel());
		return frag;
	}
}
