// CSS inside JavaScript template literals: locating the literal, cooking it the
// way JavaScript does, and writing an edit back without moving any other byte.
// Every refusal here is a case where writing would have meant guessing.

import { describe, it, expect } from 'vitest';
import { findCssLiteral, cook, spliceLiteral, literalNames, type CssLiteral } from '../src/server/literal.js';

const lit = (src: string, name: string): CssLiteral => {
	const r = findCssLiteral(src, name);
	if (!r.ok) throw new Error(r.error);
	return r.lit;
};

describe('findCssLiteral', () => {
	const SRC = 'import x from "y";\nexport const STYLE = `\n.btn { color: #333; }\n`;\nexport const OTHER = `<p>hi</p>`;\n';

	it('finds the literal by name and reports exact offsets', () => {
		const l = lit(SRC, 'STYLE');
		expect(l.raw).toBe('\n.btn { color: #333; }\n');
		expect(SRC.slice(l.start, l.end)).toBe(l.raw);
		expect(SRC[l.end]).toBe('`');
		expect(l.cooked).toBe(l.raw);
	});

	it('accepts let and var, with or without export', () => {
		expect(lit('let A = `.a{}`', 'A').cooked).toBe('.a{}');
		expect(lit('var A=`.a{}`', 'A').cooked).toBe('.a{}');
		expect(lit('const A =\n  `.a{}`', 'A').cooked).toBe('.a{}');
	});

	it('does not confuse a name with a longer one sharing its prefix', () => {
		const src = 'const STYLE_EXTRA = `.x{}`;\nconst STYLE = `.y{}`;';
		expect(lit(src, 'STYLE').cooked).toBe('.y{}');
	});

	it('refuses a literal with ${} interpolation — its CSS is only known at runtime', () => {
		const r = findCssLiteral('const S = `.a { color: ${c}; }`;', 'S');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toMatch(/interpolation/);
	});

	it('refuses a name declared twice rather than pick one', () => {
		const r = findCssLiteral('const S = `.a{}`;\n// const S = `.b{}`;', 'S');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toMatch(/2 times/);
	});

	it('names the literals that do exist when the name is wrong', () => {
		const r = findCssLiteral(SRC, 'STYLES');
		expect(!r.ok && r.error).toMatch(/STYLE, OTHER/);
		expect(literalNames(SRC)).toEqual(['STYLE', 'OTHER']);
	});

	it('refuses an unterminated literal and a non-identifier name', () => {
		expect(findCssLiteral('const S = `.a{}', 'S').ok).toBe(false);
		expect(findCssLiteral('const S = `.a{}`', 'S.x').ok).toBe(false);
	});

	it('skips over an escaped backtick instead of ending there', () => {
		const l = lit('const S = `a\\`b`;', 'S');
		expect(l.raw).toBe('a\\`b');
		expect(l.cooked).toBe('a`b');
	});
});

describe('cook', () => {
	const c = (raw: string): string | undefined => cook(raw)?.text;

	it('matches what JavaScript itself produces', () => {
		const samples = ["content: '\\\\25b8 '", 'a\\`b', 'a\\$b\\${c}', 'x\\ny\\tz', '\\x41\\u0042\\u{43}', 'line\\\ncontinued', '\\a\\q'];
		for (const raw of samples) {
			const expected = new Function('return `' + raw + '`')() as string;
			expect(c(raw), raw).toBe(expected);
		}
	});

	it('normalises CR and CRLF to LF, as template literals do', () => {
		expect(c('a\r\nb\rc')).toBe('a\nb\nc');
	});

	it('maps every cooked character back to where it came from', () => {
		const raw = "a\\\\b\\`c";
		const r = cook(raw)!;
		expect(r.text).toBe('a\\b`c');
		expect(r.map).toEqual([0, 1, 3, 4, 6, raw.length]);
	});

	it('rejects escapes an untagged template rejects', () => {
		expect(cook('\\1')).toBeNull();
		expect(cook('\\01')).toBeNull();
		expect(cook('\\xZZ')).toBeNull();
		expect(cook('\\u12')).toBeNull();
	});
});

describe('spliceLiteral', () => {
	const SRC = "export const STYLE = `\n.a { color: #333; }\n.b::before { content: '\\\\25b8 '; }\n`;\n";

	it('changes only the bytes that differ', () => {
		const l = lit(SRC, 'STYLE');
		const next = l.cooked.replace('#333', '#4fa878');
		const r = spliceLiteral(SRC, l, next);
		expect(r.ok).toBe(true);
		const out = (r as { code: string }).code;
		expect(out).toBe(SRC.replace('#333', '#4fa878'));
		// The escaped declaration elsewhere in the literal is untouched.
		expect(out).toContain("'\\\\25b8 '");
		expect(lit(out, 'STYLE').cooked).toBe(next);
	});

	it('is a no-op for identical CSS', () => {
		const l = lit(SRC, 'STYLE');
		expect(spliceLiteral(SRC, l, l.cooked)).toEqual({ ok: true, code: SRC });
	});

	it('refuses to rewrite a span that includes an escape the author wrote', () => {
		const l = lit(SRC, 'STYLE');
		const r = spliceLiteral(SRC, l, l.cooked.replace("'\\25b8 '", "'>'"));
		expect(r).toEqual({ ok: false, reason: 'escaped_source' });
	});

	it('still edits plain characters next to an escape, leaving the escape as written', () => {
		const l = lit(SRC, 'STYLE');
		const next = l.cooked.replace('\\25b8', '\\25be');
		const r = spliceLiteral(SRC, l, next);
		expect(r).toEqual({ ok: true, code: SRC.replace('25b8', '25be') });
		expect(lit((r as { code: string }).code, 'STYLE').cooked).toBe(next);
	});

	it('refuses a value that would need escaping inside the literal', () => {
		const l = lit(SRC, 'STYLE');
		for (const bad of ['a\\b', 'a`b', 'a${b}']) {
			expect(spliceLiteral(SRC, l, l.cooked.replace('#333', bad)), bad).toEqual({ ok: false, reason: 'needs_escaping' });
		}
	});

	it('refuses an edit that would join a $ and a { into ${', () => {
		const src = 'const S = `.a { content: "$x"; }`;';
		const l = lit(src, 'S');
		// The minimal change is one `{` inserted right after the existing `$`.
		const next = l.cooked.replace('"$x"', '"${x"');
		expect(spliceLiteral(src, l, next)).toEqual({ ok: false, reason: 'needs_escaping' });
	});

	it('writes into a CRLF file without touching its line endings', () => {
		const src = 'const S = `\r\n.a { color: red; }\r\n`;\r\n';
		const l = lit(src, 'S');
		const r = spliceLiteral(src, l, l.cooked.replace('red', 'blue'));
		expect(r).toEqual({ ok: true, code: src.replace('red', 'blue') });
	});

	it('handles a minified literal', () => {
		const src = 'export const W = `.x{color:red}.y{margin:0}`;';
		const l = lit(src, 'W');
		const r = spliceLiteral(src, l, '.x{color:red}.y{margin:4px}');
		expect(r).toEqual({ ok: true, code: 'export const W = `.x{color:red}.y{margin:4px}`;' });
	});
});
