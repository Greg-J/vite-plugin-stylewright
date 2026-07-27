// Shipping-surface guarantees.
//
// The handoff asked for a test that "the AI modules are absent from the built
// prod entry". That test cannot exist and would be misleading if it did: the
// broker lives in src/server and tsup bundles all of src/server into the single
// dist entry, and Phase 3 deliberately publishes the MCP server inside the same
// dist. What is actually worth pinning is the property the user cares about —
// nothing Stylewright does can reach a production build of THEIR app — plus the
// egress budget and the bin wiring.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import stylewright from '../src/index.js';
import { AI_COPY } from '../src/client/aiCopy.js';
import { VENDORS } from '../src/shared/vendors.js';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('the plugin cannot reach a production build', () => {
	it('applies to serve only', () => {
		expect(stylewright().apply).toBe('serve');
		expect(stylewright({ ai: false }).apply).toBe('serve');
	});

	it('contributes no build-phase hooks', () => {
		const p = stylewright() as unknown as Record<string, unknown>;
		for (const hook of ['transform', 'renderChunk', 'generateBundle', 'buildStart', 'buildEnd', 'closeBundle', 'load', 'resolveId']) {
			expect(p[hook], `unexpected build hook: ${hook}`).toBeUndefined();
		}
	});

	it('injects the overlay only through the dev-time html transform', () => {
		const p = stylewright() as unknown as { transformIndexHtml: () => unknown[] };
		const tags = p.transformIndexHtml() as { attrs?: { src?: string } }[];
		expect(tags.some((t) => t.attrs?.src === '/__stylewright/client.js')).toBe(true);
	});

	it('injects nothing when disabled', () => {
		const p = stylewright({ enabled: false }) as unknown as { transformIndexHtml: () => unknown };
		expect(p.transformIndexHtml()).toBeUndefined();
	});
});

describe('egress budget', () => {
	// Comments are stripped first: the question is what the CODE talks to, and a
	// doc-comment explaining why plain-http LAN origins break the clipboard API is
	// not an outbound request.
	const stripComments = (src: string): string =>
		src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const clientSources = readdirSync(join(ROOT, 'src', 'client'))
		.filter((f) => f.endsWith('.ts'))
		.map((f) => ({ f, src: stripComments(readFileSync(join(ROOT, 'src', 'client', f), 'utf8')) }));

	it('the overlay talks to nothing but the dev server and the opt-out font CDN', () => {
		const offenders: string[] = [];
		for (const { f, src } of clientSources) {
			for (const m of src.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
				const url = m[0];
				const allowed =
					url.startsWith('https://fonts.googleapis.com') ||
					url.startsWith('https://fonts.gstatic.com') ||
					url.startsWith('http://www.w3.org/') ||            // SVG namespace, not a request
					url.startsWith('https://github.com/');              // a link the user clicks
				if (!allowed) offenders.push(`${f}: ${url}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('every fetch the overlay makes is same-origin and prefixed', () => {
		const bad: string[] = [];
		for (const { f, src } of clientSources) {
			for (const m of src.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g)) {
				if (!m[1].startsWith('/__stylewright') && !m[1].startsWith('${PREFIX}')) bad.push(`${f}: ${m[1]}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it('the font load is opt-out', () => {
		const theme = readFileSync(join(ROOT, 'src', 'client', 'theme.ts'), 'utf8');
		expect(theme).toContain('__stylewright_no_fonts__');
		const p = stylewright({ fonts: false }) as unknown as { transformIndexHtml: () => { children?: string }[] };
		expect(p.transformIndexHtml().some((t) => (t.children || '').includes('__stylewright_no_fonts__'))).toBe(true);
	});

	it('has no telemetry or analytics anywhere in src', () => {
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
		for (const file of walk(join(ROOT, 'src'))) {
			const src = readFileSync(file, 'utf8');
			expect(/navigator\.sendBeacon|analytics|telemetry|posthog|segment\.com|mixpanel/i.test(src), file).toBe(false);
		}
	});
});

describe('the docs and the UI say the same thing', () => {
	const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

	it('README repeats the setup steps verbatim, for every vendor', () => {
		// A setup instruction that differs between the overlay and the docs is a
		// user typing the wrong thing at the one moment they are already stuck.
		const fill = (t: string, tool: string): string => t.replace('{tool}', tool);
		for (const v of VENDORS) {
			const steps = [
				v.register.cli ? AI_COPY.empty.step1 : fill(AI_COPY.empty.step1Json, v.label),
				fill(AI_COPY.empty.step2, v.label),
				AI_COPY.empty.step3,
				AI_COPY.empty.step4
			];
			for (const step of steps) expect(readme, `${v.id}: missing step: ${step}`).toContain(step);
		}
	});

	/** The README block for one vendor, between its <summary> and </details>. */
	const sectionFor = (label: string): string => {
		const start = readme.indexOf(`<summary><b>${label}</b></summary>`);
		expect(start, `no ${label} setup section in the README`).toBeGreaterThan(-1);
		return readme.slice(start, readme.indexOf('</details>', start));
	};

	// Every vendor gets a section, and it has to be THEIR instruction. A
	// file-configured tool has no `claude mcp add`; offering one is the wrong
	// instruction, not a footnote.
	it.each(VENDORS.map((v) => [v.id, v] as const))('documents %s with its own registration method', (_id, v) => {
		const section = sectionFor(v.label);
		const fenced = [...section.matchAll(/```(?:bash|sh|shell|json)?\n([\s\S]*?)```/g)].map((m) => m[1]);
		expect(fenced.length, 'no fenced setup block').toBeGreaterThan(0);

		if (v.register.cli) {
			expect(fenced.some((b) => b.includes(v.register.cli!('npx vite-plugin-stylewright mcp')))).toBe(true);
			return;
		}
		const j = v.register.json!;
		// Mentioning `claude mcp add` to say it does not exist is the point;
		// offering it as a runnable step is the bug.
		expect(fenced.some((b) => /claude mcp add/.test(b)), 'a runnable claude command').toBe(false);
		expect(section).toContain(j.where);
		// The published-install form of exactly what the overlay would print — so
		// the docs cannot drift from the generated config or from each other.
		const want = JSON.stringify(j.build('npx vite-plugin-stylewright mcp', v.configuredWatchMs), null, 2);
		// The blocks sit inside a numbered list, so strip the shared indent before
		// comparing rather than pinning the docs to one nesting depth.
		const dedent = (t: string): string => {
			const lines = t.replace(/\s+$/, '').split('\n').filter((l) => l.trim());
			const pad = Math.min(...lines.map((l) => l.length - l.trimStart().length));
			return lines.map((l) => l.slice(pad)).join('\n');
		};
		expect(fenced.map(dedent), `${v.id} JSON does not match the registry`).toContain(dedent(want));
	});

	it('README documents the arming instruction the agent needs', () => {
		expect(readme).toContain(AI_COPY.arm.cmd);
	});

	it('the copy deck uses curly apostrophes, as it says it does', () => {
		const flat = JSON.stringify(AI_COPY);
		// U+0027 inside prose is the bug this catches; it renders subtly wrong next
		// to the curly ones and makes any string-equality check a coin flip.
		const straight = flat.match(/[a-z]'[a-z]/gi) || [];
		expect(straight).toEqual([]);
	});

	it('has no exclamation marks or apology words anywhere in the deck', () => {
		const flat = JSON.stringify(AI_COPY);
		expect(flat).not.toMatch(/!/);
		expect(flat).not.toMatch(/\b(Oops|Sorry|Error:)\b/);
	});
});

describe('runtime dependencies stay honest', () => {
	it('adds no dependency for the MCP server', () => {
		// The MCP server speaks JSON-RPC over stdio directly. A dev-only plugin
		// should not make every consumer install an SDK to get three tools.
		expect(Object.keys(pkg.dependencies)).toEqual(['magic-string', 'postcss']);
	});

	it('exposes the MCP bin the setup instructions tell people to run', () => {
		expect(pkg.bin['vite-plugin-stylewright']).toBe('./dist/mcp.js');
		expect(pkg.files).toContain('dist');
	});
});

describe('the built artifacts', () => {
	const dist = join(ROOT, 'dist');
	const built = existsSync(join(dist, 'mcp.js'));

	it.skipIf(!built)('ships one shebang on the bin, not two', () => {
		const src = readFileSync(join(dist, 'mcp.js'), 'utf8');
		expect(src.split('\n').filter((l) => l.startsWith('#!')).length).toBe(1);
		expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
	});

	it.skipIf(!built)('keeps the overlay bundle out of the plugin entry', () => {
		// The overlay is read from disk at request time, not inlined — otherwise
		// every dev-server start would parse 170KB of UI it may never serve.
		const entry = readFileSync(join(dist, 'index.js'), 'utf8');
		expect(entry).toContain('client.global.js');
		expect(entry.length).toBeLessThan(120_000);
	});
});

// Packaging guards: keep the npm metadata and the exports map publish-correct so a
// future edit can't silently drop them before release (PRAC-1, PRAC-2).
describe('the MCP server reports the version it actually is', () => {
	// An agent's MCP panel showing a version the installed package never had makes
	// "which build am I talking to" unanswerable — which is the exact question you
	// ask when a rebuilt dist/mcp.js has not been picked up by a held server process.
	it('matches package.json', () => {
		const src = readFileSync(join(ROOT, 'src/mcp/server.ts'), 'utf8');
		const found = src.match(/serverInfo:\s*\{[^}]*version:\s*'([^']+)'/);
		expect(found, 'serverInfo version literal not found').toBeTruthy();
		expect(found![1]).toBe(pkg.version);
	});
});

describe('package.json — repo metadata (PRAC-1)', () => {
	it('exposes repository / bugs / homepage so npm can link the source', () => {
		expect(pkg.repository?.url).toContain('github.com/Greg-J/vite-plugin-stylewright');
		expect(pkg.bugs?.url).toMatch(/github\.com\/.+\/issues/);
		expect(typeof pkg.homepage).toBe('string');
	});
});

describe('package.json — exports types per condition (PRAC-2)', () => {
	it('splits types for import (ESM) and require (CJS) so node16/nodenext resolve right', () => {
		const dot = pkg.exports['.'];
		expect(dot.import.types).toBe('./dist/index.d.ts');
		expect(dot.import.default).toBe('./dist/index.js');
		expect(dot.require.types).toBe('./dist/index.d.cts'); // CJS-flavored types, not the ESM .d.ts
		expect(dot.require.default).toBe('./dist/index.cjs');
	});
});
