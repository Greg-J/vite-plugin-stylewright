// Value tokenizer + per-declaration classifier, lifted verbatim from the prototype.
// tokenize() splits a CSS value into colored spans; classify() picks the inline control.

import { KEYWORDS } from './data';
import { isColorValue } from './color';

export type TokKind = 'color' | 'num' | 'sep' | 'word';
export interface Tok { t: TokKind; x: string; }

/** Declaration "shape" — chooses the inline editor for the whole value. */
export type DeclKind = 'font' | 'color' | 'keyword' | 'number' | 'text';

export function tokenize(v: string): Tok[] {
	const RE = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))|(-?\d*\.?\d+(?:px|rem|em|%|vh|vw|deg|s|ms|fr|ch|pt|vmin|vmax)?)|(\s+|,|\/|\(|\))|([^\s,\/()]+)/gi;
	const out: Tok[] = [];
	let m: RegExpExecArray | null;
	while ((m = RE.exec(v || ''))) {
		if (m.index === RE.lastIndex) RE.lastIndex++;
		if (m[1]) out.push({ t: 'color', x: m[1] });
		else if (m[2]) out.push({ t: 'num', x: m[2] });
		else if (m[3]) out.push({ t: 'sep', x: m[3] });
		else if (m[4] != null) out.push({ t: 'word', x: m[4] });
	}
	return out;
}

export function classify(p: string, v: string): DeclKind {
	if (p === 'font-family') return 'font';
	if (isColorValue(v)) return 'color';
	if (KEYWORDS[p]) return 'keyword';
	if (/^-?\d*\.?\d+(px|rem|em|%|vh|vw|deg|s|ms|fr|ch|pt)?$/i.test(v)) return 'number';
	return 'text';
}

/** Prefix-matches first, then substring matches; excludes the current value. */
export function rankList(list: string[], value: string): string[] {
	const q = (value || '').toLowerCase();
	const s = list.filter((x) => x !== value);
	const a = s.filter((x) => x.toLowerCase().startsWith(q));
	const b = s.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().indexOf(q) >= 0);
	return [...a, ...b];
}
