// Inline color swatches. Every color value in the editor (hex, rgb()/rgba(),
// hsl()/hsla()) gets a small clickable swatch rendered just before it; clicking
// opens the native color picker, and dragging it rewrites that color token live.

import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;

/** Resolve any CSS color string to a #rrggbb hex (to seed <input type=color>). */
function toHex(color: string): string {
	if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
	const probe = document.createElement('div');
	probe.style.color = '#000';
	probe.style.color = color; // invalid values are ignored, leaving #000
	document.body.appendChild(probe);
	const rgb = getComputedStyle(probe).color;
	probe.remove();
	const n = rgb.match(/\d+/g);
	if (!n || n.length < 3) return '#000000';
	return '#' + n.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

function openPicker(view: EditorView, from: number, to: number, current: string): void {
	const input = document.createElement('input');
	input.type = 'color';
	input.value = toHex(current);
	input.style.cssText = 'position:fixed;left:-9999px;top:0';
	document.body.appendChild(input);

	// The token range grows/shrinks as we replace it (e.g. #fff -> #ffffff), so
	// track the live end offset across successive picker `input` events.
	let curTo = to;
	input.addEventListener('input', () => {
		const val = input.value;
		view.dispatch({ changes: { from, to: curTo, insert: val } });
		curTo = from + val.length;
	});
	input.addEventListener('change', () => input.remove());
	input.click();
}

class SwatchWidget extends WidgetType {
	constructor(
		readonly color: string,
		readonly from: number,
		readonly to: number
	) {
		super();
	}
	eq(other: SwatchWidget): boolean {
		return other.color === this.color && other.from === this.from && other.to === this.to;
	}
	toDOM(view: EditorView): HTMLElement {
		const s = document.createElement('span');
		s.className = 'sw-swatch';
		s.style.cssText =
			'display:inline-block;width:11px;height:11px;border-radius:3px;vertical-align:-1px;' +
			'margin-right:5px;cursor:pointer;border:1px solid rgba(0,0,0,.25);box-shadow:0 0 0 1px rgba(255,255,255,.4) inset;' +
			`background:${this.color}`;
		s.title = 'Pick a color';
		s.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openPicker(view, this.from, this.to, this.color);
		});
		return s;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

function buildSwatches(view: EditorView): DecorationSet {
	const text = view.state.doc.toString();
	const ranges: Range<Decoration>[] = [];
	COLOR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = COLOR_RE.exec(text))) {
		const from = m.index;
		const to = from + m[0].length;
		ranges.push(Decoration.widget({ widget: new SwatchWidget(m[0], from, to), side: -1 }).range(from));
	}
	return Decoration.set(ranges, true);
}

export const colorSwatches = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildSwatches(view);
		}
		update(u: ViewUpdate): void {
			if (u.docChanged || u.viewportChanged) this.decorations = buildSwatches(u.view);
		}
	},
	{ decorations: (v) => v.decorations }
);
