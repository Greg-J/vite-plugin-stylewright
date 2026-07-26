// The dev-server lockfile: how a local MCP process finds this dev server and
// proves it is allowed to talk to it.
//
// It lives ONLY in a user-level registry — ~/.stylewright/servers/<slug>.json,
// 0600 inside a 0700 directory — and deliberately NOT under the Vite root.
//
// The obvious place, <root>/node_modules/.stylewright/dev.json, is a hole: that
// path is inside the tree Vite serves, so the dev server hands the bearer token
// to any unauthenticated GET. `vite --host` then publishes it to the LAN, and
// any local process that can open the port can read a credential it was never
// given filesystem access to. Chmod cannot help — the leak is over HTTP.
//
// The registry also happens to be the more capable option: it is found from
// anywhere, which is what makes monorepos work. When Vite's root is `apps/web`
// and the agent runs at the repo root, walking UP from the agent would never
// reach an in-root lockfile at all.
//
// Entries are removed on close. A stale one is harmless — discovery probes the
// origin before trusting it.

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface DevFile {
	pid: number;
	root: string;
	origin: string;
	token: string;
	startedAt: number;
	version: 1;
}

/**
 * Where the user-level registry lives. A function, not a constant, so it can be
 * redirected per-process — containers with no real $HOME, and tests, which must
 * not discover whatever dev server the developer happens to be running.
 */
export function registryDir(): string {
	return process.env.STYLEWRIGHT_REGISTRY_DIR || join(homedir(), '.stylewright', 'servers');
}

/** Stable per-root filename for the user-level registry. */
export function registrySlug(root: string): string {
	const h = createHash('sha256').update(root).digest('hex').slice(0, 16);
	const base = (root.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'root').replace(/[^a-z0-9._-]/gi, '-');
	return `${base}-${h}.json`;
}

export function newToken(): string {
	return randomBytes(32).toString('hex');
}

function writeJson(path: string, data: unknown): void {
	// 0700 on the directory and 0600 on the file: the token is a bearer credential
	// for a server that writes to this user's source tree, so another account on a
	// shared machine should not be able to read it — or even enumerate which
	// projects are running.
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdirSync's mode applies only when it CREATES the directory, and it is masked
	// by the umask even then. Set it explicitly so a directory left behind by an
	// earlier version (or a permissive umask) is tightened rather than trusted.
	try { chmodSync(dir, 0o700); } catch { /* not owned by us, or Windows */ }
	writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
	try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export interface DevFileHandles {
	registry: string;
	cleanup: () => void;
}

/** Write the registry entry and hand back a cleanup that removes it. */
export function writeDevFile(info: DevFile): DevFileHandles {
	const registry = join(registryDir(), registrySlug(info.root));
	// A failure to write must never take the dev server down — the AI path just
	// stays undiscoverable, and the overlay's setup screen says so.
	try { writeJson(registry, info); } catch { /* ignore */ }
	let done = false;
	return {
		registry,
		cleanup: () => {
			if (done) return;
			done = true;
			try { if (existsSync(registry)) rmSync(registry, { force: true }); } catch { /* ignore */ }
		}
	};
}
