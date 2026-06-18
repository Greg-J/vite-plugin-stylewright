// The editor's in-memory model: an array of rules, each a selector + declarations.
// Hydrated from the server's SwRule[] (GET /rules), serialized back to CSS for
// POST /style. The prototype uses {p,v}; the wire uses {prop,value} — we adapt here.

import type { SwRule } from '../shared/protocol';

export interface Decl { p: string; v: string; }
export interface Rule { sel: string; decls: Decl[]; }

/** Wire model (GET /rules) → editor model. */
export function fromServerRules(rules: SwRule[]): Rule[] {
	return rules.map((r) => ({
		sel: r.selector,
		decls: r.decls.map((d) => ({ p: d.prop, v: d.value }))
	}));
}

/**
 * Editor model → inner CSS for the component's <style> block. Drops empty
 * declarations; emits tab-indented, canonically-formatted CSS. (Faithful
 * formatting-preservation is a later refinement — see README roadmap.)
 */
export function serializeRules(rules: Rule[]): string {
	const blocks = rules
		.filter((r) => r.sel.trim())
		.map((r) => {
			const decls = r.decls
				.filter((d) => d.p.trim() && d.v.trim())
				.map((d) => `\t\t${d.p.trim()}: ${d.v.trim()};`);
			return `\t${r.sel.trim()} {\n${decls.join('\n')}\n\t}`;
		});
	return '\n' + blocks.join('\n\n') + '\n';
}

/** Deep clone for undo/redo snapshots (structuredClone-free, JSON is enough here). */
export function cloneRules(rules: Rule[]): Rule[] {
	return rules.map((r) => ({ sel: r.sel, decls: r.decls.map((d) => ({ p: d.p, v: d.v })) }));
}
