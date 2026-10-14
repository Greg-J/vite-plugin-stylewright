// Plain-HTML mode: the CSS sources Stylewright may read and write.
//
// A server-rendered page has no component metadata, and its stylesheet is often
// one <style> assembled from several JavaScript template literals. So instead of
// resolving an element to a file, the overlay loads every configured source and
// narrows to the rules that match what was picked; each rule remembers which
// source it came from, and a save goes back to that source alone.
//
// The sources are an explicit allowlist given at startup (`--css`). Writing into
// .js files is a much wider surface than writing into a .svelte <style>, so
// nothing outside that list is ever opened — the client names a source by its
// key, never by a path we would resolve on its behalf.

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import postcss from 'postcss';
import { resolveContained } from './paths.js';
import { findCssLiteral, literalNames, spliceLiteral, type CssLiteral } from './literal.js';
import { readRulesCss, applyRulesCss, hasStyleBreakout } from './patch.js';
import { PLAIN_FILE } from '../shared/protocol.js';
import type { SwRule, SwAtRule, SwRulesResponse, SwApplyRequest, SwApplyResponse, SwSource } from '../shared/protocol.js';

const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'] as const;
const CSS_EXTS = ['.css'] as const;

/**
 * Rule ids are walk-order ordinals within one source. The source's index sits
 * above them, so a single number names one rule across all the sources and an
 * edit in one file never shifts the ids of another.
 */
export const ID_STRIDE = 1_000_000;

export interface CssSource {
	/** `path#NAME` for a template literal, `path` for a .css file. */
	key: string;
	/** Project-relative, forward slashes. */
	file: string;
	/** The template literal's name; null for a .css file. */
	name: string | null;
}

export class SourceSpecError extends Error {}

type Region = { ok: true; css: string; lit: CssLiteral | null } | { ok: false; error: string };

/** A source's CSS within its file's current text. */
function readRegion(src: CssSource, text: string): Region {
	if (!src.name) return { ok: true, css: text, lit: null };
	const r = findCssLiteral(text, src.name);
	return r.ok ? { ok: true, css: r.lit.cooked, lit: r.lit } : { ok: false, error: r.error };
}

const extsFor = (src: { name: string | null }): readonly string[] => (src.name ? JS_EXTS : CSS_EXTS);

/**
 * Turn `--css` entries into sources, proving each one can be read now — a typo
 * should stop the proxy at startup with a message that says what to type, not
 * surface later as an empty panel.
 */
export function parseSourceSpecs(root: string, specs: string[]): CssSource[] {
	if (!specs.length) throw new SourceSpecError('no CSS sources given — pass at least one --css <file.css> or --css <file.js>#<NAME>');
	const out: CssSource[] = [];
	for (const spec of specs) {
		const hash = spec.lastIndexOf('#');
		const path = hash >= 0 ? spec.slice(0, hash) : spec;
		const name = hash >= 0 ? spec.slice(hash + 1) : null;
		const lower = path.toLowerCase();
		const isCss = lower.endsWith('.css');
		const isJs = JS_EXTS.some((e) => lower.endsWith(e));
		if (!isCss && !isJs) throw new SourceSpecError(`--css ${spec}: a source is a .css file, or a JS/TS file plus the name of the template literal holding its CSS (file.js#NAME)`);
		if (isCss && name !== null) throw new SourceSpecError(`--css ${spec}: a .css file is a stylesheet already — drop the #${name}`);

		const abs = resolveContained(root, path, isCss ? CSS_EXTS : JS_EXTS);
		if (!abs) throw new SourceSpecError(`--css ${spec}: not a file inside ${root} (paths are relative to --root, and a symlink out of it is refused)`);
		const text = readFileSync(abs, 'utf8');
		if (isJs && !name) {
			const names = literalNames(text);
			throw new SourceSpecError(`--css ${spec}: name the template literal that holds the CSS, as ${path}#NAME` +
				(names.length ? ` (template literals declared in this file: ${names.join(', ')})` : ''));
		}

		const file = relative(root, abs).split(sep).join('/');
		const src: CssSource = { key: name ? `${file}#${name}` : file, file, name };
		if (out.some((s) => s.key === src.key)) continue;
		const region = readRegion(src, text);
		if (!region.ok) throw new SourceSpecError(`--css ${spec}: ${region.error}`);
		out.push(src);
	}
	return out;
}

const normSel = (s: string): string => s.replace(/\s+/g, ' ').trim();
const mediaSig = (m?: SwAtRule[]): string => (m || []).map((a) => `${a.name} ${String(a.params).trim()}`).join('|');

type Result = { status: number; body: SwApplyResponse };
const fail = (status: number, error: string): Result => ({ status, body: { ok: false, changed: false, error } });

export class PlainSources {
	constructor(readonly root: string, readonly sources: CssSource[]) {}

	/** Ask AI's check on `source.file`: only a configured file may be named. */
	isSourceFile = (file: string): boolean => this.sources.some((s) => s.file === file);

	/** Re-run containment (lexical and realpath) on every use, not just at startup. */
	private abs(src: CssSource): string | null {
		return resolveContained(this.root, src.file, extsFor(src));
	}

	/** Every rule from every source, ids made unique across them (`ID_STRIDE`). */
	async rules(): Promise<SwRulesResponse> {
		const rules: SwRule[] = [];
		const sources: SwSource[] = [];
		for (const [i, src] of this.sources.entries()) {
			const base = { key: src.key, file: src.file, css: '' };
			const abs = this.abs(src);
			if (!abs) { sources.push({ ...base, error: 'no longer a file inside the project' }); continue; }
			let text: string;
			try { text = await readFile(abs, 'utf8'); } catch (err) { sources.push({ ...base, error: String(err) }); continue; }
			const region = readRegion(src, text);
			if (!region.ok) { sources.push({ ...base, error: region.error }); continue; }
			sources.push({ ...base, css: region.css });
			for (const r of readRulesCss(region.css)) rules.push({ ...r, id: i * ID_STRIDE + (r.id as number), origin: src.key });
		}
		return { file: PLAIN_FILE, hasStyle: sources.some((s) => !s.error), rules, sources };
	}

	/**
	 * The plain-HTML `/apply`. Splits the editor's rules back into their sources,
	 * patches each with the same applyRulesCss the .svelte path uses, and writes
	 * only the bytes that changed. Every write is computed and checked before any
	 * is made, so a refusal never leaves half a save on disk.
	 */
	async apply(body: SwApplyRequest): Promise<Result> {
		if (!body || !Array.isArray(body.rules)) return fail(400, 'bad request');
		type Work = { rules: SwRule[]; removeIds: number[]; mediaRenames: { id: number; params: string }[] };
		const work = new Map<number, Work>();
		const slot = (i: number): Work => {
			let w = work.get(i);
			if (!w) { w = { rules: [], removeIds: [], mediaRenames: [] }; work.set(i, w); }
			return w;
		};
		const split = (id: unknown): [number, number] | null => {
			if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return null;
			const i = Math.floor(id / ID_STRIDE);
			return i < this.sources.length ? [i, id % ID_STRIDE] : null;
		};

		for (const r of body.rules) {
			if (!r || typeof r !== 'object' || typeof r.selector !== 'string' || !Array.isArray(r.decls)) return fail(400, 'bad request');
			if (r.id === undefined || r.id === null) {
				const i = this.sources.findIndex((s) => s.key === r.origin);
				if (i < 0) return fail(400, 'a new rule must name the configured source it belongs to');
				slot(i).rules.push({ ...r, id: undefined });
				continue;
			}
			const sp = split(r.id);
			if (!sp) return fail(400, 'unknown rule id');
			slot(sp[0]).rules.push({ ...r, id: sp[1] });
		}
		for (const id of body.removeIds || []) {
			const sp = split(id);
			if (!sp) return fail(400, 'unknown rule id');
			slot(sp[0]).removeIds.push(sp[1]);
		}
		for (const m of body.mediaRenames || []) {
			const sp = split(m?.id);
			if (!sp || typeof m.params !== 'string') return fail(400, 'bad request');
			slot(sp[0]).mediaRenames.push({ id: sp[1], params: m.params });
		}

		const files = new Map<string, { before: string; text: string }>();
		const updates: { key: string; before: string; after: string }[] = [];
		let matched = 0, created = 0, removed = 0, renamed = 0;

		for (const [i, w] of [...work].sort((a, b) => a[0] - b[0])) {
			const src = this.sources[i];
			const abs = this.abs(src);
			if (!abs) return fail(409, `${src.file} is no longer a file inside the project`);
			let f = files.get(abs);
			if (!f) {
				const t = await readFile(abs, 'utf8');
				f = { before: t, text: t };
				files.set(abs, f);
			}
			const region = readRegion(src, f.text);
			if (!region.ok) return fail(409, `${src.key}: ${region.error}`);

			// Ids are walk-order ordinals, so an edit made in the editor since the
			// overlay loaded can point one at a different rule. Patching that rule
			// would silently corrupt it — check every id still names what it named.
			const current = new Map(readRulesCss(region.css).map((r) => [r.id as number, r]));
			const stale = `${src.key} changed on disk since it was loaded — reload the page and pick the element again`;
			for (const r of w.rules) {
				if (typeof r.id !== 'number') continue;
				const c = current.get(r.id);
				if (!c || normSel(c.selector) !== normSel(r.selector) || mediaSig(c.media) !== mediaSig(r.media)) return fail(409, stale);
			}
			for (const id of [...w.removeIds, ...w.mediaRenames.map((m) => m.id)]) if (!current.has(id)) return fail(409, stale);

			// Only bytes that changed may move. postcss reprints untouched nodes
			// verbatim, but make sure of it for THIS stylesheet before relying on it.
			let lossless = false;
			try { lossless = postcss.parse(region.css).toString() === region.css; } catch { /* unparseable */ }
			if (!lossless) return fail(422, `${src.key}: Stylewright cannot reprint this CSS byte-for-byte, so it will not edit it`);

			const res = applyRulesCss(region.css, w.rules, { removeIds: w.removeIds, mediaRenames: w.mediaRenames });
			matched += res.matched; created += res.created; removed += res.removed; renamed += res.renamed;
			if (!res.changed) continue;
			// The page emits this CSS inside a <style>: a literal `</style` in a value
			// would end that element and turn the rest into markup.
			if (hasStyleBreakout(res.code)) return fail(400, 'refused: the new CSS contains </style or </script');

			if (region.lit) {
				const sp = spliceLiteral(f.text, region.lit, res.code);
				if (!sp.ok) {
					return fail(422, sp.reason === 'escaped_source'
						? `${src.key}: that part of the source is written with a backslash escape — edit it in the file itself`
						: `${src.key}: the new value would need escaping inside a template literal (a backslash, a backtick or \${) — edit it in the file itself`);
				}
				// Read it back the way the page will: the literal must still be found,
				// and must cook to exactly the CSS we meant to write.
				const again = readRegion(src, sp.code);
				if (!again.ok || again.css !== res.code) return fail(500, `${src.key}: the patched literal did not read back as intended; nothing was written`);
				f.text = sp.code;
			} else {
				f.text = res.code;
			}
			updates.push({ key: src.key, before: region.css, after: res.code });
		}

		for (const [abs, f] of files) if (f.text !== f.before) await writeFile(abs, f.text, 'utf8');
		return { status: 200, body: { ok: true, changed: updates.length > 0, matched, created, removed, renamed, updates } };
	}
}
