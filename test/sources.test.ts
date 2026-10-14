// Plain-HTML mode's CSS sources: the startup allowlist, reading rules across
// several sources, and the write path — which must change only the edited bytes
// and must refuse, writing nothing, whenever a write would mean guessing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSourceSpecs, PlainSources, ID_STRIDE, SourceSpecError } from '../src/server/sources.js';
import { PLAIN_FILE, type SwRule } from '../src/shared/protocol.js';

const HTML_JS = [
	"import { x } from './x.js';",
	'export const STYLE = `',
	':root { --green: #4fa878; }',
	'.btn { color: #333; padding: 4px 8px; }',
	".evout > summary::before { content: '\\\\25b8 '; }",
	'@media (max-width: 700px) { .btn { padding: 2px; } }',
	'`;',
	'export const LIVE = `.pill { color: ${tone}; }`;',
	'export const page = (body) => `<html><style>${STYLE}</style>${body}</html>`;',
	''
].join('\n');
const WS_JS = 'export const WORKSPACE_STYLE = `\n.ws-rail{width:260px;flex:none}.ws-rail a{color:var(--ink-dim)}\n`;\n';
const PLAIN_CSS = '.card {\n  border: 1px solid #ccc;\n}\n';

let root: string;
let outside: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sw-src-'));
	outside = mkdtempSync(join(tmpdir(), 'sw-out-'));
	mkdirSync(join(root, 'lib'));
	writeFileSync(join(root, 'lib/html.js'), HTML_JS);
	writeFileSync(join(root, 'lib/ws.js'), WS_JS);
	writeFileSync(join(root, 'lib/app.css'), PLAIN_CSS);
	writeFileSync(join(outside, 'secret.css'), '.x{}');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const disk = (f: string): string => readFileSync(join(root, f), 'utf8');
const SPECS = ['lib/html.js#STYLE', 'lib/ws.js#WORKSPACE_STYLE', 'lib/app.css'];
const open = (specs = SPECS): PlainSources => new PlainSources(root, parseSourceSpecs(root, specs));

/** Load, change one declaration in place, save — exactly what the overlay does. */
async function editDecl(p: PlainSources, sel: string, prop: string, value: string) {
	const { rules } = await p.rules();
	const next: SwRule[] = rules.map((r) => r.selector === sel && !r.media
		? { ...r, decls: r.decls.map((d) => (d.prop === prop ? { ...d, value } : d)) }
		: r);
	return p.apply({ file: PLAIN_FILE, rules: next });
}

describe('parseSourceSpecs — the allowlist is checked at startup', () => {
	it('accepts template literals and .css files, keyed as given', () => {
		const s = parseSourceSpecs(root, SPECS);
		expect(s.map((x) => x.key)).toEqual(SPECS);
		expect(s[0]).toMatchObject({ file: 'lib/html.js', name: 'STYLE' });
		expect(s[2]).toMatchObject({ file: 'lib/app.css', name: null });
	});

	const refuses = (specs: string[], msg: RegExp) => {
		expect(() => parseSourceSpecs(root, specs)).toThrow(SourceSpecError);
		expect(() => parseSourceSpecs(root, specs)).toThrow(msg);
	};

	it('requires at least one source', () => refuses([], /at least one --css/));
	it('asks for the literal name, listing the candidates', () => refuses(['lib/html.js'], /#NAME.*STYLE, LIVE/));
	it('names the real literals when the name is wrong', () => refuses(['lib/html.js#STYLES'], /STYLE, LIVE/));
	it('refuses a literal with ${} at startup', () => refuses(['lib/html.js#LIVE'], /interpolation/));
	it('refuses a #name on a .css file', () => refuses(['lib/app.css#X'], /drop the #X/));
	it('refuses other file types', () => {
		writeFileSync(join(root, 'lib/x.html'), '<style></style>');
		refuses(['lib/x.html'], /\.css file, or a JS\/TS file/);
	});
	it('refuses a path out of the root', () => refuses(['../' + outside.split('/').pop() + '/secret.css'], /not a file inside/));
	it('refuses an absolute path elsewhere', () => refuses([join(outside, 'secret.css')], /not a file inside/));
	it('refuses a symlink inside the root that points out of it', () => {
		symlinkSync(join(outside, 'secret.css'), join(root, 'lib/link.css'));
		refuses(['lib/link.css'], /not a file inside/);
	});
	it('refuses a missing file', () => refuses(['lib/nope.css'], /not a file inside/));
});

describe('PlainSources.rules', () => {
	it('returns every source\'s rules, with ids unique across sources and an origin each', async () => {
		const r = await open().rules();
		expect(r.file).toBe(PLAIN_FILE);
		expect(r.hasStyle).toBe(true);
		const btn = r.rules.find((x) => x.selector === '.btn' && !x.media)!;
		expect(btn.origin).toBe('lib/html.js#STYLE');
		const rail = r.rules.find((x) => x.selector === '.ws-rail')!;
		expect(rail.origin).toBe('lib/ws.js#WORKSPACE_STYLE');
		expect(rail.id).toBe(ID_STRIDE + 0);
		expect(r.rules.find((x) => x.selector === '.card')!.id).toBe(2 * ID_STRIDE);
		expect(new Set(r.rules.map((x) => x.id)).size).toBe(r.rules.length);
	});

	it('reports each source\'s CSS as the page receives it (escapes processed)', async () => {
		const r = await open().rules();
		expect(r.sources![0].css).toContain("content: '\\25b8 '");
		expect(r.sources![0].css).not.toContain('\\\\');
		const before = r.rules.find((x) => x.selector === '.evout > summary::before')!;
		expect(before.decls[0].value).toBe("'\\25b8 '");
	});

	it('reports a source that stopped being readable instead of failing the page', async () => {
		const p = open();
		writeFileSync(join(root, 'lib/ws.js'), 'export const WORKSPACE_STYLE = `.a{color:${c}}`;');
		const r = await p.rules();
		expect(r.sources![1].error).toMatch(/interpolation/);
		expect(r.rules.some((x) => x.origin === 'lib/ws.js#WORKSPACE_STYLE')).toBe(false);
		expect(r.rules.some((x) => x.origin === 'lib/html.js#STYLE')).toBe(true);
	});
});

describe('PlainSources.apply — writes', () => {
	it('changes only the edited declaration\'s bytes in a template literal', async () => {
		const r = await editDecl(open(), '.btn', 'color', '#4fa878');
		expect(r.status).toBe(200);
		expect(r.body.changed).toBe(true);
		expect(disk('lib/html.js')).toBe(HTML_JS.replace('color: #333', 'color: #4fa878'));
		expect(disk('lib/ws.js')).toBe(WS_JS);
		expect(disk('lib/app.css')).toBe(PLAIN_CSS);
	});

	it('returns the source\'s CSS before and after, for the page to swap in', async () => {
		const r = await editDecl(open(), '.btn', 'color', 'red');
		expect(r.body.updates).toHaveLength(1);
		const u = r.body.updates![0];
		expect(u.key).toBe('lib/html.js#STYLE');
		expect(u.after).toBe(u.before.replace('color: #333', 'color: red'));
	});

	it('edits a minified literal without reformatting it', async () => {
		await editDecl(open(), '.ws-rail', 'width', '280px');
		expect(disk('lib/ws.js')).toBe(WS_JS.replace('width:260px', 'width:280px'));
	});

	it('edits a plain .css file', async () => {
		await editDecl(open(), '.card', 'border', '2px solid #ccc');
		expect(disk('lib/app.css')).toBe(PLAIN_CSS.replace('1px', '2px'));
	});

	it('leaves a file alone when nothing changed', async () => {
		const p = open();
		const { rules } = await p.rules();
		const r = await p.apply({ file: PLAIN_FILE, rules });
		expect(r.body).toMatchObject({ ok: true, changed: false });
		expect(disk('lib/html.js')).toBe(HTML_JS);
	});

	it('creates an override in the source the rule names', async () => {
		const p = open();
		const { rules } = await p.rules();
		const create: SwRule = { selector: '.ws-rail', media: [{ name: 'media', params: '(min-width: 900px)' }], decls: [{ prop: 'width', value: '300px' }], origin: 'lib/ws.js#WORKSPACE_STYLE' };
		const r = await p.apply({ file: PLAIN_FILE, rules: [...rules, create] });
		expect(r.body).toMatchObject({ ok: true, created: 1 });
		// postcss copies the minified style it finds, so the new block matches it.
		expect(disk('lib/ws.js')).toBe(WS_JS.replace('}\n`', '}@media (min-width: 900px){.ws-rail{width:300px}}\n`'));
		expect(disk('lib/html.js')).toBe(HTML_JS);
	});

	it('removes a rule by its page-wide id', async () => {
		const p = open();
		const { rules } = await p.rules();
		const card = rules.find((x) => x.selector === '.card')!;
		const r = await p.apply({ file: PLAIN_FILE, rules: rules.filter((x) => x !== card), removeIds: [card.id!] });
		expect(r.body).toMatchObject({ ok: true, removed: 1 });
		expect(disk('lib/app.css')).not.toContain('.card');
	});

	it('handles two literals in the same file in one save', async () => {
		writeFileSync(join(root, 'lib/two.js'), 'const A = `.a { color: red; }`;\nconst B = `.b { color: blue; }`;\n');
		const p = open(['lib/two.js#A', 'lib/two.js#B']);
		const { rules } = await p.rules();
		const next = rules.map((r) => ({ ...r, decls: [{ prop: 'color', value: 'green' }] }));
		const res = await p.apply({ file: PLAIN_FILE, rules: next });
		expect(res.body.updates).toHaveLength(2);
		expect(disk('lib/two.js')).toBe('const A = `.a { color: green; }`;\nconst B = `.b { color: green; }`;\n');
	});
});

describe('PlainSources.apply — refusals write nothing', () => {
	const untouched = (): void => {
		expect(disk('lib/html.js')).toBe(HTML_JS);
		expect(disk('lib/ws.js')).toBe(WS_JS);
		expect(disk('lib/app.css')).toBe(PLAIN_CSS);
	};

	it('refuses an edit to a declaration written with an escape', async () => {
		const r = await editDecl(open(), '.evout > summary::before', 'content', "'>'");
		expect(r.status).toBe(422);
		expect(r.body.error).toMatch(/backslash escape/);
		untouched();
	});

	it('refuses a value that would need escaping in the literal', async () => {
		for (const v of ['"a`b"', '"\\201C"', '"${x}"']) {
			const r = await editDecl(open(), '.btn', 'color', v);
			expect(r.status, v).toBe(422);
			expect(r.body.error).toMatch(/escaping/);
		}
		untouched();
	});

	it('never lets an edit close the page\'s <style> early', async () => {
		// Whether postcss escapes it (8.5 prints `\3c /style`) or the guard refuses it
		// (older postcss prints it raw), no `</style` may ever reach the file — and in
		// a template literal the escape is a backslash, so it is refused outright.
		const attempts = async (origin: string, sel: string): Promise<void> => {
			const p = open();
			const { rules } = await p.rules();
			const target = rules.find((r) => r.selector === sel && r.origin === origin)!;
			const withMedia = rules.find((r) => r.media && r.origin === 'lib/html.js#STYLE')!;
			await p.apply({ file: PLAIN_FILE, rules: rules.map((r) => (r === target ? { ...r, decls: [{ prop: 'border', value: 'url(</style><img src=x>)' }] } : r)) });
			await p.apply({ file: PLAIN_FILE, rules: [...rules, { selector: '</style><img src=x onerror=alert(1)>', decls: [{ prop: 'color', value: 'red' }], origin }] });
			await p.apply({ file: PLAIN_FILE, rules, mediaRenames: [{ id: withMedia.id!, params: '(max-width: 1px) { } </style><script>' }] });
		};
		await attempts('lib/app.css', '.card');
		expect(disk('lib/app.css')).not.toMatch(/<\/style/i);
		await attempts('lib/html.js#STYLE', '.btn');
		expect(disk('lib/html.js')).toBe(HTML_JS);
	});

	it('refuses ids that went stale when the file changed on disk', async () => {
		const p = open();
		const { rules } = await p.rules();
		// Someone adds a rule above .btn in their editor: every later ordinal shifts.
		writeFileSync(join(root, 'lib/html.js'), HTML_JS.replace(':root {', '.new { color: red; }\n:root {'));
		const after = disk('lib/html.js');
		const next = rules.map((r) => (r.selector === '.btn' && !r.media ? { ...r, decls: [{ prop: 'color', value: 'blue' }, { prop: 'padding', value: '4px 8px' }] } : r));
		const res = await p.apply({ file: PLAIN_FILE, rules: next });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/changed on disk/);
		expect(disk('lib/html.js')).toBe(after);
	});

	it('refuses the whole save when one source refuses, so nothing is half-written', async () => {
		const p = open();
		const { rules } = await p.rules();
		const next = rules.map((r) => {
			if (r.selector === '.ws-rail') return { ...r, decls: [{ prop: 'width', value: '999px' }, { prop: 'flex', value: 'none' }] };
			if (r.selector === '.evout > summary::before') return { ...r, decls: [{ prop: 'content', value: "'>'" }] };
			return r;
		});
		const res = await p.apply({ file: PLAIN_FILE, rules: next });
		expect(res.status).toBe(422);
		untouched();
	});

	it('refuses a source that became a symlink out of the root', async () => {
		const p = open();
		const { rules } = await p.rules();
		unlinkSync(join(root, 'lib/app.css'));
		symlinkSync(join(outside, 'secret.css'), join(root, 'lib/app.css'));
		const next = rules.map((r) => (r.selector === '.card' ? { ...r, decls: [{ prop: 'border', value: '0' }] } : r));
		const res = await p.apply({ file: PLAIN_FILE, rules: next });
		expect(res.status).toBe(409);
		expect(readFileSync(join(outside, 'secret.css'), 'utf8')).toBe('.x{}');
	});

	it('refuses an id that names no configured source, and a create with no origin', async () => {
		const p = open();
		expect((await p.apply({ file: PLAIN_FILE, rules: [{ id: 9 * ID_STRIDE, selector: '.x', decls: [] }] })).status).toBe(400);
		expect((await p.apply({ file: PLAIN_FILE, rules: [{ selector: '.x', decls: [{ prop: 'color', value: 'red' }] }] })).status).toBe(400);
		expect((await p.apply({ file: PLAIN_FILE, rules: [{ selector: '.x', decls: [], origin: 'lib/other.js#X' }] })).status).toBe(400);
		untouched();
	});

	it('refuses a malformed body', async () => {
		const p = open();
		expect((await p.apply({ file: PLAIN_FILE, rules: 'x' } as never)).status).toBe(400);
		expect((await p.apply({ file: PLAIN_FILE, rules: [null] } as never)).status).toBe(400);
		expect((await p.apply({ file: PLAIN_FILE, rules: [], removeIds: [-1] })).status).toBe(400);
		untouched();
	});

	it('only names configured files as Ask AI sources', () => {
		const p = open();
		expect(p.isSourceFile('lib/html.js')).toBe(true);
		expect(p.isSourceFile('lib/app.css')).toBe(true);
		expect(p.isSourceFile('lib/view.js')).toBe(false);
		expect(p.isSourceFile('../etc/passwd')).toBe(false);
	});
});
