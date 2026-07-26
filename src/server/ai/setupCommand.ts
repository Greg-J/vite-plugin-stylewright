// What to actually type to register the MCP server.
//
// The setup screen is the one place a first-time user copies a command verbatim,
// so it has to be a command that works on THEIR machine — not the one that will
// work after the package is published. `npx vite-plugin-stylewright mcp` is
// correct for an installed dependency and a 404 for anyone running from a
// checkout, and a 404 at that moment is indistinguishable from "this tool is
// broken".
//
// So the command is computed at dev-server start from where this code is
// actually running, and shipped to the overlay in the state snapshot.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface SetupCommand {
	/** The full command to register the MCP server. */
	command: string;
	/** True when the short published form is what we recommended. */
	published: boolean;
	/** Absolute path to the bin, for the Cline JSON block. */
	binPath: string | null;
}

/** dist/mcp.js next to this module once built; ../dist/mcp.js when running from src. */
function findBin(): string | null {
	const candidates = [
		fileURLToPath(new URL('./mcp.js', import.meta.url)),
		fileURLToPath(new URL('../mcp.js', import.meta.url)),
		fileURLToPath(new URL('../../dist/mcp.js', import.meta.url)),
		fileURLToPath(new URL('../../../dist/mcp.js', import.meta.url))
	];
	for (const p of candidates) if (existsSync(p)) return p;
	return null;
}

/**
 * Prefer the short form only when it will resolve. `npx <name>` finds a binary
 * in the project's own node_modules/.bin, so an installed dependency gets the
 * nice command; anything else gets an absolute path that cannot 404.
 */
export function resolveSetupCommand(root: string): SetupCommand {
	const binPath = findBin();
	const localBin = join(root, 'node_modules', '.bin', 'vite-plugin-stylewright');
	const installed = existsSync(localBin);

	if (installed) return { command: 'npx vite-plugin-stylewright mcp', published: true, binPath };
	if (binPath) return { command: `node ${binPath} mcp`, published: false, binPath };
	// No built bin at all — say so rather than printing a command that fails.
	return { command: '', published: false, binPath: null };
}
