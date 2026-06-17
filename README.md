# vite-plugin-stylewright

> Edit a Svelte component's CSS live in the browser — and save it straight back into the `.svelte` `<style>` block.

A dev-only Vite plugin. Click an element on the page, tweak its CSS values with live preview, hit save, and the change lands in your component's source. No copy-paste from DevTools, no losing your tweaks on reload.

**Status: early alpha (`0.0.x`).** The core (locate → patch → write-back) is solid and tested; the in-browser overlay is functional and evolving. Feedback and PRs welcome.

## Why

Chrome DevTools can't save CSS edits back to Svelte components. Two structural reasons:

1. **DevTools "save to source" is built for whole-file stylesheets** (a `.css`/`.scss` served as a `<link>`, or one a source map points to as a complete file). A Svelte `<style>` is a *CSS region inside a mixed `.svelte` file* — DevTools has nowhere to write it.
2. **Vite serves all CSS in dev as JavaScript-injected `<style>` blocks** (for HMR), which DevTools treats as read-only for persistence.

Stylewright sidesteps both by owning the round-trip end-to-end: a browser overlay captures the edit, and a dev-server-only endpoint patches the exact declaration back into your `.svelte` source with a real CSS parser.

## Install

```bash
npm i -D vite-plugin-stylewright
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import stylewright from 'vite-plugin-stylewright';

export default defineConfig({
  plugins: [svelte(), stylewright()],
});
```

SvelteKit:

```js
// vite.config.js
import { sveltekit } from '@sveltejs/kit/vite';
import stylewright from 'vite-plugin-stylewright';

export default defineConfig({
  plugins: [sveltekit(), stylewright()],
});
```

That's it. Run your dev server — you'll see a ✎ button in the bottom-right.

## Use

1. Click the **✎** button (bottom-right), then click any element on the page.
2. Stylewright finds the component that element belongs to and lists its `<style>` rules.
3. Edit a value — it previews live.
4. Press Enter / blur the field — the change is written into that component's `.svelte` `<style>`, and Vite HMR repaints from source.

## How it works

- **Which element / which file** — resolved from Svelte's dev source metadata (`__svelte_meta`), the same source-location data the Svelte inspector uses.
- **Which rules** — the dev-server reads the component file, finds the `<style>` block, and parses it with [PostCSS](https://postcss.org/).
- **The write-back** — the matched declaration is updated in the PostCSS tree, stringified, and spliced back into the file with [magic-string](https://github.com/Rich-Harris/magic-string) at exact offsets, so nothing outside the edited declaration moves.
- **Safety** — the write endpoint only exists on the dev server (never in a production build) and refuses any path that isn't a `.svelte` file inside your project root.

## Options

```js
stylewright({
  enabled: true, // master switch (dev-only regardless)
})
```

## Limitations (alpha)

- Targets **Svelte + Vite**. Element→source resolution relies on Svelte dev metadata.
- Edits the **first matching rule** by selector; descendant/complex selectors preview approximately.
- One `<style>` block per component (the common case).
- Preprocessor-authored CSS (`lang="scss"`) is located but written back as the literal source text you edit — value-level edits are fine; structural rewrites are out of scope.

## License

MIT © Greg Johnson
