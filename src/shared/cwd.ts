// Shared between the broker and the MCP process, so both agree on when a
// working directory actually tells us something.

/**
 * Does this cwd identify a location?
 *
 * Editors disagree about where to spawn an MCP server: Claude Code runs it in
 * the project, Cline runs it at "/". A filesystem root identifies nothing and is
 * an ancestor of everything, which breaks three things at once — the session
 * name derived from it is meaningless ("session", "session-2"), the
 * same-project check reads as "different project" for the user's only session,
 * and discovery's "closest containing root" heuristic matches every dev server
 * on the machine and picks by path length.
 */
export function usefulCwd(cwd: string): boolean {
	const c = (cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
	if (!c) return false;
	if (c === '/') return false;
	if (/^[a-z]:$/i.test(c)) return false;      // a bare Windows drive
	return true;
}
