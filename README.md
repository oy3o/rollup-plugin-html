# @oy3o/rollup-plugin-html

[![npm version](https://img.shields.io/npm/v/@oy3o/rollup-plugin-html.svg)](https://www.npmjs.com/package/@oy3o/rollup-plugin-html)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Rollup plugin to process HTML files as entry points. It extracts JS modules (`<script type="module">`), transforms inline CSS (`<style>`) using LightningCSS, minifies inline classic scripts using Terser, and updates the HTML to reference the final Rollup-generated JS bundles.

## Installation

```bash
npm install -D @oy3o/rollup-plugin-html rollup
# or
yarn add -D @oy3o/rollup-plugin-html rollup
# or
pnpm add -D @oy3o/rollup-plugin-html rollup
```

You also need to have `rollup` installed as a peer dependency.

## Usage

In your `rollup.config.js`:

```javascript
import html from '@oy3o/rollup-plugin-html';
import { nodeResolve } from '@rollup/plugin-node-resolve';
// Add other plugins as needed (e.g., @rollup/plugin-commonjs, @rollup/plugin-babel)

export default {
  input: {
    'index.html': 'src/index.html'
  },
  output: {
    dir: 'dist',
    format: 'es', // ES module format is generally recommended
  },
  plugins: [
    // Your other plugins (resolve, commonjs, babel, etc.) often go first
    nodeResolve(),
    // Add the html plugin
    html({
      // Plugin options (see below)
      preserveStructure: true,
      removeComments: true,
      compressWhitespace: false, // Be cautious with this one
      lightningcss: { ... }, // Override default LightningCSS options
      terser: { ... },      // Override default Terser options for inline scripts
    }),
  ]
};
```

The plugin will:

1.  Find HTML files specified in `input`.
2.  Parse the HTML.
3.  Find `<script type="module" src="local.js">` and inline `<script type="module">...</script>`. These become Rollup entry points.
4.  Process `<style>` tags with LightningCSS (minify, autoprefix, etc.).
5.  Minify inline `<script>` (non-module) tags with Terser.
6.  Remove HTML comments (optional).
7.  Compress whitespace (optional, experimental).
8.  After Rollup bundles the JavaScript, update the `<script type="module">` tags (or placeholders for inline modules) in the HTML to point to the correct output chunk files (e.g., `dist/assets/index-a1b2c3d4.js`).
9.  Emit the processed HTML file(s) to the output directory (`dist` in the example).

## Options

*   **`include`**: `string | string[]` (Default: `'**/*.html'`)
    Glob pattern(s) specifying which files to process.
*   **`exclude`**: `string | string[]` (Default: `undefined`)
    Glob pattern(s) specifying which files to ignore.
*   **`preserveStructure`**: `boolean` (Default: `true`)
    If `true`, maintains the relative path structure from the input HTML file to the output directory. If `false`, outputs all HTML files directly into the output directory root (can cause name collisions). Ignored if `input` is an object.
*   **`removeComments`**: `boolean` (Default: `true`)
    Removes HTML comments (`<!-- ... -->`).
*   **`compressWhitespace`**: `boolean` (Default: `false`)
    *Experimental:* Aggressively collapses whitespace in text nodes. Can break formatting in some cases. Use with caution.
*   **`lightningcss`**: `object` (Default: `{ minify: true, targets: browserslistToTargets(browserslist('>= 0.5%')) }`)
    Options passed directly to [LightningCSS `transform`](https://lightningcss.dev/docs.html#transform). Set `minify: false` to disable CSS minification.
*   **`terser`**: `object` (Default: `{ sourceMap: false, mangle: true, compress: true }`)
    Options passed directly to [Terser `minify`](https://terser.org/docs/api-reference#minify-options) for minifying *inline, non-module* `<script>` tags. Set `compress: false` or `mangle: false` to disable those steps.

## License

[MIT](LICENSE)