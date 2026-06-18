// The editor's in-memory model: an array of rules, each a selector + declarations
// (plus a stable source id and any enclosing @media context). Hydrated from the
// server's SwRule[] (GET /rules); saved back via POST /apply (toServerRules), which
// patches the exact source rules and preserves @media/comments. The prototype uses
// {p,v}; the wire uses {prop,value} — we adapt here.

import type { SwRule, SwAtRule } from '../shared/protocol';

export interface Decl { p: string; v: string; }
export interface Rule {
	sel: string;
	decls: Decl[];
	/** Stable source id (from GET /rules) — lets a save target the EXACT rule
	 *  rather than the first one whose selector matches. Absent for new rules. */
	id?: number;
	/** Enclosing @media/at-rule chain, outermost first — for grouping + labels. */
	media?: SwAtRule[];
}

/** Wire model (GET /rules) → editor model. */
export function fromServerRules(rules: SwRule[]): Rule[] {
	return rules.map((r) => ({
		sel: r.selector,
		decls: r.decls.map((d) => ({ p: d.prop, v: d.value })),
		id: r.id,
		media: r.media
	}));
}

/** Editor model → wire model (POST /apply). Carries the `id` so the server patches
 *  the exact source rule and leaves everything else byte-for-byte. */
export function toServerRules(rules: Rule[]): SwRule[] {
	return rules.map((r) => ({
		id: r.id,
		selector: r.sel,
		decls: r.decls.map((d) => ({ prop: d.p, value: d.v })),
		media: r.media
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
	return rules.map((r) => ({ sel: r.sel, id: r.id, media: r.media, decls: r.decls.map((d) => ({ p: d.p, v: d.v })) }));
}
