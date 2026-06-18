// Stylewright browser overlay (dev only). Injected by the plugin as a single
// IIFE. Click the FAB, pick an element, and its component's <style> opens in a
// dark IDE-style editor — scrub numbers, an inline color picker, keyword/font
// menus, add/remove declarations. Edits serialize back to the .svelte <style>.
//
// Element -> source file resolution uses Svelte's dev metadata (`__svelte_meta`).
// This module owns booting + the real element picker; the Panel owns the UI.

import type { SwRulesResponse, SwStyleSaveResponse } from '../shared/protocol.js';
import { Panel, type PanelHost, type PickMeta } from './panel.js';
import { ensureFonts, SHADOW_CSS } from './theme.js';

const PREFIX = '/__stylewright';

/** Nearest source file above an element, from Svelte's dev metadata. */
function resolveFile(node: Element | null): string | null {
	let cur: (Element & { __svelte_meta?: { loc?: { file?: string } } }) | null = node;
	while (cur && cur !== document.documentElement) {
		const file = cur.__svelte_meta?.loc?.file;
		if (file) return file;
		cur = cur.parentElement;
	}
	return null;
}

function shortPath(file: string): string {
	return file.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

/** "<button class=\"btn primary\">" — the element's opening tag, for display. */
function tagLabel(node: Element): string {
	const tag = node.tagName.toLowerCase();
	const cls = (node.getAttribute('class') || '').trim();
	return '<' + tag + (cls ? ` class="${cls}"` : '') + '>';
}

function describe(node: Element): PickMeta {
	const r = node.getBoundingClientRect();
	const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
	return {
		fileLabel: '',
		selectorLabel: cls.length ? '.' + cls[0] : node.tagName.toLowerCase(),
		dims: Math.round(r.width) + ' × ' + Math.round(r.height),
		tag: tagLabel(node)
	};
}

const serverHost: PanelHost = {
	async loadRules(file) {
		const res = await fetch(`${PREFIX}/rules?file=${encodeURIComponent(file)}`);
		const data = (await res.json()) as SwRulesResponse;
		return { hasStyle: data.hasStyle, rules: data.rules, error: data.error };
	},
	async saveCss(file, css) {
		const res = await fetch(`${PREFIX}/style`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ file, css })
		});
		return (await res.json()) as SwStyleSaveResponse;
	}
};

function boot(): void {
	ensureFonts();

	// Shadow host so the overlay UI is fully isolated from (and from) the app.
	const hostEl = document.createElement('div');
	hostEl.id = '__stylewright_host';
	hostEl.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
	const shadow = hostEl.attachShadow({ mode: 'open' });
	const style = document.createElement('style');
	style.textContent = SHADOW_CSS;
	shadow.appendChild(style);
	document.documentElement.appendChild(hostEl);

	const panel = new Panel(shadow, serverHost);

	/** Topmost app element under the pointer; null when over our own overlay UI. */
	function elementUnder(e: MouseEvent): Element | null {
		const stack = document.elementsFromPoint(e.clientX, e.clientY);
		if (!stack.length) return null;
		if (stack[0] === hostEl || hostEl.contains(stack[0])) return null;
		for (const node of stack) {
			if (node === hostEl || hostEl.contains(node)) continue;
			return node;
		}
		return null;
	}

	document.addEventListener('mousemove', (e) => {
		if (!panel.isPicking()) return;
		const node = elementUnder(e);
		if (!node) return;
		const file = resolveFile(node);
		panel.hover(node.getBoundingClientRect(), tagLabel(node), file ? shortPath(file) : null);
	}, true);

	document.addEventListener('click', (e) => {
		if (!panel.isPicking()) return;
		const node = elementUnder(e);
		if (!node) return;
		e.preventDefault();
		e.stopPropagation();
		const file = resolveFile(node);
		const meta = describe(node);
		if (file) meta.fileLabel = shortPath(file);
		void panel.pick(file, meta);
	}, true);
}

// Boot once. Guarded so an HMR re-inject doesn't stack a second overlay.
if (!(window as { __stylewright__?: boolean }).__stylewright__) {
	(window as { __stylewright__?: boolean }).__stylewright__ = true;
	boot();
}
