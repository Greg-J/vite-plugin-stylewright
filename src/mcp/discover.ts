// Finding the dev server from inside an agent's process.
//
//   1. STYLEWRIGHT_URL / STYLEWRIGHT_TOKEN — explicit, for containers and CI.
//   2. The user-level registry in ~/.stylewright/servers, matched against cwd.
//
// There is deliberately no lockfile under the Vite root to walk up to: that path
// is inside the tree Vite serves, so it would hand the bearer token to any
// unauthenticated HTTP GET (see devfile.ts). The registry covers both layouts
// anyway — a root at or above cwd, and the monorepo case where Vite serves
// `apps/web` while the agent runs at the repo root.
//
// Every candidate is probed before it is trusted: an entry can outlive the
// process that wrote it (a `kill -9` skips cleanup), and a stale one would send
// the agent's requests into a closed port.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type { DevFile } from '../server/ai/devfile.js';
import { registryDir } from '../server/ai/devfile.js';
import { usefulCwd } from '../shared/cwd.js';

export interface Discovered extends DevFile {
	/** Where we found it, for the error message when things go wrong. */
	via: 'env' | 'registry';
}

/** More than one candidate under cwd and no way to choose — the caller must be
 *  told rather than sent to an arbitrary one. */
export class AmbiguousServers extends Error {
	roots: string[];
	constructor(roots: string[]) {
		super('ambiguous');
		this.roots = roots;
	}
}

function readDevFile(path: string): DevFile | null {
	try {
		const d = JSON.parse(readFileSync(path, 'utf8')) as DevFile;
		if (!d || typeof d.origin !== 'string' || typeof d.token !== 'string' || typeof d.root !== 'string') return null;
		return d;
	} catch {
		return null;
	}
}

/** Is `a` at or above `b`? */
function isAncestor(a: string, b: string): boolean {
	const x = resolve(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const y = resolve(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return y === x || y.startsWith(x + '/');
}

/** Confirm the server is actually alive and the token is accepted. */
export async function probe(d: DevFile, timeoutMs = 1500): Promise<boolean> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(`${d.origin}/__stylewright/ai/agent/list_pending`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` },
			body: JSON.stringify({ sessionId: '' }),
			signal: ac.signal
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

export async function discover(cwd: string): Promise<Discovered | null> {
	// 1. Explicit override.
	const url = process.env.STYLEWRIGHT_URL;
	const token = process.env.STYLEWRIGHT_TOKEN;
	if (url && token) {
		const d: Discovered = { version: 1, pid: 0, root: cwd, origin: url.replace(/\/+$/, ''), token, startedAt: 0, via: 'env' };
		if (await probe(d)) return d;
	}

	// 2. User-level registry. Prefer a server whose root CONTAINS cwd (the agent is
	//    inside the served project, so there is exactly one right answer — the
	//    closest one). Otherwise accept one nested UNDER cwd (the monorepo case),
	//    but only if there is exactly one live: silently binding a repo-root agent
	//    to whichever app answered first is worse than asking.
	let entries: string[] = [];
	const regDir = registryDir();
	try { entries = readdirSync(regDir).filter((f) => f.endsWith('.json')); } catch { entries = []; }
	const all = entries.map((f) => readDevFile(join(regDir, f))).filter((d): d is DevFile => !!d);

	// Cline spawns MCP servers at "/", which is an ancestor of every project on
	// the machine. Running the "closest containing root" heuristic from there
	// silently picks whichever path happens to be longest — and skips the
	// ambiguity check entirely. A cwd that locates nothing has to fall through to
	// the same "exactly one, or ask" rule as the monorepo case.
	const located = usefulCwd(cwd);
	if (located) {
		const containing = all.filter((d) => isAncestor(d.root, cwd)).sort((a, b) => b.root.length - a.root.length);
		for (const d of containing) {
			if (await probe(d)) return { ...d, via: 'registry' };
		}
	}

	const nested = located ? all.filter((d) => isAncestor(cwd, d.root)) : all;
	const live: DevFile[] = [];
	for (const d of nested) if (await probe(d)) live.push(d);
	if (live.length === 1) return { ...live[0], via: 'registry' };
	if (live.length > 1) throw new AmbiguousServers(live.map((d) => d.root).sort());
	return null;
}

/** What the agent is told when there is nothing to connect to. Actionable, and
 *  specific about the two things that are actually different from "it's broken". */
export const NO_SERVER_MESSAGE =
	'No running Vite dev server with Stylewright was found for this project.\n' +
	'  • Start it with `npm run dev` (or your project\'s dev script), then call this tool again.\n' +
	'  • If the dev server runs in a container or under another user, set STYLEWRIGHT_URL and\n' +
	'    STYLEWRIGHT_TOKEN (both are in ~/.stylewright/servers/ on the machine running Vite).';

/** What the agent is told when it is somewhere that could mean several projects. */
export function ambiguousMessage(roots: string[]): string {
	return (
		'Several Stylewright dev servers are running below this directory, so it is not clear which one\n' +
		'you mean:\n' +
		roots.map((r) => `  • ${r}`).join('\n') +
		'\n\nRun the agent inside the app you want, or set STYLEWRIGHT_URL and STYLEWRIGHT_TOKEN\n' +
		'(both are in ~/.stylewright/servers/).'
	);
}
