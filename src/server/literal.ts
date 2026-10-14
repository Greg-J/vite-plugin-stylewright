// CSS that lives in a JavaScript template literal:
//
//     export const STYLE = `
//       .btn { color: #4fa878; }
//     `;
//
// A server-rendered app (a Worker, an Express view) often keeps its stylesheet
// like this and emits it into one <style> on every page. To edit it we need two
// things this module provides: WHERE the literal's text sits in the file, and
// what the CSS actually is once JavaScript has processed its escapes — the
// browser sees `content: '\25b8'` where the source says `content: '\\25b8'`.
//
// Everything here refuses rather than guesses. A literal with `${}` is not a
// stylesheet we can edit (its runtime text depends on code we would have to
// run), a name that matches twice could be the wrong one, and a write that
// would need escaping is better left to a human or an agent.

/** A located template literal, with its CSS as JavaScript would cook it. */
export interface CssLiteral {
	/** Offset of the first character after the opening backtick. */
	start: number;
	/** Offset of the closing backtick. */
	end: number;
	/** The literal's source text, exactly as in the file. */
	raw: string;
	/** The string value JavaScript produces from it — what the page receives. */
	cooked: string;
	/**
	 * `map[i]` is the offset in `raw` where cooked character `i` comes from;
	 * `map[cooked.length]` is `raw.length`. Escapes make the two diverge.
	 */
	map: number[];
}

export type LocateResult = { ok: true; lit: CssLiteral } | { ok: false; error: string };

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Every `const|let|var NAME = \`` declaration in a file — for error messages. */
export function literalNames(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`/g)) {
		if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/**
 * Find the template literal assigned to `name` (`const NAME = \`…\``, with or
 * without `export`) and cook it.
 *
 * A lexical match, not a parse. It is held to two conditions that make that
 * safe: the declaration must occur exactly once in the file, and the literal
 * must close cleanly with no `${` inside it. A name in a comment or a string
 * that happens to look like a declaration makes the count two, which refuses.
 */
export function findCssLiteral(source: string, name: string): LocateResult {
	if (!IDENT.test(name)) return { ok: false, error: `"${name}" is not a JavaScript identifier` };
	const re = new RegExp(String.raw`\b(?:const|let|var)\s+` + name.replace(/\$/g, '\\$') + String.raw`\s*=\s*` + '`', 'g');
	const hits = [...source.matchAll(re)];
	if (hits.length === 0) {
		const names = literalNames(source);
		return {
			ok: false,
			error: `no template literal named ${name}` +
				(names.length ? ` (template literals declared in this file: ${names.join(', ')})` : ' (this file assigns no template literal to a const, let or var)')
		};
	}
	if (hits.length > 1) return { ok: false, error: `\`${name}\` is declared ${hits.length} times, so which one is meant is ambiguous` };

	const open = hits[0].index! + hits[0][0].length - 1; // the backtick
	const start = open + 1;
	let i = start;
	for (; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') { i++; continue; }
		if (c === '`') break;
		if (c === '$' && source[i + 1] === '{') {
			return { ok: false, error: `\`${name}\` contains \${…} interpolation, so its CSS is only known at runtime` };
		}
	}
	if (i >= source.length) return { ok: false, error: `\`${name}\` has no closing backtick` };

	const raw = source.slice(start, i);
	const cooked = cook(raw);
	if (!cooked) return { ok: false, error: `\`${name}\` contains an escape sequence JavaScript rejects` };
	return { ok: true, lit: { start, end: i, raw, cooked: cooked.text, map: cooked.map } };
}

const HEX = /^[0-9a-fA-F]+$/;

/**
 * JavaScript's template-literal cooking (ECMA-262 TV), with an offset map back
 * to the raw text. Line terminators normalise CR and CRLF to LF, as they do in
 * the language. Returns null for an escape an untagged template rejects.
 */
export function cook(raw: string): { text: string; map: number[] } | null {
	let text = '';
	const map: number[] = [];
	const emit = (s: string, at: number): void => {
		for (let k = 0; k < s.length; k++) map.push(at);
		text += s;
	};
	let i = 0;
	while (i < raw.length) {
		const c = raw[i];
		if (c === '\r') { emit('\n', i); i += raw[i + 1] === '\n' ? 2 : 1; continue; }
		if (c !== '\\') { emit(c, i); i++; continue; }

		const n = raw[i + 1];
		if (n === undefined) return null;
		const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
		if (n in simple) { emit(simple[n], i); i += 2; continue; }
		if (n === '0') {
			if (/[0-9]/.test(raw[i + 2] || '')) return null;
			emit('\0', i); i += 2; continue;
		}
		if (/[1-9]/.test(n)) return null; // legacy octal: a syntax error in templates
		if (n === 'x') {
			const h = raw.slice(i + 2, i + 4);
			if (h.length !== 2 || !HEX.test(h)) return null;
			emit(String.fromCharCode(parseInt(h, 16)), i); i += 4; continue;
		}
		if (n === 'u') {
			if (raw[i + 2] === '{') {
				const close = raw.indexOf('}', i + 3);
				const h = close < 0 ? '' : raw.slice(i + 3, close);
				if (!h || !HEX.test(h) || parseInt(h, 16) > 0x10ffff) return null;
				emit(String.fromCodePoint(parseInt(h, 16)), i); i = close + 1; continue;
			}
			const h = raw.slice(i + 2, i + 6);
			if (h.length !== 4 || !HEX.test(h)) return null;
			emit(String.fromCharCode(parseInt(h, 16)), i); i += 6; continue;
		}
		// Line continuation: a backslash before a line break contributes nothing.
		if (n === '\r') { i += raw[i + 2] === '\n' ? 3 : 2; continue; }
		if (n === '\n' || n === ' ' || n === ' ') { i += 2; continue; }
		// `\\`, `\``, `\$`, and any other character stand for themselves.
		emit(n, i); i += 2;
	}
	map.push(raw.length);
	return { text, map };
}

/** Why a cooked-text replacement cannot be written back into the literal. */
export type SpliceRefusal = 'escaped_source' | 'needs_escaping';

/**
 * Write `next` (the literal's new cooked CSS) into `source`, changing only the
 * bytes that differ. The change is reduced to the smallest span by trimming the
 * common prefix and suffix, and that span is written only when:
 *
 *   - the raw text it replaces is the same characters as its cooked text — no
 *     escape inside it, so nothing the author wrote is reinterpreted; and
 *   - the replacement contains no backslash, backtick or `${`, which would need
 *     escaping to mean the same thing inside a template literal.
 *
 * Anything else is refused: an editor writing `\\` on the user's behalf is a
 * guess about what they meant.
 */
export function spliceLiteral(source: string, lit: CssLiteral, next: string): { ok: true; code: string } | { ok: false; reason: SpliceRefusal } {
	const prev = lit.cooked;
	if (next === prev) return { ok: true, code: source };
	const max = Math.min(prev.length, next.length);
	let p = 0;
	while (p < max && prev[p] === next[p]) p++;
	let s = 0;
	while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;

	const cookedOld = prev.slice(p, prev.length - s);
	const insert = next.slice(p, next.length - s);
	const rawFrom = lit.map[p];
	const rawTo = lit.map[prev.length - s];
	if (lit.raw.slice(rawFrom, rawTo) !== cookedOld) return { ok: false, reason: 'escaped_source' };
	if (/[\\`\r]/.test(insert) || insert.includes('${')) return { ok: false, reason: 'needs_escaping' };
	// A `$` or `{` at either edge could pair with its new neighbour into `${`.
	const before = lit.raw.slice(0, rawFrom);
	const after = lit.raw.slice(rawTo);
	if ((insert.startsWith('{') && before.endsWith('$')) || (insert.endsWith('$') && after.startsWith('{'))) {
		return { ok: false, reason: 'needs_escaping' };
	}
	const at = lit.start + rawFrom;
	return { ok: true, code: source.slice(0, at) + insert + source.slice(lit.start + rawTo) };
}
