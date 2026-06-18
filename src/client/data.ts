// Static data lists, lifted verbatim from the design prototype. Drive the
// property type-ahead, keyword dropdowns, color recognition, and the font menu.

export const PROPS = [
	'align-items', 'align-self', 'aspect-ratio', 'background', 'background-color', 'border',
	'border-color', 'border-radius', 'box-shadow', 'color', 'cursor', 'display', 'flex',
	'flex-direction', 'flex-wrap', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
	'gap', 'grid-template-columns', 'height', 'inset', 'justify-content', 'letter-spacing',
	'line-height', 'margin', 'max-width', 'min-width', 'object-fit', 'opacity', 'outline',
	'overflow', 'padding', 'position', 'text-align', 'text-decoration', 'text-transform',
	'text-wrap', 'transform', 'transition', 'white-space', 'width', 'z-index'
];

/** Properties whose value is a color — committing one opens the picker. */
export const COLORISH = [
	'color', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke',
	'caret-color', 'text-decoration-color'
];

/** Properties with a known keyword set — get a ▾ dropdown. */
export const KEYWORDS: Record<string, string[]> = {
	display: ['flex', 'grid', 'block', 'inline-block', 'inline-flex', 'none', 'contents'],
	'flex-direction': ['row', 'column', 'row-reverse', 'column-reverse'],
	'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
	'align-items': ['stretch', 'center', 'flex-start', 'flex-end', 'baseline'],
	position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
	'text-align': ['left', 'center', 'right', 'justify'],
	cursor: ['pointer', 'default', 'text', 'move', 'not-allowed', 'grab'],
	'font-weight': ['400', '500', '600', '700', '800'],
	overflow: ['visible', 'hidden', 'auto', 'scroll']
};

export const COLOR_PRESETS = [
	'#6d5efc', '#8b7cf6', '#ec4899', '#f97316', '#f59e0b', '#10b981',
	'#0ea5e9', '#1d1b27', '#ffffff', '#f3f1ec', '#94a3b8', '#ef4444'
];

export const SYSTEM_FONTS: { label: string; value: string }[] = [
	{ label: 'system-ui', value: 'system-ui' },
	{ label: 'San Francisco / Segoe', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
	{ label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
	{ label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
	{ label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
	{ label: 'Times', value: '"Times New Roman", Times, serif' },
	{ label: 'Courier', value: '"Courier New", Courier, monospace' },
	{ label: 'Monospace', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
];

/** Families considered "system" — filtered OUT of the "on this page" font list. */
export const SYS_FAMILIES = [
	'system-ui', 'ui-sans-serif', 'ui-monospace', 'ui-serif', '-apple-system', 'blinkmacsystemfont',
	'segoe ui', 'roboto', 'helvetica', 'arial', 'sans-serif', 'serif', 'monospace',
	'times new roman', 'times', 'courier new', 'courier', 'georgia', 'menlo', 'sfmono-regular'
];

/** Minimal named-color map (the picker resolves the rest). */
export const NAMED: Record<string, string> = {
	white: '#ffffff',
	black: '#000000',
	transparent: '#00000000',
	red: '#ff0000',
	blue: '#0000ff'
};
