// What an agent reads to run Stylewright on a plain-HTML app: the MCP server's
// instructions, the request it is handed, and the bin's `proxy` command. The
// usual operator is an agent following a person's instruction, so this text is
// the interface.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliCommand } from '../src/shared/cli.js';
import { serverInstructions, renderRequest } from '../src/mcp/server.js';
import type { SwAiRequest } from '../src/shared/protocol.js';

describe('cliCommand', () => {
	it('uses the npx name when installed as a package', () => {
		expect(cliCommand(pathToFileURL('/home/u/app/node_modules/vite-plugin-stylewright/dist/proxy.js').href)).toBe('npx vite-plugin-stylewright');
	});
	it('uses an absolute node path from a checkout, where the npx name would 404', () => {
		expect(cliCommand(pathToFileURL('/Users/g/code/vite-plugin-stylewright/dist/mcp.js').href)).toBe('node /Users/g/code/vite-plugin-stylewright/dist/mcp.js');
		expect(cliCommand(pathToFileURL('/Users/g/my code/sw/dist/proxy.js').href)).toBe('node "/Users/g/my code/sw/dist/mcp.js"');
	});
});

describe('serverInstructions', () => {
	const text = serverInstructions('node /x/dist/mcp.js');
	it('still leads with the watch loop', () => {
		expect(text.startsWith('Stylewright connects this session')).toBe(true);
		expect(text).toContain('stylewright_watch');
	});
	it('tells an agent how to start the proxy for an app that is not Svelte + Vite', () => {
		expect(text).toContain('node /x/dist/mcp.js proxy --target <app url> --root <project dir> --css <source>');
		expect(text).toContain('in the background');
		expect(text).toContain('path/file.js#NAME');
		expect(text).toContain('node /x/dist/mcp.js proxy --help');
	});
});

describe('renderRequest', () => {
	const req = (origin?: string): SwAiRequest => ({
		id: 'r1', createdAt: 1, prompt: 'make it green',
		source: { file: 'hub/src/lib/html.js' },
		element: { tag: '<button class="btn">', tagName: 'button', classList: ['btn'], selector: '.btn', rect: { width: 1, height: 1 } },
		context: { outerHTML: '<button class="btn">Go</button>', styleRules: [{ selector: '.btn', decls: [], origin }] },
		page: { route: '/', url: 'http://127.0.0.1:5180/', viewport: { width: 1, height: 1, dpr: 1 }, colorScheme: 'dark' }
	});
	it('explains a server-rendered page: the file holds the CSS, the markup is elsewhere', () => {
		const t = renderRequest(req('hub/src/lib/html.js#STYLE'));
		expect(t).toContain('server-rendered');
		expect(t).toContain('"origin": "hub/src/lib/html.js#STYLE"');
	});
	it('says nothing extra for a Svelte component', () => {
		expect(renderRequest(req())).not.toContain('server-rendered');
	});
});

describe('the built bin', () => {
	const bin = join(__dirname, '..', 'dist', 'mcp.js');
	const built = existsSync(bin) && existsSync(join(__dirname, '..', 'dist', 'proxy.js'));
	const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 20_000 });

	it.skipIf(!built)('documents `proxy` in its own help', () => {
		const r = run('--help');
		expect(r.stderr).toContain('vite-plugin-stylewright proxy');
	});

	it.skipIf(!built)('prints proxy help an agent can follow', () => {
		const r = run('proxy', '--help');
		expect(r.status).toBe(0);
		for (const s of ['--target <url>', '--css <source>', 'path/to/file.js#NAME', 'in the background', '--root <dir>']) expect(r.stdout).toContain(s);
	});

	it.skipIf(!built)('fails with an instruction, not a stack trace', () => {
		const root = mkdtempSync(join(tmpdir(), 'sw-cli-'));
		try {
			writeFileSync(join(root, 'style.js'), 'export const STYLE = `.a{}`;\nexport const OTHER = `.b{}`;\n');
			const noTarget = run('proxy', '--root', root, '--css', 'style.js#STYLE');
			expect(noTarget.status).toBe(1);
			expect(noTarget.stderr).toMatch(/--target is required/);
			const noName = run('proxy', '--target', 'http://127.0.0.1:1', '--root', root, '--css', 'style.js');
			expect(noName.status).toBe(1);
			expect(noName.stderr).toMatch(/style\.js#NAME.*STYLE, OTHER/);
			const unknown = run('proxy', '--target', 'http://127.0.0.1:1', '--bogus');
			expect(unknown.stderr).toMatch(/unknown option --bogus/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
