// Tiny hyperscript helper — the vanilla stand-in for React.createElement, so the
// prototype's markup ports almost verbatim. Handles style objects (numeric → px),
// on* handlers (onChange → 'input', non-passive 'wheel'), SVG namespacing, and ref.

export type ElChild = Node | string | number | null | undefined | boolean;
type Children = ElChild | ElChild[];
export interface ElProps { [k: string]: any; }

const SVG_TAGS = new Set([
	'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse',
	'defs', 'linearGradient', 'radialGradient', 'stop'
]);
// SVG attributes that must keep their camelCase (don't kebab-ify these).
const SVG_KEEP = new Set(['viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform']);
// React props with a numeric value that should NOT get a 'px' suffix.
const UNITLESS = new Set([
	'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink',
	'order', 'zoom', 'tabSize', 'aspectRatio', 'gridRow', 'gridColumn', 'columnCount',
	'fillOpacity', 'strokeOpacity'
]);

function applyStyle(node: HTMLElement | SVGElement, style: Record<string, string | number>): void {
	for (const k in style) {
		let v: string | number = style[k];
		if (typeof v === 'number' && !UNITLESS.has(k)) v = v + 'px';
		(node.style as unknown as Record<string, string>)[k] = String(v);
	}
}

function appendChildren(node: Node, children: Children[]): void {
	for (const child of children) {
		if (child == null || child === false || child === true) continue;
		if (Array.isArray(child)) { appendChildren(node, child); continue; }
		if (child instanceof Node) { node.appendChild(child); continue; }
		node.appendChild(document.createTextNode(String(child)));
	}
}

// Ref callbacks are queued, not run at construction time: a ref fires while the
// node is still a detached orphan (parentElement === null, no layout), so any
// ref that measures or anchors (e.g. a popover positioning against its trigger)
// would read garbage. flushRefs() runs them once the tree is attached. render()
// calls it explicitly (deterministic, pre-paint); a microtask flush is the
// safety net so an el()-attach outside render() still gets its refs.
let pendingRefs: Array<() => void> = [];
let flushScheduled = false;

function scheduleFlush(): void {
	if (flushScheduled) return;
	flushScheduled = true;
	queueMicrotask(() => { flushScheduled = false; flushRefs(); });
}

/** Run (and clear) all ref callbacks queued during el() construction. Safe to
 *  call repeatedly; a throwing ref can't poison the rest or leak the queue. */
export function flushRefs(): void {
	if (!pendingRefs.length) return;
	const refs = pendingRefs;
	pendingRefs = [];
	for (const r of refs) { try { r(); } catch { /* one bad ref must not abort the drain */ } }
}

export function el(tag: string, props?: ElProps | null, ...children: Children[]): HTMLElement & SVGElement {
	const isSvg = SVG_TAGS.has(tag);
	const node = isSvg
		? document.createElementNS('http://www.w3.org/2000/svg', tag)
		: document.createElement(tag);

	if (props) {
		for (const key in props) {
			const val = props[key];
			if (val == null || val === false) continue;
			if (key === 'key') continue; // React reconciliation artifact — ignore
			if (key === 'ref') { if (typeof val === 'function') { const target = node; pendingRefs.push(() => val(target)); scheduleFlush(); } continue; }
			if (key === 'style') {
				if (typeof val === 'string') node.style.cssText = val;
				else applyStyle(node, val);
				continue;
			}
			if (key === 'className' || key === 'class') { node.setAttribute('class', String(val)); continue; }
			if (key === 'dangerouslySetInnerHTML') { (node as HTMLElement).innerHTML = val.__html; continue; }
			if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
				(node as unknown as Record<string, unknown>)[key] = val; continue;
			}
			if (key === 'spellCheck') { (node as HTMLInputElement).spellcheck = !!val; continue; }
			if (key.startsWith('on') && typeof val === 'function') {
				// React onChange ≈ DOM 'input'; wheel must be non-passive for preventDefault (scrub).
				const evt = key === 'onChange' ? 'input' : key.slice(2).toLowerCase();
				const opts = evt === 'wheel' ? { passive: false } : undefined;
				node.addEventListener(evt, val, opts);
				continue;
			}
			let attr = key;
			if (isSvg && !SVG_KEEP.has(key)) attr = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
			node.setAttribute(attr, String(val));
		}
	}

	appendChildren(node, children);
	return node as HTMLElement & SVGElement;
}

/** Remove all children of a node (cheap clear before a re-render). */
export function clear(node: Node): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}
