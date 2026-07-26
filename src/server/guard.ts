// Request guards for the /__stylewright/* API.
//
// Threat model. The dev server listens on the developer's machine and its API
// writes to their source tree. Two attackers matter:
//
//  1. Any web page the developer happens to have open. It cannot read our
//     responses (no CORS headers), but a write-only request is damage enough:
//     POST /apply rewrites a .svelte file. Blocked by the Origin check plus a
//     custom header that no <form> or simple cross-origin request can set.
//  2. DNS rebinding — evil.com re-resolved to 127.0.0.1, which makes the
//     attacker's page same-origin with the dev server and defeats (1). Blocked
//     by only accepting Host values that are IP literals or *.localhost, so a
//     registered domain never reaches the API however it resolves.
//
// `vite --host` (testing on a phone) stays working: that arrives with an IP
// literal Host, which is allowed.

import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** Strip the port and IPv6 brackets from a Host/authority value. */
function hostname(authority: string): string {
	const h = authority.trim().toLowerCase();
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		return end > 0 ? h.slice(1, end) : '';
	}
	const i = h.lastIndexOf(':');
	// Only strip the colon when what follows is a port (bare IPv6 has many colons).
	return i > 0 && /^\d+$/.test(h.slice(i + 1)) ? h.slice(0, i) : h;
}

function isIpLiteral(h: string): boolean {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;              // IPv4
	// IPv6, including the IPv4-mapped form (::ffff:127.0.0.1), which is what a
	// dual-stack bind can put in the Host header. Dots are allowed here only
	// because a colon is also required — a registered domain can never contain
	// one, so "face.fade" still falls through to the IPv4 test and is refused.
	return /^[0-9a-f:.]+$/.test(h) && h.includes(':');
}

/** Loopback by socket address — used for the MCP-facing routes, which are only
 *  ever called by a process on this machine. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
	if (!addr) return false;
	return LOOPBACK.has(addr.toLowerCase());
}

/**
 * Reject Host values that could be an attacker-controlled domain pointed at
 * this machine. IP literals and localhost are fine; `evil.com` is not, even if
 * it currently resolves to 127.0.0.1.
 */
export function isSafeHost(authority: string | undefined): boolean {
	if (!authority) return false;
	const h = hostname(authority);
	if (!h) return false;
	return h === 'localhost' || h.endsWith('.localhost') || isIpLiteral(h);
}

/** True when `origin` denotes the same authority the request was addressed to. */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
	if (!origin || !hostHeader) return false;
	try {
		const u = new URL(origin);
		return u.host.toLowerCase() === hostHeader.trim().toLowerCase();
	} catch {
		return false;
	}
}

export interface GuardResult {
	ok: boolean;
	status?: number;
	reason?: string;
}

/**
 * Gate for the browser-facing API. `mutating` requests (anything that is not a
 * plain GET) additionally require a same-origin Origin and the overlay's custom
 * header — neither of which a cross-site <form> or a no-preflight request can
 * produce.
 */
export function guardBrowserRequest(req: Connect.IncomingMessage, mutating: boolean): GuardResult {
	const host = req.headers.host;
	if (!isSafeHost(host)) return { ok: false, status: 403, reason: 'bad_host' };

	const origin = req.headers.origin as string | undefined;
	// A present Origin must match, always — that covers cross-origin GETs too.
	if (origin && !isSameOrigin(origin, host)) return { ok: false, status: 403, reason: 'bad_origin' };

	if (mutating) {
		// A write must positively identify itself as same-origin. Origin is set by
		// the browser and a page cannot forge it; Referer is the fallback for the
		// handful of cases a browser omits Origin on a same-origin POST.
		const src = origin || (req.headers.referer as string | undefined);
		if (!src) return { ok: false, status: 403, reason: 'no_origin' };
		if (!isSameOrigin(src, host)) return { ok: false, status: 403, reason: 'bad_origin' };

		// Two independent barriers, because either alone has a known gap. The custom
		// header cannot be set by a cross-site <form> or any no-preflight request;
		// requiring JSON forces anything else into a CORS preflight the browser
		// blocks. A `text/plain` form POST clears neither.
		if (req.headers['x-stylewright'] !== '1') return { ok: false, status: 403, reason: 'missing_client_header' };
		const ct = String(req.headers['content-type'] || '').toLowerCase();
		if (!ct.includes('application/json')) return { ok: false, status: 403, reason: 'bad_content_type' };
	}
	return { ok: true };
}

/**
 * Gate for the MCP-facing routes. These are called by a local agent process, not
 * a browser: require loopback plus the shared secret from dev.json. Compared
 * with a length-independent constant-time walk so a wrong token leaks nothing.
 */
export function guardAgentRequest(req: Connect.IncomingMessage, token: string): GuardResult {
	if (!isLoopbackAddress(req.socket?.remoteAddress)) return { ok: false, status: 403, reason: 'not_loopback' };
	// A DNS-rebound page IS loopback, so the socket check alone does not cover it —
	// apply the same Host rule the browser surface gets.
	if (!isSafeHost(req.headers.host)) return { ok: false, status: 403, reason: 'bad_host' };
	// An MCP process never sends Origin. A browser always does on a cross-origin
	// request, so its presence here means the caller is a page, not an agent.
	if (req.headers.origin) return { ok: false, status: 403, reason: 'browser_origin' };
	const auth = String(req.headers.authorization || '');
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-stylewright-token'] || '');
	if (!token || !timingSafeEqual(presented, token)) return { ok: false, status: 401, reason: 'bad_token' };
	return { ok: true };
}

/** Constant-time compare that does not leak the token through early exit.
 *  Both sides are hashed first so the comparison length is fixed regardless of
 *  what the caller presented — `crypto.timingSafeEqual` throws on a length
 *  mismatch, which would itself be an oracle. */
export function timingSafeEqual(a: string, b: string): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const ha = createHash('sha256').update(a).digest();
	const hb = createHash('sha256').update(b).digest();
	return nodeTimingSafeEqual(ha, hb);
}

export function refuse(res: ServerResponse, g: GuardResult): void {
	res.statusCode = g.status || 403;
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify({ ok: false, error: g.reason || 'refused' }));
}
