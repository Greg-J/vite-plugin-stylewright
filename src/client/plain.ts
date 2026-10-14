// Plain-HTML mode, page side. The proxy serves every configured CSS source; these
// helpers decide which of them this page actually uses, and show a saved edit on
// the page when there is no HMR to do it.

import type { SwSource } from '../shared/protocol.js';

/** True when the proxy injected the overlay (see src/proxy/proxy.ts). */
export function isPlainMode(): boolean {
	return !!(window as { __stylewright_plain__?: boolean }).__stylewright_plain__;
}

/** The page's own <style> elements. The overlay's live in its shadow root, so a
 *  document query never returns them. */
function pageStyles(doc: Document): HTMLStyleElement[] {
	return Array.from(doc.querySelectorAll('style'));
}

/**
 * Keys of the sources this page includes. A template literal emitted into a
 * <style> appears there verbatim, so its text is the test; a .css file counts
 * when a stylesheet <link> names it. A source edited on disk since the page
 * loaded no longer matches, which is right — its rules on screen are stale.
 */
export function sourcesOnPage(sources: SwSource[], doc: Document = document): Set<string> {
	const styles = pageStyles(doc).map((s) => s.textContent || '');
	const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).map((l) => {
		try { return new URL(l.href, doc.baseURI).pathname; } catch { return ''; }
	});
	const on = new Set<string>();
	for (const s of sources) {
		if (s.error || !s.css) continue;
		if (styles.some((t) => t.includes(s.css))) { on.add(s.key); continue; }
		if (/\.css$/i.test(s.file)) {
			const base = '/' + s.file.split('/').pop()!.toLowerCase();
			if (links.some((p) => p.toLowerCase().endsWith(base))) on.add(s.key);
		}
	}
	return on;
}

/**
 * Show a save on the page: swap each source's old CSS for its new CSS inside the
 * page's <style>. Returns false when any update could not be placed (a linked
 * .css file, or a page the server has since changed) — a reload shows it then.
 */
export function applyLiveUpdates(updates: { before: string; after: string }[], doc: Document = document): boolean {
	let all = true;
	for (const u of updates) {
		let placed = false;
		for (const s of pageStyles(doc)) {
			const text = s.textContent || '';
			if (!text.includes(u.before)) continue;
			// split/join, not replace(): a `$` in CSS must not be read as a pattern.
			s.textContent = text.split(u.before).join(u.after);
			placed = true;
		}
		if (!placed) all = false;
	}
	return all;
}
