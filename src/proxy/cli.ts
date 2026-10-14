// `vite-plugin-stylewright proxy` — Stylewright for apps that are not Svelte +
// Vite, from a shell. The usual path is the MCP server's `stylewright_attach`
// tool, which runs the same attach() in-process; this is for scripts and for
// agents without the MCP server.
//
// This file is the dist/proxy.js entry, loaded on demand by the bin and the MCP
// server, so the MCP server stays free of postcss and friends.

import { PROXY_HOST } from './proxy.js';
import { attach, DEFAULT_PORT } from './attach.js';
import { SourceSpecError } from '../server/sources.js';
import { cliCommand } from '../shared/cli.js';

export { attach, AttachError } from './attach.js';

export function proxyHelp(cmd: string): string {
	return `${cmd} proxy — Stylewright for apps that are not Svelte + Vite

Puts the Stylewright overlay on a server-rendered app (a Cloudflare Worker under
\`wrangler dev\`, Express, Rails, anything that serves HTML) without changing the
app. Open the URL it prints instead of the app's own: every request is forwarded
to the app, and HTML pages come back with the overlay added.

Usage:
  ${cmd} proxy --target <app url> --css <source> [--css <source> ...] [options]

Required:
  --target <url>   The app's own local dev server, e.g. http://127.0.0.1:8787.
  --css <source>   A CSS source the overlay may edit. Repeat for each one. These
                   are the only files Stylewright will write. Two forms:
                     path/to/styles.css
                     path/to/file.js#NAME    for CSS held in  const NAME = \`...\`
                   A template literal must contain no \${...}. To list candidates:
                     grep -rnE '(const|let|var) [A-Za-z_$][A-Za-z0-9_$]* = \`' <src dir>

Options:
  --root <dir>     Project root; --css paths are relative to it. Default: cwd.
  --port <n>       Port to listen on, on ${PROXY_HOST} only. Default: the first
                   free one from ${DEFAULT_PORT}.
  --no-ai          No Ask AI tab, routes or agent registration.
  --no-fonts       Don't load IBM Plex from Google Fonts for the overlay.

It runs until stopped (Ctrl-C or SIGTERM). Sign-in cookies work through it as
they do on the app's own port.

An agent with the Stylewright MCP server does not need this command: its
stylewright_attach tool does the same thing inside the MCP server, and the
overlay ends with the agent's session.

A saved edit is written to the source file and applied to the open page at once.
The app's server picks up the file change the way it always does; a reload shows
what the server now sends.

Limits: it edits CSS rules only. Inline style="" attributes and colours set from
JavaScript are not editable here (Ask AI can change those). A declaration written
with a backslash escape, or a new value that would need one inside a template
literal, is refused rather than escaped.
`;
}

interface Args { target?: string; root?: string; css: string[]; port?: string; ai: boolean; fonts: boolean; help: boolean }

function parseArgs(argv: string[]): Args {
	const a: Args = { css: [], ai: true, fonts: true, help: false };
	for (let i = 0; i < argv.length; i++) {
		let flag = argv[i];
		let value: string | undefined;
		const eq = flag.indexOf('=');
		if (flag.startsWith('--') && eq > 0) { value = flag.slice(eq + 1); flag = flag.slice(0, eq); }
		const take = (): string => {
			if (value !== undefined) return value;
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new SourceSpecError(`${flag} needs a value — see --help`);
			return v;
		};
		switch (flag) {
			case '--target': a.target = take(); break;
			case '--root': a.root = take(); break;
			case '--css': a.css.push(take()); break;
			case '--port': a.port = take(); break;
			case '--no-ai': a.ai = false; break;
			case '--no-fonts': a.fonts = false; break;
			case '--help': case '-h': a.help = true; break;
			default: throw new SourceSpecError(`unknown option ${flag} — see --help`);
		}
	}
	return a;
}

export async function runProxyCli(argv: string[]): Promise<void> {
	const cmd = cliCommand(import.meta.url);
	const out = (s: string): void => { process.stdout.write(s + '\n'); };
	const err = (s: string): void => { process.stderr.write(s + '\n'); };
	const die = (s: string): never => { err(`[stylewright] ${s}`); process.exit(1); };

	let args: Args;
	try { args = parseArgs(argv); } catch (e) { return die(String((e as Error).message)); }
	if (args.help) { out(proxyHelp(cmd)); return; }

	let running;
	try {
		running = await attach({ target: args.target, css: args.css, root: args.root, port: args.port, ai: args.ai, fonts: args.fonts, warn: err });
	} catch (e) {
		// attach() names the field; on the command line it is a flag.
		return die(String((e as Error).message).replace(/^(target|root|port) /, '--$1 '));
	}

	out('[stylewright] proxy ready');
	out(`  open    ${running.url}`);
	out(`  app     ${running.target}`);
	out(`  root    ${running.root}`);
	running.sources.forEach((s, i) => out(`  ${i ? '       ' : 'writes '} ${s.key}`));
	out(args.ai
		? `  ask ai  on — an agent session under ${running.root} picks requests up once told "watch for Stylewright edits"`
		: '  ask ai  off');

	// Say now, not on the first page load, if the app is not up yet.
	if (!(await reachable(running.target))) {
		err(`[stylewright] nothing answered at ${running.target} yet — start the app's dev server; requests will be forwarded once it is up`);
	}

	const stop = (): void => { void running.close().then(() => process.exit(0)); };
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}

/** Does anything answer at the app's origin? Used to warn, never to refuse. */
export async function reachable(origin: string): Promise<boolean> {
	try {
		await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
		return true;
	} catch {
		return false;
	}
}
