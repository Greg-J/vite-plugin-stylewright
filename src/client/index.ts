// Stylewright browser overlay (dev only). Injected by the plugin as a single
// IIFE. Lets you pick an element, see its component's <style> rules, tweak a
// value with live preview, and save it back to the .svelte source.
//
// Element -> source file resolution uses Svelte's dev metadata (`__svelte_meta`),
// the same source-location data the Svelte inspector relies on.

import type { SwRule, SwRulesResponse, SwEditResponse } from '../shared/protocol.js';

const PREFIX = '/__stylewright';

interface SvelteLoc {
	file: string;
	line?: number;
	column?: number;
}

/** Walk up the DOM to the nearest element carrying Svelte source metadata. */
function resolveLoc(el: Element | null): SvelteLoc | null {
	let node: any = el;
	while (node && node !== document.documentElement) {
		const loc = node.__svelte_meta?.loc;
		if (loc?.file) return { file: loc.file, line: loc.line, column: loc.column };
		node = node.parentElement;
	}
	return null;
}

/** The Svelte scope class (`svelte-xxxx`) on or above an element, for preview scoping. */
function scopeClass(el: Element | null): string | null {
	let node: Element | null = el;
	while (node && node !== document.documentElement) {
		for (const c of Array.from(node.classList)) {
			if (/^svelte-[a-z0-9]+$/i.test(c)) return c;
		}
		node = node.parentElement;
	}
	return null;
}

async function fetchRules(file: string): Promise<SwRulesResponse> {
	const res = await fetch(`${PREFIX}/rules?file=${encodeURIComponent(file)}`);
	return res.json();
}

async function saveEdit(file: string, selector: string, prop: string, value: string): Promise<SwEditResponse> {
	const res = await fetch(`${PREFIX}/edit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ file, selector, prop, value })
	});
	return res.json();
}

// --- live preview (an override <style> in the host head) ---------------------
const previews = new Map<string, string>();
let previewEl: HTMLStyleElement | null = null;
function applyPreview(selector: string, prop: string, value: string, scope: string | null): void {
	const sel = scope ? `${selector}.${scope}` : selector;
	previews.set(`${sel}|${prop}`, `${sel} { ${prop}: ${value} !important; }`);
	if (!previewEl) {
		previewEl = document.createElement('style');
		previewEl.id = '__stylewright_preview';
		document.head.appendChild(previewEl);
	}
	previewEl.textContent = [...previews.values()].join('\n');
}

function boot(): void {
	// Shadow host so our UI is fully isolated from the app's styles.
	const host = document.createElement('div');
	host.id = '__stylewright_host';
	host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
	const root = host.attachShadow({ mode: 'open' });
	document.documentElement.appendChild(host);
	root.innerHTML = TEMPLATE;

	const fab = root.querySelector('.fab') as HTMLButtonElement;
	const panel = root.querySelector('.panel') as HTMLElement;
	const titleEl = root.querySelector('.file') as HTMLElement;
	const rulesEl = root.querySelector('.rules') as HTMLElement;
	const statusEl = root.querySelector('.status') as HTMLElement;
	const closeBtn = root.querySelector('.close') as HTMLButtonElement;

	// Highlight box in the host page (not shadow) so it overlays app elements.
	const hi = document.createElement('div');
	hi.style.cssText =
		'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ff3e00;background:rgba(255,62,0,.08);border-radius:2px;display:none;transition:all .05s;';
	document.documentElement.appendChild(hi);

	let picking = false;

	function setStatus(msg: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
		statusEl.textContent = msg;
		statusEl.dataset.kind = kind;
	}

	function setPicking(on: boolean): void {
		picking = on;
		fab.classList.toggle('on', on);
		document.body.style.cursor = on ? 'crosshair' : '';
		if (!on) hi.style.display = 'none';
	}

	function onMove(e: MouseEvent): void {
		if (!picking) return;
		const el = elementUnder(e);
		if (!el) return;
		const r = el.getBoundingClientRect();
		hi.style.display = 'block';
		hi.style.top = `${r.top}px`;
		hi.style.left = `${r.left}px`;
		hi.style.width = `${r.width}px`;
		hi.style.height = `${r.height}px`;
	}

	async function onClick(e: MouseEvent): Promise<void> {
		if (!picking) return;
		const el = elementUnder(e);
		if (!el) return;
		e.preventDefault();
		e.stopPropagation();
		setPicking(false);
		await loadFor(el);
	}

	/** Topmost app element under the pointer, ignoring our own overlay nodes. */
	function elementUnder(e: MouseEvent): Element | null {
		const stack = document.elementsFromPoint(e.clientX, e.clientY);
		for (const el of stack) {
			if (el === host || el === hi || host.contains(el)) continue;
			return el;
		}
		return null;
	}

	async function loadFor(el: Element): Promise<void> {
		panel.classList.add('open');
		rulesEl.innerHTML = '';
		const loc = resolveLoc(el);
		if (!loc) {
			titleEl.textContent = '(unknown component)';
			setStatus('No Svelte source metadata on this element. Make sure dev mode is on.', 'err');
			return;
		}
		titleEl.textContent = shortPath(loc.file);
		setStatus('Loading rules…');
		const scope = scopeClass(el);
		try {
			const data = await fetchRules(loc.file);
			if (data.error) return setStatus(data.error, 'err');
			if (!data.hasStyle || data.rules.length === 0) {
				return setStatus('This component has no <style> rules.', 'info');
			}
			setStatus(`${data.rules.length} rule${data.rules.length === 1 ? '' : 's'}`, 'info');
			renderRules(loc.file, data.rules, scope);
		} catch (err) {
			setStatus(`Failed to load: ${String(err)}`, 'err');
		}
	}

	function renderRules(file: string, rules: SwRule[], scope: string | null): void {
		rulesEl.innerHTML = '';
		for (const rule of rules) {
			const block = document.createElement('div');
			block.className = 'rule';
			const sel = document.createElement('div');
			sel.className = 'sel';
			sel.textContent = rule.selector;
			block.appendChild(sel);
			for (const d of rule.decls) {
				block.appendChild(declRow(file, rule.selector, d.prop, d.value, scope));
			}
			rulesEl.appendChild(block);
		}
	}

	function declRow(file: string, selector: string, prop: string, value: string, scope: string | null): HTMLElement {
		const row = document.createElement('div');
		row.className = 'decl';
		const k = document.createElement('span');
		k.className = 'prop';
		k.textContent = prop;
		const input = document.createElement('input');
		input.className = 'val';
		input.value = value;
		input.spellcheck = false;

		input.addEventListener('input', () => applyPreview(selector, prop, input.value, scope));
		const commit = async () => {
			const v = input.value.trim();
			if (v === value) return;
			setStatus('Saving…');
			try {
				const r = await saveEdit(file, selector, prop, v);
				if (!r.ok) setStatus(r.error || 'Save failed', 'err');
				else if (!r.matched) setStatus(`No "${selector}" rule found in source`, 'err');
				else if (!r.changed) setStatus('No change', 'info');
				else setStatus(`Saved ${prop} → ${v}`, 'ok');
			} catch (err) {
				setStatus(`Save failed: ${String(err)}`, 'err');
			}
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});

		row.appendChild(k);
		row.appendChild(input);
		return row;
	}

	// Wiring
	fab.addEventListener('click', () => setPicking(!picking));
	closeBtn.addEventListener('click', () => panel.classList.remove('open'));
	document.addEventListener('mousemove', onMove, true);
	document.addEventListener('click', onClick, true);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			setPicking(false);
			panel.classList.remove('open');
		}
	});
}

function shortPath(file: string): string {
	const parts = file.replace(/\\/g, '/').split('/');
	return parts.slice(-2).join('/');
}

const TEMPLATE = /* html */ `
<style>
	:host { all: initial; }
	* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
	.fab {
		position: fixed; bottom: 16px; right: 16px; width: 44px; height: 44px;
		border-radius: 50%; border: 0; cursor: pointer; color: #fff; font-size: 18px;
		background: #ff3e00; box-shadow: 0 6px 20px -6px rgba(0,0,0,.5);
		display: flex; align-items: center; justify-content: center;
	}
	.fab.on { background: #0c2a30; outline: 3px solid rgba(255,62,0,.4); }
	.panel {
		position: fixed; bottom: 72px; right: 16px; width: 320px; max-height: 60vh;
		background: #fff; color: #15202b; border: 1px solid #e3e3e3; border-radius: 10px;
		box-shadow: 0 18px 50px -16px rgba(0,0,0,.45); display: none; flex-direction: column;
		overflow: hidden;
	}
	.panel.open { display: flex; }
	.head {
		display: flex; align-items: center; gap: 8px; padding: 10px 12px;
		background: #0c2a30; color: #fff;
	}
	.brand { font-weight: 700; font-size: 12px; letter-spacing: .04em; }
	.file { flex: 1; font-size: 11px; font-family: ui-monospace, monospace; opacity: .85;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.close { background: rgba(255,255,255,.12); border: 0; color: #fff; width: 22px; height: 22px;
		border-radius: 5px; cursor: pointer; font-size: 13px; }
	.status { padding: 6px 12px; font-size: 11px; border-bottom: 1px solid #eee; color: #5b6b73; }
	.status[data-kind="ok"] { color: #1a7f4b; }
	.status[data-kind="err"] { color: #c0392b; }
	.rules { overflow-y: auto; padding: 6px 0; }
	.rule { padding: 6px 12px; border-bottom: 1px solid #f2f2f2; }
	.sel { font-family: ui-monospace, monospace; font-size: 12px; color: #ff3e00; margin-bottom: 4px; }
	.decl { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
	.prop { font-family: ui-monospace, monospace; font-size: 11.5px; color: #5b6b73; width: 42%;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.val { flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 11.5px;
		padding: 3px 6px; border: 1px solid #ddd; border-radius: 4px; }
	.val:focus { outline: none; border-color: #ff3e00; box-shadow: 0 0 0 2px rgba(255,62,0,.15); }
</style>
<button class="fab" title="Stylewright — pick an element to edit its CSS">✎</button>
<div class="panel">
	<div class="head">
		<span class="brand">Stylewright</span>
		<span class="file"></span>
		<button class="close" title="Close">✕</button>
	</div>
	<div class="status">Click the ✎, then click an element.</div>
	<div class="rules"></div>
</div>
`;

// Boot once — AFTER all module constants (TEMPLATE, previews, …) are initialized.
// Guarded so an HMR re-inject doesn't stack a second overlay.
if (!(window as any).__stylewright__) {
	(window as any).__stylewright__ = true;
	boot();
}
