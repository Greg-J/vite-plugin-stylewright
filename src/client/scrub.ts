// Scroll-to-change for numbers. Hover the wheel over a number anywhere in the
// editor — `48` in `48px auto`, `0.2` in a transition — and scrolling nudges THAT
// number (the one under the pointer, not the caret). The unit is left untouched
// because we only ever rewrite the numeric digits.
//
//   wheel up/down : ±1
//   + Shift       : ±10
//   + Alt         : ±0.1
//
// Attached as a non-passive listener so it can preventDefault the page scroll.

import type { EditorView } from '@codemirror/view';

// A signed integer/decimal, e.g. -2, 48, 0.25, .5
const NUMBER_RE = /-?(?:\d*\.\d+|\d+)/g;

function format(n: number): string {
	// Trim float noise (0.1 + 0.2 …) and trailing zeros.
	return parseFloat(n.toFixed(4)).toString();
}

/** Install the wheel-scrub behaviour on an editor view. */
export function installScrub(view: EditorView): void {
	view.scrollDOM.addEventListener(
		'wheel',
		(event: WheelEvent) => {
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos == null) return;

			const text = view.state.doc.toString();
			NUMBER_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			let target: { from: number; to: number; value: number } | null = null;
			while ((m = NUMBER_RE.exec(text))) {
				const from = m.index;
				const to = from + m[0].length;
				if (pos >= from && pos <= to) {
					target = { from, to, value: parseFloat(m[0]) };
					break;
				}
				if (from > pos) break;
			}
			if (!target) return; // not over a number — let the page scroll normally

			event.preventDefault();
			const dir = event.deltaY < 0 ? 1 : -1;
			const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
			const next = format(target.value + dir * step);
			view.dispatch({
				changes: { from: target.from, to: target.to, insert: next },
				scrollIntoView: false
			});
		},
		{ passive: false }
	);
}
