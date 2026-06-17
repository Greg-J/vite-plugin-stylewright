# vite-plugin-stylewright

> Edit a Svelte component's CSS live in the browser — and save it straight back into the `.svelte` `<style>` block.

A dev-only Vite plugin. Click an element on the page, tweak its CSS with live preview, hit save, and the change lands in your component's source. No copy-pasting out of DevTools, no losing your tweaks on reload.

```
  ✎  pick an element  →  edit its <style> rules  →  save  →  written to source + HMR
```

**Status:** early alpha (`0.0.x`). The core round-trip is solid and unit-tested; the browser overlay is functional and evolving. Issues and PRs welcome.

---

## Why this doesn't already exist

Chrome DevTools can't save CSS edits back to Svelte components, for two structural reasons:

1. **DevTools "save to source" is built for whole-file stylesheets** — a `.css`/`.scss` served as a `<link>`, or one a source map points to as a complete file. A Svelte `<style>` is a *CSS region embedded inside a mixed `.svelte` file*; DevTools has nowhere to write it.
2. **Vite serves all CSS in dev as JavaScript-injected `<style>` blocks** (for HMR), which DevTools treats as read-only for persistence.

Stylewright owns the round-trip end-to-end instead: a browser overlay captures the edit, and a **dev-server-only** endpoint patches the exact declaration back into your `.svelte` source with a real CSS parser — so nothing but the bytes you changed ever move.

## Install

```bash
npm i -D vite-plugin-stylewright
```

```js
// vite.config.js  (plain Svelte + Vite)
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import stylewright from 'vite-plugin-stylewright';

export default defineConfig({
  plugins: [svelte(), stylewright()],
});
```

```js
// vite.config.js  (SvelteKit)
import { sveltekit } from '@sveltejs/kit/vite';
import stylewright from 'vite-plugin-stylewright';

export default defineConfig({
  plugins: [sveltekit(), stylewright()],
});
```

Run your dev server — a **✎** button appears bottom-right.

## Use

1. Click **✎**, then click any element on the page.
2. Stylewright finds the component that element belongs to and lists its `<style>` rules.
3. Edit a value — it previews live.
4. Press **Enter** (or blur the field) — the value is written into that component's `.svelte` `<style>`, and Vite HMR repaints from source.

## Try it in 30 seconds

A runnable Svelte 5 demo lives in [`playground/`](./playground):

```bash
git clone https://github.com/Greg-J/vite-plugin-stylewright
cd vite-plugin-stylewright
npm install && npm run build
cd playground && npm install && npm run dev
```

Open the printed URL, click **✎**, click the button or card, and edit away. Watch `playground/src/lib/*.svelte` change on disk as you save.

## How it works

| Step | Mechanism |
|------|-----------|
| **Which element / which file** | Svelte dev source metadata (`__svelte_meta`) — the same source-location data the Svelte inspector uses. |
| **Which rules** | The dev server reads the component, locates its `<style>` block, and parses it with [PostCSS](https://postcss.org/). |
| **The write-back** | The matched declaration is updated in the PostCSS tree, stringified, and spliced back at exact offsets with [magic-string](https://github.com/Rich-Harris/magic-string) — surrounding markup, script, and other CSS are untouched. |
| **Safety** | The write endpoint exists only on the dev server (never in a production build) and refuses any path that isn't a `.svelte` file inside your project root. |

## Options

```js
stylewright({
  enabled: true, // master switch (dev-only regardless)
})
```

## Limitations (alpha)

- Targets **Svelte + Vite**. Element→source resolution relies on Svelte dev metadata.
- Edits the **first rule** matching a selector; descendant/complex selectors preview approximately.
- One `<style>` block per component (the common case).
- Preprocessor CSS (`lang="scss"`) is located and value-edits work, but structural rewrites are out of scope.

## Roadmap

- Preprocessor-based element stamping as a fallback when `__svelte_meta` is unavailable.
- Add/remove declarations and rules from the overlay.
- Color pickers and unit steppers for common properties.
- Multi-`<style>` and nested-rule support.

## Contributing

```bash
npm install
npm run build      # tsup -> dist (plugin + client overlay)
npm test           # vitest (the patch/locate core)
npm run typecheck
```

PRs and issues welcome — this is meant to be a community tool.

## License

MIT © Greg Johnson
