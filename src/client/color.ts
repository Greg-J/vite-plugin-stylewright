// Color math, lifted verbatim from the design prototype (HSV-based picker model).
// Pure — no DOM. parseColor/formatColor preserve the author's notation (hex vs rgb).

import { NAMED } from './data';

export type ColorFmt = 'hex' | 'rgb' | 'hsl';
export interface Hsva { h: number; s: number; v: number; a: number; fmt: ColorFmt; }

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	h = (h % 360) / 360;
	let i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
	let r: number, g: number, b: number;
	switch (i % 6) {
		case 0: r = v; g = t; b = p; break;
		case 1: r = q; g = v; b = p; break;
		case 2: r = p; g = v; b = t; break;
		case 3: r = p; g = q; b = v; break;
		case 4: r = t; g = p; b = v; break;
		default: r = v; g = p; b = q;
	}
	return [r * 255, g * 255, b * 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
	const t = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
	return '#' + t(r) + t(g) + t(b);
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	r /= 255; g /= 255; b /= 255;
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
	let H = 0;
	if (d) {
		if (mx === r) H = ((g - b) / d) % 6;
		else if (mx === g) H = (b - r) / d + 2;
		else H = (r - g) / d + 4;
		H *= 60; if (H < 0) H += 360;
	}
	return { h: H, s: mx ? d / mx : 0, v: mx };
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
	let h = hex.replace('#', '');
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	return rgbToHsv(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

export function isColorValue(v: string): boolean {
	return /^#([0-9a-f]{3,8})$/i.test(v) || /^(rgba?|hsla?)\(/i.test(v) || !!NAMED[v];
}

export function parseColor(str: string): Hsva {
	str = (str || '').trim();
	let r = 0, g = 0, b = 0, a = 1;
	let fmt: ColorFmt = 'hex';
	if (NAMED[str]) str = NAMED[str];
	if (str[0] === '#') {
		let hx = str.slice(1);
		if (hx.length === 3 || hx.length === 4) hx = hx.split('').map((c) => c + c).join('');
		r = parseInt(hx.slice(0, 2), 16) || 0;
		g = parseInt(hx.slice(2, 4), 16) || 0;
		b = parseInt(hx.slice(4, 6), 16) || 0;
		a = hx.length >= 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1;
		fmt = 'hex';
	} else {
		const m = str.match(/^(rgba?|hsla?)\(([^)]*)\)/i);
		if (m) {
			const p = m[2].split(/[,\/\s]+/).filter((x) => x !== '');
			if (/^hsl/i.test(m[1])) {
				const H = parseFloat(p[0]) || 0, S = (parseFloat(p[1]) || 0) / 100, L = (parseFloat(p[2]) || 0) / 100;
				const cc = (1 - Math.abs(2 * L - 1)) * S, x = cc * (1 - Math.abs((((H % 360) / 60) % 2) - 1)), mm = L - cc / 2;
				const hh = ((H % 360) + 360) % 360;
				let rr = 0, gg = 0, bb = 0;
				if (hh < 60) { rr = cc; gg = x; }
				else if (hh < 120) { rr = x; gg = cc; }
				else if (hh < 180) { gg = cc; bb = x; }
				else if (hh < 240) { gg = x; bb = cc; }
				else if (hh < 300) { rr = cc; bb = x; }
				else { rr = cc; bb = x; }
				r = (rr + mm) * 255; g = (gg + mm) * 255; b = (bb + mm) * 255;
			} else {
				r = parseFloat(p[0]) || 0; g = parseFloat(p[1]) || 0; b = parseFloat(p[2]) || 0;
			}
			const av = p[3];
			if (av != null) a = av.indexOf('%') >= 0 ? parseFloat(av) / 100 : parseFloat(av);
			if (isNaN(a)) a = 1;
			fmt = /^hsl/i.test(m[1]) ? 'hsl' : 'rgb'; // preserve the author's notation
		}
	}
	const hsv = rgbToHsv(r, g, b);
	return { h: hsv.h, s: hsv.s, v: hsv.v, a, fmt };
}

export function formatColor(h: number, s: number, v: number, a: number | null, fmt: ColorFmt): string {
	const [r, g, b] = hsvToRgb(h, s, v);
	const R = Math.round(r), G = Math.round(g), B = Math.round(b);
	const alpha = Math.max(0, Math.min(1, a == null ? 1 : a));
	if (fmt === 'rgb') {
		return alpha >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${Math.round(alpha * 100) / 100})`;
	}
	if (fmt === 'hsl') {
		const L = v * (1 - s / 2);
		const sl = L === 0 || L === 1 ? 0 : (v - L) / Math.min(L, 1 - L);
		const H = Math.round(((h % 360) + 360) % 360), S = Math.round(sl * 100), Lp = Math.round(L * 100);
		return alpha >= 1 ? `hsl(${H}, ${S}%, ${Lp}%)` : `hsla(${H}, ${S}%, ${Lp}%, ${Math.round(alpha * 100) / 100})`;
	}
	const hx = rgbToHex(R, G, B);
	if (alpha >= 1) return hx;
	return hx + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/** Canonical hex form (alpha-included) for equality checks. */
export function normColor(v: string): string {
	try {
		const c = parseColor(v);
		return formatColor(c.h, c.s, c.v, c.a == null ? 1 : c.a, 'hex');
	} catch {
		return (v || '').toLowerCase();
	}
}

export function sameColor(a: string, b: string): boolean {
	return normColor(a) === normColor(b);
}

/** Checkerboard-behind-color swatch, so alpha reads correctly. */
export function swatchStyle(v: string): Record<string, string> {
	return {
		backgroundColor: '#2a2a30',
		backgroundImage: `linear-gradient(${v},${v}),linear-gradient(45deg,#43434c 25%,transparent 25%),linear-gradient(-45deg,#43434c 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#43434c 75%),linear-gradient(-45deg,transparent 75%,#43434c 75%)`,
		backgroundSize: '100% 100%,8px 8px,8px 8px,8px 8px,8px 8px',
		backgroundPosition: '0 0,0 0,0 4px,4px -4px,-4px 0'
	};
}

export function alphaTrackStyle(opaque: string): Record<string, string> {
	return {
		backgroundColor: '#2a2a30',
		backgroundImage: `linear-gradient(to right,transparent,${opaque}),linear-gradient(45deg,#43434c 25%,transparent 25%),linear-gradient(-45deg,#43434c 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#43434c 75%),linear-gradient(-45deg,transparent 75%,#43434c 75%)`,
		backgroundSize: '100% 100%,8px 8px,8px 8px,8px 8px,8px 8px',
		backgroundPosition: '0 0,0 0,0 4px,4px -4px,-4px 0'
	};
}
