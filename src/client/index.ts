// Stylewright browser overlay (dev only). Injected by the plugin as a single
// IIFE. Click the FAB, pick an element, and its component's <style> opens in a
// dark IDE-style editor — scrub numbers, an inline color picker, keyword/font
// menus, add/remove declarations. Edits serialize back to the .svelte <style>.
//
// Element -> source file resolution uses Svelte's dev metadata (`__svelte_meta`).
// This module owns booting + the real element picker; the Panel owns the UI.

import type { SwRule, SwRulesResponse, SwStyleSaveResponse, SwApplyResponse } from '../shared/protocol.js';
import { Panel, type PanelHost } from './panel.js';
import { describe, resolveFile, shortPath, tagLabel } from './inspect.js';
import { ensureFonts, SHADOW_CSS } from './theme.js';

const PREFIX = '/__stylewright';

const serverHost: PanelHost = {
	async loadRules(file) {
		const res = await fetch(`${PREFIX}/rules?file=${encodeURIComponent(file)}`);
		const data = (await res.json()) as SwRulesResponse;
		return { hasStyle: data.hasStyle, rules: data.rules, error: data.error };
	},
	async applyRules(file: string, rules: SwRule[], opts?: { removeIds?: number[]; mediaRenames?: { id: number; params: string }[] }) {
		const res = await fetch(`${PREFIX}/apply`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ file, rules, removeIds: opts?.removeIds, mediaRenames: opts?.mediaRenames })
		});
		return (await res.json()) as SwApplyResponse;
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
		const meta = describe(node); // fills fileLabel from the resolved component
		void panel.pick(file, meta, node);
	}, true);
}

// Boot once. Guarded so an HMR re-inject doesn't stack a second overlay.
if (!(window as { __stylewright__?: boolean }).__stylewright__) {
	(window as { __stylewright__?: boolean }).__stylewright__ = true;
	boot();
}
