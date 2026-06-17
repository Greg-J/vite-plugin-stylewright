// Stylewright browser overlay (dev only). Injected by the plugin as a single
// IIFE. Pick an element and its component's <style> opens in a CodeMirror editor
// with inline color swatches and wheel-scrub on numbers; edits debounce-save back
// to the .svelte source.
//
// Element -> source file resolution uses Svelte's dev metadata (`__svelte_meta`).

import type { SwStyleResponse, SwStyleSaveResponse } from '../shared/protocol.js';
import { createEditor, type EditorHandle } from './editor.js';

const PREFIX = '/__stylewright';

/** Nearest source file above an element, from Svelte's dev metadata. */
function resolveFile(el: Element | null): string | null {
	let node: any = el;
	while (node && node !== document.documentElement) {
		const file = node.__svelte_meta?.loc?.file;
		if (file) return file as string;
		node = node.parentElement;
	}
	return null;
}

function shortPath(file: string): string {
	return file.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function boot(): void {
	// Shadow host so the overlay UI is fully isolated from (and from) the app.
	const host = document.createElement('div');
	host.id = '__stylewright_host';
	host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
	const root = host.attachShadow({ mode: 'open' });
	document.documentElement.appendChild(host);
	root.innerHTML = TEMPLATE;

	const fab = root.querySelector('.fab') as HTMLButtonElement;
	const panel = root.querySelector('.panel') as HTMLElement;
	const titleEl = root.querySelector('.file') as HTMLElement;
	const editorEl = root.querySelector('.editor') as HTMLElement;
	const statusEl = root.querySelector('.status') as HTMLElement;
	const closeBtn = root.querySelector('.close') as HTMLButtonElement;

	const hi = document.createElement('div');
	hi.style.cssText =
		'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ff3e00;background:rgba(255,62,0,.08);border-radius:2px;display:none;';
	document.documentElement.appendChild(hi);

	let picking = false;
	let editor: EditorHandle | null = null;
	let currentFile = '';

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

	/** Topmost app element under the pointer, ignoring our own overlay nodes. */
	function elementUnder(e: MouseEvent): Element | null {
		for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
			if (el === host || el === hi || host.contains(el)) continue;
			return el;
		}
		return null;
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

	async function loadFor(el: Element): Promise<void> {
		panel.classList.add('open');
		editor?.destroy();
		editor = null;
		editorEl.innerHTML = '';

		const file = resolveFile(el);
		if (!file) {
			titleEl.textContent = '(unknown component)';
			setStatus('No Svelte source metadata on this element. Is dev mode on?', 'err');
			return;
		}
		titleEl.textContent = shortPath(file);
		currentFile = file;
		setStatus('Loading…');
		try {
			const res = await fetch(`${PREFIX}/style?file=${encodeURIComponent(file)}`);
			const data = (await res.json()) as SwStyleResponse;
			if (data.error) return setStatus(data.error, 'err');
			if (!data.hasStyle) return setStatus('This component has no <style> block.', 'info');
			setStatus('Scroll a number to scrub it · click a swatch to pick a color', 'info');
			editor = createEditor(editorEl, root, data.css, (css) => void saveStyle(css));
		} catch (err) {
			setStatus(`Failed to load: ${String(err)}`, 'err');
		}
	}

	async function saveStyle(css: string): Promise<void> {
		setStatus('Saving…');
		try {
			const res = await fetch(`${PREFIX}/style`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ file: currentFile, css })
			});
			const d = (await res.json()) as SwStyleSaveResponse;
			if (!d.ok) setStatus(d.error || 'Save failed', 'err');
			else if (d.invalid) setStatus('Incomplete CSS — not saved yet', 'info');
			else if (d.changed) setStatus('Saved ✓', 'ok');
			else setStatus('No change', 'info');
		} catch (err) {
			setStatus(`Save failed: ${String(err)}`, 'err');
		}
	}

	fab.addEventListener('click', () => setPicking(!picking));
	closeBtn.addEventListener('click', () => {
		editor?.destroy();
		editor = null;
		panel.classList.remove('open');
	});
	document.addEventListener('mousemove', onMove, true);
	document.addEventListener('click', onClick, true);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') setPicking(false);
	});
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
		position: fixed; bottom: 72px; right: 16px; width: 440px; max-width: calc(100vw - 32px);
		background: #fff; color: #15202b; border: 1px solid #e3e3e3; border-radius: 10px;
		box-shadow: 0 18px 50px -16px rgba(0,0,0,.45); display: none; flex-direction: column;
		overflow: hidden;
	}
	.panel.open { display: flex; }
	.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #0c2a30; color: #fff; }
	.brand { font-weight: 700; font-size: 12px; letter-spacing: .04em; }
	.file { flex: 1; font-size: 11px; font-family: ui-monospace, monospace; opacity: .85;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.close { background: rgba(255,255,255,.12); border: 0; color: #fff; width: 22px; height: 22px;
		border-radius: 5px; cursor: pointer; font-size: 13px; }
	.status { padding: 6px 12px; font-size: 11px; border-bottom: 1px solid #eee; color: #5b6b73; }
	.status[data-kind="ok"] { color: #1a7f4b; }
	.status[data-kind="err"] { color: #c0392b; }
	.editor { overflow: hidden; }
</style>
<button class="fab" title="Stylewright — pick an element to edit its CSS">✎</button>
<div class="panel">
	<div class="head">
		<span class="brand">Stylewright</span>
		<span class="file"></span>
		<button class="close" title="Close">✕</button>
	</div>
	<div class="status">Click the ✎, then click an element.</div>
	<div class="editor"></div>
</div>
`;

// Boot once — AFTER all module constants (TEMPLATE) are initialized. Guarded so an
// HMR re-inject doesn't stack a second overlay.
if (!(window as any).__stylewright__) {
	(window as any).__stylewright__ = true;
	boot();
}
