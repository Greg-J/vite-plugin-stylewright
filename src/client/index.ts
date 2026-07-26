// Stylewright browser overlay (dev only). Injected by the plugin as a single
// IIFE. Click the FAB, pick an element, and its component's <style> opens in a
// dark IDE-style editor — scrub numbers, an inline color picker, keyword/font
// menus, add/remove declarations. Edits serialize back to the .svelte <style>.
//
// Element -> source file resolution uses Svelte's dev metadata (`__svelte_meta`).
// This module owns booting + the real element picker; the Panel owns the UI.

import type { SwRule, SwRulesResponse, SwStyleSaveResponse, SwApplyResponse, SwAiState, SwAiSendResponse } from '../shared/protocol.js';
import { Panel, type PanelHost } from './panel.js';
import { describe, resolveFile, shortPath, tagLabel } from './inspect.js';
import { ensureFonts, SHADOW_CSS } from './theme.js';

const PREFIX = '/__stylewright';

/**
 * Every mutating call carries `x-stylewright: 1`. A cross-site <form> or a
 * no-preflight request cannot set a custom header, so this is what stops another
 * page the developer has open from POSTing edits into their source tree. The
 * server refuses writes without it — see src/server/guard.ts.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${PREFIX}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-stylewright': '1' },
		body: JSON.stringify(body)
	});
	return (await res.json()) as T;
}

const serverHost: PanelHost = {
	async loadRules(file) {
		const res = await fetch(`${PREFIX}/rules?file=${encodeURIComponent(file)}`);
		const data = (await res.json()) as SwRulesResponse;
		return { hasStyle: data.hasStyle, rules: data.rules, error: data.error };
	},
	async applyRules(file: string, rules: SwRule[], opts?: { removeIds?: number[]; mediaRenames?: { id: number; params: string }[] }) {
		return post<SwApplyResponse>('/apply', { file, rules, removeIds: opts?.removeIds, mediaRenames: opts?.mediaRenames });
	},
	async saveCss(file, css) {
		return post<SwStyleSaveResponse>('/style', { file, css });
	},

	// The AI path is optional. boot() strips this off when the plugin was
	// configured with `ai: false`, so the panel hides the tab entirely rather
	// than offering one whose every route 404s.
	ai: {
		state: () => fetch(`${PREFIX}/ai/state`).then((r) => r.json() as Promise<SwAiState>),
		link: (sessionId: string) => post<SwAiState>('/ai/link', { sessionId }),
		unlink: () => post<SwAiState>('/ai/unlink', {}),
		refresh: () => post<SwAiState>('/ai/refresh', {}),
		clear: () => post<SwAiState>('/ai/clear', {}),
		cancel: (requestId: string) => post<SwAiState>('/ai/cancel', { requestId }),
		send: (req: unknown) => post<SwAiSendResponse>('/ai/send', req),
		/** Live status. EventSource reconnects on its own, which is what we want
		 *  when the dev server restarts under HMR. */
		subscribe(onState: (s: SwAiState) => void) {
			let es: EventSource | null = null;
			try {
				es = new EventSource(`${PREFIX}/ai/events`);
				es.onmessage = (e) => {
					try { onState(JSON.parse(e.data) as SwAiState); } catch { /* ignore a partial frame */ }
				};
			} catch { /* no EventSource — the panel still works via ai.state() */ }
			return () => { try { es?.close(); } catch { /* ignore */ } };
		}
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

	// `stylewright({ ai: false })` stamps this flag; without it the Ask AI tab
	// would render against routes that are not mounted.
	const aiOff = !!(window as { __stylewright_no_ai__?: boolean }).__stylewright_no_ai__;
	const panel = new Panel(shadow, aiOff ? { ...serverHost, ai: undefined } : serverHost);

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
		if (!panel.isPicking()) { panel.clearHover(); return; }
		const node = elementUnder(e);
		// null means the pointer is over our own overlay. Returning early used to
		// leave the last page element highlighted, so the panel appeared to still be
		// aiming at something while you were reading the panel itself.
		if (!node) { panel.clearHover(); return; }
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
