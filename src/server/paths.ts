// Path containment for everything the dev server is willing to read or write.
// One validator, shared by the CSS routes and the AI path — a second one would
// be a second place for a containment bug to hide.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Is `abs` the root itself, or inside it?
 *
 * Case folding only happens where the filesystem actually folds case. Folding
 * everywhere looks safer but is the opposite: on Linux `/srv/App` and `/srv/app`
 * are different directories, and a case-insensitive compare would accept an
 * absolute path into a case-variant SIBLING of the project as "inside" it.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';
const fold = (s: string): string => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

function within(abs: string, root: string): boolean {
	const nRoot = normalize(root);
	const a = fold(abs);
	const r = fold(nRoot.endsWith(sep) ? nRoot : nRoot + sep);
	return a === fold(nRoot) || a.startsWith(r);
}

/**
 * Resolve a client-supplied path to an absolute `.svelte` file that really lives
 * INSIDE the project root. Returns null for anything that escapes.
 *
 * The containment check runs TWICE: once on the lexical path (cheap, catches
 * `..` and absolute paths pointing elsewhere) and again on the fully
 * symlink-resolved path. Lexical normalisation alone is not containment — a
 * symlink sitting inside the root and pointing outside it normalises to an
 * in-root string while `readFile`/`writeFile` happily follow it out. The root
 * is realpath'd too, so a project reached through a symlinked parent (the
 * common `/tmp` -> `/private/tmp` case on macOS) still compares equal.
 */
export function resolveSvelteFile(root: string, file: string): string | null {
	if (!file || typeof file !== 'string') return null;
	// A NUL byte truncates the path at the syscall boundary — reject outright.
	if (file.includes('\0')) return null;

	const abs = normalize(isAbsolute(file) ? file : join(root, file));
	if (!within(abs, root)) return null;
	if (!abs.toLowerCase().endsWith('.svelte')) return null;
	if (!existsSync(abs)) return null;

	// Symlink containment. If either realpath fails, refuse rather than guess.
	let realFile: string;
	let realRoot: string;
	try {
		realFile = realpathSync(abs);
		realRoot = realpathSync(root);
	} catch {
		return null;
	}
	if (!within(realFile, realRoot)) return null;
	// A symlink to a non-.svelte file would otherwise slip through on the name.
	if (!realFile.toLowerCase().endsWith('.svelte')) return null;

	return abs;
}
