// Start the plain-HTML proxy from plain inputs, validating them the way an agent
// needs: every error says what to pass instead. Shared by the MCP server's
// `stylewright_attach` tool (the usual path: the user asks their agent, the
// agent attaches) and the `proxy` CLI.

import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { startProxy } from './proxy.js';
import { parseSourceSpecs, SourceSpecError, type CssSource } from '../server/sources.js';

export const DEFAULT_PORT = 5180;
/** Ports tried, in order, when none was asked for — one per concurrent project. */
const PORT_SPAN = 10;

export class AttachError extends Error {}

export interface AttachInput {
	/** The app's own dev server, e.g. http://127.0.0.1:8787. */
	target: unknown;
	/** `file.css` or `file.js#NAME` entries; the only files that may be written. */
	css: unknown;
	/** Project root; `css` paths are relative to it. */
	root?: unknown;
	/** A specific port. Absent: the first free one from DEFAULT_PORT. */
	port?: unknown;
	ai?: boolean;
	fonts?: boolean;
	warn?: (line: string) => void;
}

export interface Attached {
	url: string;
	target: string;
	root: string;
	sources: CssSource[];
	close(): Promise<void>;
}

export async function attach(input: AttachInput): Promise<Attached> {
	if (typeof input.target !== 'string' || !input.target) {
		throw new AttachError('target is required: the URL of the app\'s own running dev server, e.g. http://127.0.0.1:8787');
	}
	let target: URL;
	try { target = new URL(input.target); } catch { throw new AttachError(`target ${input.target} is not a URL — e.g. http://127.0.0.1:8787`); }
	if (target.protocol !== 'http:') throw new AttachError(`target must be an http:// URL (got ${target.href})`);

	const root = resolve(typeof input.root === 'string' && input.root ? input.root : process.cwd());
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new AttachError(`root ${root} is not a directory`);

	const specs = Array.isArray(input.css) ? input.css.filter((c): c is string => typeof c === 'string') : [];
	let sources: CssSource[];
	try { sources = parseSourceSpecs(root, specs); } catch (e) {
		throw new AttachError(e instanceof SourceSpecError ? e.message : String(e));
	}

	const explicit = input.port !== undefined && input.port !== null;
	const first = explicit ? Number(input.port) : DEFAULT_PORT;
	if (!Number.isInteger(first) || first < 0 || first > 65535) throw new AttachError(`port ${String(input.port)} is not a port number`);
	const opts = { target, root, sources, ai: input.ai ?? true, fonts: input.fonts ?? true, warn: input.warn };

	for (let port = first; port < first + (explicit ? 1 : PORT_SPAN); port++) {
		try {
			const running = await startProxy({ ...opts, port });
			return { url: running.url, target: target.origin, root, sources, close: running.close };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new AttachError(String((e as Error).message));
		}
	}
	throw new AttachError(explicit
		? `port ${first} is in use (another proxy already running?) — pick another port`
		: `ports ${first}–${first + PORT_SPAN - 1} are all in use — pass a port`);
}
