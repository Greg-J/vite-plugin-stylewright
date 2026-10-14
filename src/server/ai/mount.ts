// Start the AI path against an HTTP server: the broker, the bearer token, the
// /ai routes, and the registry entry an MCP process discovers it by. Shared by
// the Vite plugin and the plain-HTML proxy, so both register the same way and a
// single MCP server finds either.

import type { AddressInfo } from 'node:net';
import { Broker } from './broker.js';
import { createAiRoutes } from './routes.js';
import { writeDevFile, newToken, type DevFileHandles } from './devfile.js';
import { resolveSetupCommand } from './setupCommand.js';

/** What we need of an HTTP server — Vite's (http, https or http2) or the proxy's. */
interface Listenable {
	address(): AddressInfo | string | null;
	readonly listening: boolean;
	once(event: 'listening' | 'close', fn: () => void): unknown;
}

export function mountAi(opts: {
	root: string;
	httpServer: Listenable | null | undefined;
	isSourceFile?: (file: string) => boolean;
}): ReturnType<typeof createAiRoutes> {
	const { root, httpServer } = opts;
	const broker = new Broker({ root, setup: resolveSetupCommand(root) });
	const token = newToken();
	const handle = createAiRoutes({ broker, root, token, isSourceFile: opts.isSourceFile });
	let devFile: DevFileHandles | undefined;

	// The lockfile can only be written once we know the port. Vite may
	// already be listening by the time this hook runs (restart), so cover
	// both paths and keep it idempotent.
	const publish = (): void => {
		if (devFile) return;
		const addr = httpServer?.address();
		if (!addr || typeof addr === 'string') return;
		const host = addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
		const bracket = host.includes(':') ? `[${host}]` : host;
		devFile = writeDevFile({
			version: 1,
			pid: process.pid,
			root,
			origin: `http://${bracket}:${addr.port}`,
			token,
			startedAt: Date.now()
		});
	};
	if (httpServer?.listening) publish();
	httpServer?.once('listening', publish);

	const teardown = (): void => {
		devFile?.cleanup();
		devFile = undefined;
		broker.dispose();
	};
	httpServer?.once('close', teardown);
	// A hard exit (Ctrl-C) skips 'close', which would leave a stale lockfile
	// pointing at a dead port with a live token in it.
	process.once('exit', teardown);
	process.once('SIGINT', teardown);
	process.once('SIGTERM', teardown);

	return handle;
}
