// Find the <style> block inside a .svelte file and report the exact character
// offsets of its INNER css, so an edited block can be spliced back in without
// disturbing a single byte of the surrounding markup/script.
//
// A regex is deliberate here: <style> is always a top-level block in a .svelte
// file, and computing the inner-content offset from the end (length-based) keeps
// us correct even when the opening tag carries attributes (e.g. lang="scss").

export interface StyleBlock {
	/** Char offset of the first char of inner CSS (just after the opening tag). */
	start: number;
	/** Char offset just before `</style>`. */
	end: number;
	/** The inner CSS text — equal to `source.slice(start, end)`. */
	css: string;
}

const STYLE_RE = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/i;
const CLOSE = '</style>';

/**
 * Locate the first `<style>` block. Returns `null` when the component has none.
 */
export function findStyleBlock(source: string): StyleBlock | null {
	// Mask <script>…</script> bodies and <!-- … --> comments with equal-length blanks so
	// a <style> literal living inside a script string or a comment can't be mistaken for
	// the component's real style block (TEST-4). Only the search runs on the masked copy;
	// offsets are length-preserved and the css is sliced from the ORIGINAL source.
	const masked = source
		.replace(/(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => open + ' '.repeat(body.length) + close)
		.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
	const m = STYLE_RE.exec(masked);
	if (!m) return null;
	const full = m[0];
	const inner = m[1];
	// inner ends immediately before the closing tag; derive its start from the end
	// so attributes inside the opening tag never throw off the offset.
	const start = m.index + (full.length - CLOSE.length - inner.length);
	const end = start + inner.length;
	return { start, end, css: source.slice(start, end) };
}
