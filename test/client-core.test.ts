import { describe, it, expect } from 'vitest';
import {
	hsvToRgb, rgbToHex, isColorValue, parseColor, formatColor, normColor, sameColor
} from '../src/client/color.js';
import { tokenize, classify, rankList } from '../src/client/tokenize.js';
import { fromServerRules, serializeRules } from '../src/client/rules.js';
import { isCompleteCss } from '../src/server/patch.js';

describe('color: round-trips', () => {
	for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#808080', '#6d5efc']) {
		it(`hex ${hex} survives parse → format`, () => {
			const c = parseColor(hex);
			expect(c.fmt).toBe('hex');
			expect(formatColor(c.h, c.s, c.v, c.a, c.fmt)).toBe(hex);
		});
	}

	it('preserves rgb() notation and spacing', () => {
		const c = parseColor('rgb(255, 0, 0)');
		expect(c.fmt).toBe('rgb');
		expect(formatColor(c.h, c.s, c.v, c.a, c.fmt)).toBe('rgb(255, 0, 0)');
	});

	it('carries 8-digit hex alpha through', () => {
		const c = parseColor('#ff000080');
		expect(c.a).toBeCloseTo(0.5, 1);
		expect(formatColor(c.h, c.s, c.v, c.a, c.fmt)).toBe('#ff000080');
	});

	it('emits rgba() when alpha < 1', () => {
		const c = parseColor('rgba(255, 0, 0, 0.5)');
		expect(formatColor(c.h, c.s, c.v, c.a, c.fmt)).toBe('rgba(255, 0, 0, 0.5)');
	});

	it('hsvToRgb / rgbToHex agree on primaries', () => {
		expect(rgbToHex(...hsvToRgb(0, 1, 1))).toBe('#ff0000');
		expect(rgbToHex(...hsvToRgb(120, 1, 1))).toBe('#00ff00');
	});
});

describe('color: recognition + equality', () => {
	it('recognizes hex, rgb, hsl, and named', () => {
		expect(isColorValue('#fff')).toBe(true);
		expect(isColorValue('rgba(0,0,0,.5)')).toBe(true);
		expect(isColorValue('hsl(210, 50%, 40%)')).toBe(true);
		expect(isColorValue('red')).toBe(true);
		expect(isColorValue('24px')).toBe(false);
		expect(isColorValue('solid')).toBe(false);
	});

	it('normalizes case + shorthand for equality', () => {
		expect(normColor('#FFF')).toBe('#ffffff');
		expect(sameColor('#fff', '#ffffff')).toBe(true);
		expect(sameColor('#ff0000', 'red')).toBe(true);
	});
});

describe('tokenize + classify', () => {
	it('splits a shorthand into numbers and separators', () => {
		expect(tokenize('8px 14px')).toEqual([
			{ t: 'num', x: '8px' }, { t: 'sep', x: ' ' }, { t: 'num', x: '14px' }
		]);
	});

	it('keeps a function value as one color token', () => {
		expect(tokenize('rgba(0, 0, 0, 0.5)')).toEqual([{ t: 'color', x: 'rgba(0, 0, 0, 0.5)' }]);
	});

	it('mixes number, word, and color in a border', () => {
		expect(tokenize('1px solid #333')).toEqual([
			{ t: 'num', x: '1px' }, { t: 'sep', x: ' ' },
			{ t: 'word', x: 'solid' }, { t: 'sep', x: ' ' },
			{ t: 'color', x: '#333' }
		]);
	});

	it('classifies declarations by property + value', () => {
		expect(classify('color', '#333')).toBe('color');
		expect(classify('font-family', 'Inter')).toBe('font');
		expect(classify('display', 'flex')).toBe('keyword');
		expect(classify('width', '24px')).toBe('number');
		expect(classify('transition', 'all .2s')).toBe('text');
	});

	it('ranks prefix matches ahead of substring matches', () => {
		expect(rankList(['flex-start', 'flex-end', 'center', 'space-between'], 'fl'))
			.toEqual(['flex-start', 'flex-end']);
	});
});

describe('rules model', () => {
	it('adapts wire {prop,value} to editor {p,v}', () => {
		expect(fromServerRules([{ selector: '.btn', decls: [{ prop: 'color', value: '#333' }] }]))
			.toEqual([{ sel: '.btn', decls: [{ p: 'color', v: '#333' }] }]);
	});

	it('serializes to tab-indented CSS, dropping empty declarations', () => {
		const css = serializeRules([
			{ sel: '.btn', decls: [{ p: 'color', v: '#333' }, { p: '', v: '' }, { p: 'padding', v: '8px' }] }
		]);
		expect(css).toContain('.btn {');
		expect(css).toContain('color: #333;');
		expect(css).toContain('padding: 8px;');
		expect(css).not.toContain(': ;');
	});

	it('produces CSS the server accepts as complete', () => {
		const css = serializeRules([
			{ sel: '.card', decls: [{ p: 'background', v: '#eee' }, { p: 'border-radius', v: '12px' }] },
			{ sel: '.card:hover', decls: [{ p: 'box-shadow', v: '0 4px 12px #8f2424' }] }
		]);
		expect(isCompleteCss(css)).toBe(true);
	});
});
