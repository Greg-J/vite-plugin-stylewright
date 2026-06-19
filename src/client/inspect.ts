// Element → source-file resolution (via Svelte's dev metadata) and the DOM-tree
// model for the HTML panel. Pure DOM reads, shared by the boot module
// (index.ts) and the Panel — one source of truth for "which component owns this
// node" and "what does the page's element tree look like."

/** Display strings for a picked element, shown in the panel breadcrumb. */
export interface PickMeta {
	fileLabel: string;
	selectorLabel: string;
	dims: string;
	tag: string;
}

type WithMeta = Element & { __svelte_meta?: { loc?: { file?: string } } };

/** Nearest source file at or above an element, from Svelte's dev metadata. */
export function resolveFile(node: Element | null): string | null {
	let cur: WithMeta | null = node;
	while (cur && cur !== document.documentElement) {
		const file = cur.__svelte_meta?.loc?.file;
		if (file) return file;
		cur = cur.parentElement;
	}
	return null;
}

/** "src/lib/Button.svelte" → "lib/Button.svelte" (last two path segments). */
export function shortPath(file: string): string {
	return file.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

/** "<button class=\"btn primary\">" — an element's opening tag, for display. */
export function tagLabel(node: Element): string {
	const tag = node.tagName.toLowerCase();
	const cls = (node.getAttribute('class') || '').trim();
	return '<' + tag + (cls ? ` class="${cls}"` : '') + '>';
}

/** PickMeta for an element: file label, a representative selector, and its size. */
export function describe(node: Element): PickMeta {
	const r = node.getBoundingClientRect();
	const file = resolveFile(node);
	const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
	return {
		fileLabel: file ? shortPath(file) : '',
		selectorLabel: cls.length ? '.' + cls[0] : node.tagName.toLowerCase(),
		dims: Math.round(r.width) + ' × ' + Math.round(r.height),
		tag: tagLabel(node)
	};
}

/** One node in the DOM-panel tree model. */
export interface DomNode {
	el: Element;
	tag: string;
	id: string | null;
	classes: string[];
	/** Component file owning this element (own metadata, else inherited from parent). */
	file: string | null;
	fileLabel: string | null;
	/** True when this element introduces a different component than its parent — a
	 *  component boundary worth labeling in the tree. */
	ownsFile: boolean;
	/** Stable key: the chain of child-indices from the walk root, e.g. "r/0/3/1". */
	path: string;
	children: DomNode[];
}

// Non-visual elements we never want cluttering the tree.
const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript', 'template', 'head', 'meta', 'title', 'base']);

/**
 * Walk an element subtree into a DomNode model. `skip` (the overlay's own host)
 * and non-visual tags are excluded. Child indices are assigned over ALL children
 * (skipped ones still advance the index) so a node's `path` stays stable
 * regardless of what's filtered out. Returns the roots plus an element→node map
 * for O(1) "where is the picked element" lookups.
 */
export function buildDomTree(root: Element, skip?: Element | null): { roots: DomNode[]; byEl: Map<Element, DomNode> } {
	const byEl = new Map<Element, DomNode>();
	const walk = (elx: Element, path: string, parentFile: string | null): DomNode | null => {
		if (skip && elx === skip) return null;
		const tag = elx.tagName.toLowerCase();
		if (SKIP_TAGS.has(tag)) return null;
		const own = (elx as WithMeta).__svelte_meta?.loc?.file || null;
		const file = own || parentFile;
		const children: DomNode[] = [];
		const kids = elx.children;
		for (let i = 0; i < kids.length; i++) {
			const child = walk(kids[i], path + '/' + i, file);
			if (child) children.push(child);
		}
		const node: DomNode = {
			el: elx,
			tag,
			id: elx.id || null,
			classes: (elx.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean),
			file,
			fileLabel: file ? shortPath(file) : null,
			ownsFile: !!own && own !== parentFile,
			path,
			children
		};
		byEl.set(elx, node);
		return node;
	};
	const rootNode = walk(root, 'r', null);
	return { roots: rootNode ? [rootNode] : [], byEl };
}

/** All inclusive prefix paths of a node path — "r/0/3" → {"r","r/0","r/0/3"}. */
export function pathPrefixes(path: string): Set<string> {
	const parts = path.split('/');
	const out = new Set<string>();
	let acc = '';
	for (let i = 0; i < parts.length; i++) {
		acc = i === 0 ? parts[0] : acc + '/' + parts[i];
		out.add(acc);
	}
	return out;
}
