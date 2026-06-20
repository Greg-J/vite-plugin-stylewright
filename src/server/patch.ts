// The novel core: read a component's <style> rules, and apply a single
// declaration edit back into the source — touching only the matched declaration,
// leaving the rest of the file (and the rest of the CSS) byte-for-byte intact.

import postcss from 'postcss';
import MagicString from 'magic-string';
import { findStyleBlock } from './locate.js';
import type { SwRule, SwAtRule, SwEditRequest } from '../shared/protocol.js';

/** Collapse insignificant whitespace so source and runtime selectors compare equal. */
function normalizeSelector(sel: string): string {
	return sel.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a component's <style> and return its rules as source selectors +
 * declarations. The overlay uses this to show what's editable.
 */
/** The chain of at-rules enclosing `rule`, outermost first. */
function atRuleChain(rule: postcss.Rule): SwAtRule[] {
	const chain: SwAtRule[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let p: any = rule.parent;
	while (p && p.type === 'atrule') {
		chain.unshift({ name: String(p.name), params: String(p.params).trim() });
		p = p.parent;
	}
	return chain;
}

/** True for @keyframes / @-webkit-keyframes (and vendor variants). */
function isKeyframesName(name: string): boolean {
	return /(?:^|-)keyframes$/i.test(name);
}

export function readRules(source: string): { hasStyle: boolean; rules: SwRule[] } {
	const block = findStyleBlock(source);
	if (!block) return { hasStyle: false, rules: [] };
	let root: postcss.Root;
	try {
		root = postcss.parse(block.css);
	} catch {
		return { hasStyle: true, rules: [] };
	}
	const rules: SwRule[] = [];
	let ordinal = 0;
	root.walkRules((rule) => {
		const id = ordinal++; // every rule gets a stable ordinal in walk order, even if not surfaced
		const media = atRuleChain(rule);
		// Don't surface @keyframes steps (0%, 50%, from/to) as editable selectors —
		// they're animation frames, not styling rules. Their ordinal is still
		// consumed so a targeted save's index stays aligned with walk order.
		if (media.some((a) => isKeyframesName(a.name))) return;
		const decls = rule.nodes
			.filter((n): n is postcss.Declaration => n.type === 'decl')
			.map((d) => ({ prop: d.prop, value: d.value }));
		rules.push({
			id,
			selector: normalizeSelector(rule.selector),
			decls,
			media: media.length ? media : undefined
		});
	});
	return { hasStyle: true, rules };
}

export interface ApplyResult {
	code: string;
	/** True when the file text actually changed. */
	changed: boolean;
	/** True when a rule matching `selector` was found. */
	matched: boolean;
}

/**
 * Apply one declaration edit to the component source. Matches the first rule
 * whose selector equals `edit.selector`; updates the declaration if present,
 * otherwise appends it. Only the bytes inside the <style> block are rewritten.
 */
export function applyEdit(source: string, edit: SwEditRequest): ApplyResult {
	const block = findStyleBlock(source);
	if (!block) return { code: source, changed: false, matched: false };

	let root: postcss.Root;
	try {
		root = postcss.parse(block.css);
	} catch {
		return { code: source, changed: false, matched: false };
	}

	const wantSel = normalizeSelector(edit.selector);
	let matched = false;
	root.walkRules((rule) => {
		if (matched) return; // first match wins
		if (normalizeSelector(rule.selector) !== wantSel) return;
		matched = true;
		let found = false;
		rule.walkDecls(edit.prop, (decl) => {
			decl.value = edit.value;
			found = true;
		});
		if (!found) rule.append({ prop: edit.prop, value: edit.value });
	});

	const newCss = root.toString();
	if (newCss === block.css) return { code: source, changed: false, matched };

	const ms = new MagicString(source);
	ms.overwrite(block.start, block.end, newCss);
	return { code: ms.toString(), changed: true, matched };
}

export interface ApplyRulesResult {
	code: string;
	/** True when the file text actually changed. */
	changed: boolean;
	/** How many incoming rules were matched to a source rule by id. */
	matched: number;
	/** Phase 4 structural-op counts. */
	created: number;
	removed: number;
	renamed: number;
}

/** Phase 4 structural operations (see SwApplyRequest). */
export interface ApplyRulesOpts {
	removeIds?: number[];
	mediaRenames?: { id: number; params: string }[];
}

/**
 * Structure-preserving save. Takes the editor's rule model (each rule carrying the
 * stable `id` from readRules) and patches ONLY the matched rules' declarations back
 * into the parsed source tree — so `@media`/`@keyframes`/`@supports`, comments, and
 * every untouched rule are preserved exactly. This replaces the flat whole-block
 * serialize (which flattened at-rules into top-level rules — silent data loss).
 *
 * Phase 4 adds structural ops on top of the declaration patch:
 *  - a rule in `rules` with NO `id` is CREATED into the @media block named by its
 *    `media` (the block is created if absent) — "add a responsive override";
 *  - `opts.removeIds` deletes rules and prunes an emptied @media wrapper;
 *  - `opts.mediaRenames` rewrites the params of the @media enclosing a rule id.
 * The id map is built ONCE up front (walk order, mirroring readRules), so removes/
 * renames/patches all act on stable node references; creates append last. After any
 * structural change the client re-fetches, because ids shift.
 */
export function applyRules(source: string, rules: SwRule[], opts: ApplyRulesOpts = {}): ApplyRulesResult {
	const empty = { code: source, changed: false, matched: 0, created: 0, removed: 0, renamed: 0 };
	const block = findStyleBlock(source);
	if (!block) return empty;
	let root: postcss.Root;
	try {
		root = postcss.parse(block.css);
	} catch {
		return empty;
	}

	// Map each surfaced rule's stable id (walk-order ordinal, skipping @keyframes
	// steps) to its postcss node — mirrors readRules EXACTLY so the ids line up.
	const idMap = new Map<number, postcss.Rule>();
	let ordinal = 0;
	root.walkRules((node) => {
		const id = ordinal++;
		if (atRuleChain(node).some((a) => isKeyframesName(a.name))) return;
		idMap.set(id, node);
	});

	let changed = false, matched = 0, created = 0, removed = 0, renamed = 0;
	const removeSet = new Set(opts.removeIds || []);

	// 1) media renames — change the enclosing @media params (moves the whole block).
	for (const ren of opts.mediaRenames || []) {
		const node = idMap.get(ren.id);
		const at = node?.parent;
		if (at && at.type === 'atrule' && (at as postcss.AtRule).name.toLowerCase() === 'media') {
			const next = String(ren.params).trim();
			if ((at as postcss.AtRule).params.trim() !== next) { (at as postcss.AtRule).params = next; renamed++; changed = true; }
		}
	}

	// 2) removes — delete the rule, prune an emptied @media wrapper.
	for (const id of removeSet) {
		const node = idMap.get(id);
		if (!node) continue;
		const at = node.parent;
		node.remove();
		removed++; changed = true;
		if (at && at.type === 'atrule') {
			const atr = at as postcss.AtRule;
			if (!atr.nodes || atr.nodes.length === 0) atr.remove();
		}
	}

	// 3) patches — existing rules' declarations (skip anything we removed).
	for (const r of rules) {
		if (typeof r.id !== 'number' || removeSet.has(r.id)) continue;
		const node = idMap.get(r.id);
		if (!node) continue;
		matched++;
		if (reconcileDecls(node, r.decls)) changed = true;
	}

	// 4) creates — id-less rules, into the matching @media (created if needed).
	for (const r of rules) {
		if (typeof r.id === 'number') continue;
		const sel = normalizeSelector(r.selector || '');
		if (!sel) continue;
		const newRule = postcss.rule({ selector: sel });
		for (const d of (r.decls || [])) {
			if (d.prop?.trim() && d.value?.trim()) newRule.append({ prop: d.prop.trim(), value: d.value.trim() });
		}
		insertRule(root, newRule, (r.media || []).filter((m) => m.name));
		created++; changed = true;
	}

	if (!changed) return { ...empty, matched };
	const newCss = root.toString();
	if (newCss === block.css) return { ...empty, matched };
	const ms = new MagicString(source);
	ms.overwrite(block.start, block.end, newCss);
	return { code: ms.toString(), changed: true, matched, created, removed, renamed };
}

/**
 * Insert `rule` into the tree under the given @media chain (outermost first),
 * reusing an existing block with identical name+params or creating one. With an
 * empty chain the rule is appended at the top level.
 */
function insertRule(root: postcss.Root, rule: postcss.Rule, media: SwAtRule[]): void {
	let parent: postcss.Container = root;
	for (const m of media) {
		const name = m.name.toLowerCase();
		const params = String(m.params).trim();
		let block: postcss.AtRule | null = null;
		parent.each((n) => {
			if (n.type === 'atrule' && (n as postcss.AtRule).name.toLowerCase() === name && String((n as postcss.AtRule).params).trim() === params) {
				block = n as postcss.AtRule;
				return false;
			}
		});
		if (!block) {
			block = postcss.atRule({ name: m.name, params });
			parent.append(block);
		}
		parent = block;
	}
	parent.append(rule);
}

/**
 * Make a rule node's declarations equal `desired`. Fast path — same properties in
 * the same order — updates only the changed values in place, so the rest of the rule
 * stays byte-for-byte (this is the common case: scrubbing a number, picking a color).
 * Otherwise (a declaration added, removed, or reordered) it rebuilds the rule body.
 * Empty/half-typed declarations are dropped. Returns whether anything changed.
 */
function reconcileDecls(node: postcss.Rule, desired: { prop: string; value: string }[]): boolean {
	const want = desired
		.filter((d) => d.prop.trim() && d.value.trim())
		.map((d) => ({ prop: d.prop.trim(), value: d.value.trim() }));
	const current = node.nodes.filter((n): n is postcss.Declaration => n.type === 'decl');

	if (current.length === want.length && current.every((c, i) => c.prop === want[i].prop)) {
		let changed = false;
		current.forEach((c, i) => {
			if (c.value !== want[i].value) {
				c.value = want[i].value;
				changed = true;
			}
		});
		return changed;
	}

	node.removeAll();
	for (const d of want) node.append({ prop: d.prop, value: d.value });
	return true;
}

/** Read the raw inner CSS of a component's <style> block (the code-editor model). */
export function readStyle(source: string): { hasStyle: boolean; css: string } {
	const block = findStyleBlock(source);
	if (!block) return { hasStyle: false, css: '' };
	return { hasStyle: true, css: block.css };
}

/**
 * Is this CSS safe to write to a .svelte file? It must parse, and every
 * declaration must have a non-empty value. This is the guard against persisting a
 * mid-typing fragment (`font`, `color:`) that would break Svelte's compiler.
 */
export function isCompleteCss(css: string): boolean {
	let root: postcss.Root;
	try {
		root = postcss.parse(css);
	} catch {
		return false;
	}
	let ok = true;
	root.walkDecls((d) => {
		if (!d.value || !d.value.trim()) ok = false;
	});
	return ok;
}

/**
 * Replace the entire inner CSS of a component's <style> block with `css`. Only the
 * bytes between <style> and </style> change — markup and script are untouched.
 * Refuses to write CSS that wouldn't compile (returns `invalid: true` instead), so
 * a half-typed declaration never breaks the dev server.
 */
export function applyStyleBlock(
	source: string,
	css: string
): { code: string; changed: boolean; invalid: boolean; droppedAtRules?: boolean } {
	const block = findStyleBlock(source);
	if (!block) return { code: source, changed: false, invalid: false };
	if (css === block.css) return { code: source, changed: false, invalid: false };
	if (!isCompleteCss(css)) return { code: source, changed: false, invalid: true };

	// Guard against the flat whole-block serializer destroying structure. The
	// editor's in-memory model is a flat list of rules with no at-rule context, so
	// re-serializing a component that has @media/@keyframes/@supports/@font-face
	// would promote those nested rules to the top level — flattening a responsive
	// override into an always-on rule (silent data loss). If any at-rule present in
	// the source is missing from the incoming CSS, refuse the write. Lifts once the
	// save model becomes structure-aware.
	let origRoot: postcss.Root;
	let newRoot: postcss.Root;
	try {
		origRoot = postcss.parse(block.css);
		newRoot = postcss.parse(css);
	} catch {
		return { code: source, changed: false, invalid: true };
	}
	const origAt = atRuleSignatures(origRoot);
	if (origAt.size) {
		const newAt = atRuleSignatures(newRoot);
		for (const sig of origAt) {
			if (!newAt.has(sig)) return { code: source, changed: false, invalid: false, droppedAtRules: true };
		}
	}

	const ms = new MagicString(source);
	ms.overwrite(block.start, block.end, css);
	return { code: ms.toString(), changed: true, invalid: false };
}

/**
 * A stable signature per at-rule ("@media (min-width: 768px)", "@keyframes spin",
 * "@font-face") so a rewrite that would silently drop one can be detected.
 */
function atRuleSignatures(root: postcss.Root): Set<string> {
	const sigs = new Set<string>();
	root.walkAtRules((at) => {
		sigs.add(`@${at.name} ${at.params}`.trim());
	});
	return sigs;
}
