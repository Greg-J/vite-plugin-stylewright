// The novel core: read a component's <style> rules, and apply a single
// declaration edit back into the source — touching only the matched declaration,
// leaving the rest of the file (and the rest of the CSS) byte-for-byte intact.

import postcss from 'postcss';
import MagicString from 'magic-string';
import { findStyleBlock } from './locate.js';
import type { SwRule, SwEditRequest } from '../shared/protocol.js';

/** Collapse insignificant whitespace so source and runtime selectors compare equal. */
function normalizeSelector(sel: string): string {
	return sel.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a component's <style> and return its rules as source selectors +
 * declarations. The overlay uses this to show what's editable.
 */
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
	root.walkRules((rule) => {
		const decls = rule.nodes
			.filter((n): n is postcss.Declaration => n.type === 'decl')
			.map((d) => ({ prop: d.prop, value: d.value }));
		rules.push({ selector: normalizeSelector(rule.selector), decls });
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
