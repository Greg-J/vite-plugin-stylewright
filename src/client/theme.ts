// Shadow-DOM stylesheet + webfont loading for the overlay. The panel lives in a
// shadow root so none of this leaks into (or is overridden by) the host app.

export const SHADOW_CSS = `
/* all:initial is what isolates us from the host page — but it also resets
   font-family to the browser default (Times), and every element that doesn't
   name a family inherits that. Re-establishing the base family here is the one
   place it belongs; without it the overlay renders in serif whenever a builder
   forgets the property. */
:host { all: initial; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; font-family: inherit; }
@keyframes sw-spin { to { transform: rotate(360deg); } }
@keyframes sw-pop { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes sw-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
.sw-scroll::-webkit-scrollbar { width: 11px; height: 11px; }
.sw-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.13); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }
.sw-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.22); background-clip: content-box; }
.sw-scroll::-webkit-scrollbar-track { background: transparent; }
.sw-in { all: unset; font-family: "IBM Plex Mono", monospace; font-size: 12.5px; line-height: 22px; min-width: 1ch; color: inherit; }
.sw-in::selection { background: rgba(139,124,246,.35); }
/* The prompt box can't inherit .sw-in (all:unset would strip the textarea's own
   box), so it carries its own focus + placeholder treatment. */
.sw-ta::selection { background: rgba(139,124,246,.35); }
.sw-ta::placeholder { color: #6a6a78; }
.sw-ta:focus { border-color: rgba(139,124,246,.55) !important; }
.sw-iconbtn:hover { background: rgba(255,255,255,.08) !important; color: #ececf1 !important; }
.sw-fab { cursor: pointer; }
.sw-fab:hover { transform: scale(1.06); }
.sw-addstyle:hover { background: #5a4cf0 !important; }
.sw-cand:hover { background: #22222a !important; border-color: rgba(139,124,246,.4) !important; }
`;

const FONT_HREF =
	'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';

/**
 * Load IBM Plex from Google Fonts into the host document once. Fonts registered
 * on the document are usable inside the shadow root.
 *
 * This is the ONLY request Stylewright makes to anything but the local dev
 * server, and it is opt-out: `stylewright({ fonts: false })` skips it entirely
 * and the overlay falls back to the system sans/mono stacks. Some teams treat
 * any third-party request from dev tooling as egress worth refusing, and they
 * are right to want the switch. (Local bundling is the eventual fix.)
 */
export function ensureFonts(): void {
	const id = '__stylewright_fonts';
	if (document.getElementById(id)) return;
	// The plugin stamps this global when `fonts: false`.
	if ((window as { __stylewright_no_fonts__?: boolean }).__stylewright_no_fonts__) return;
	const pre1 = document.createElement('link');
	pre1.rel = 'preconnect';
	pre1.href = 'https://fonts.googleapis.com';
	const pre2 = document.createElement('link');
	pre2.rel = 'preconnect';
	pre2.href = 'https://fonts.gstatic.com';
	pre2.crossOrigin = 'anonymous';
	const link = document.createElement('link');
	link.id = id;
	link.rel = 'stylesheet';
	link.href = FONT_HREF;
	document.head.append(pre1, pre2, link);
}
