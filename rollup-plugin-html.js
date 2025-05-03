/**
 * @oy3o/rollup-plugin-html Main File
 *
 * Processes HTML files as Rollup entry points. Extracts JS modules,
 * transforms HTML/CSS, and updates HTML with final JS bundle references.
 */

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

import { createFilter } from '@rollup/pluginutils'
import { parse, serialize } from 'parse5'
import { transform as lightningTransform, browserslistToTargets } from 'lightningcss'
import { minify as terserMinify } from 'terser'
import browserslist from 'browserslist'

/**
 * Recursively find AST nodes matching a predicate.
 * @param {object} node Current AST node.
 * @param {function} predicate Condition function.
 * @param {Array} [results=[]] Results array (internal).
 * @returns {Array} Array of matching nodes.
 */
function findNodes(node, predicate, results = []) {
    if (predicate(node)) {
        results.push(node)
    }
    if (node.childNodes) {
        for (const child of node.childNodes) {
            findNodes(child, predicate, results)
        }
    }
    // Handle <template> content separately
    if (node.nodeName === 'template' && node.content?.childNodes) {
        for (const child of node.content.childNodes) {
            findNodes(child, predicate, results)
        }
    }
    return results
}

/**
 * Get text content of a node (mainly for <style>, <script>).
 * @param {object} node AST node.
 * @returns {string} Text content.
 */
function getTextContent(node) {
    if (node.childNodes?.[0]?.nodeName === '#text') {
        return node.childNodes[0].value || ''
    }
    return ''
}

/**
 * Set text content of a node.
 * @param {object} node AST node to modify.
 * @param {string} text Text to set.
 */
function setTextContent(node, text) {
    if (!node.childNodes) node.childNodes = []
    if (node.childNodes.length > 0 && node.childNodes[0].nodeName === '#text') {
        node.childNodes[0].value = text
    } else {
        // Insert new text node at the beginning
        node.childNodes.unshift({ nodeName: '#text', value: text, parentNode: node })
    }
}

// --- Constants ---
const NOOP_IMPORT_ID = '\0oy3o-rollup-plugin-htmlplugin:noop' // Virtual entry ID for no JS modules
const INLINE_MODULE_PREFIX = '\0oy3o-rollup-plugin-html-inline:' // Prefix for inline script virtual module IDs

/**
 * @typedef {object} PluginOptions Plugin configuration options.
 * @property {string|string[]} [include='**\/*.html'] Glob pattern(s) for HTML files.
 * @property {string|string[]} [exclude] Glob pattern(s) to exclude.
 * @property {boolean} [preserveStructure=true] Preserve HTML path structure in output.
 * @property {boolean} [removeComments=true] Remove HTML comments.
 * @property {boolean} [compressWhitespace=false] Compress HTML whitespace (experimental).
 * @property {object} [lightningcss] Options for LightningCSS.
 * @property {object} [terser] Options for Terser (for non-module inline scripts).
 */

/**
 * HTML processor Rollup plugin factory.
 * @param {PluginOptions} [options={}] Plugin options.
 * @returns {object} Rollup plugin object.
 */
export default function RollupPlugin(options = {}) {
    const filter = createFilter(options.include || '**/*.html', options.exclude)

    const config = {
        preserveStructure: options.preserveStructure === true,
        removeComments: options.removeComments !== false,
        compressWhitespace: options.compressWhitespace || false,
        lightningcss: {
            minify: true,
            targets: browserslistToTargets(browserslist('>= 0.5%')), // Default targets
            ...(options.lightningcss || {})
        },
        terser: {
            sourceMap: false,
            mangle: true,
            compress: true,
            ...(options.terser || {})
        },
    }

    /** @type {Map<string, { src: string, dest: string, ast: object, inlineModules: { virtualId: string, code: string, value: string }[] }>} */
    let htmlData = new Map() // Stores processed HTML data (key: absolute path)
    let isWithDest = false // Flag if original Rollup input was an object

    return {
        name: '@oy3o/rollup-plugin-html',

        /**
         * Rollup `options` hook. Normalizes input, processes HTML, extracts JS,
         * updates Rollup input config.
         * @param {object} rollupOptions Original options.
         * @returns {object | null} Modified options or null.
         */
        options(rollupOptions) {
            htmlData = new Map() // Reset state for each build
            const originalInput = rollupOptions.input
            let normalizedInput = {}
            isWithDest = false

            // --- 1. Normalize Input to Object Format ---
            if (typeof originalInput === 'string') {
                normalizedInput = { [originalInput]: originalInput }
            } else if (Array.isArray(originalInput)) {
                normalizedInput = {}
                originalInput.forEach(entry => { if (typeof entry === 'string') normalizedInput[entry] = entry })
            } else if (typeof originalInput === 'object' && originalInput !== null) {
                normalizedInput = { ...originalInput }
                isWithDest = true
            } else if (originalInput) {
                console.warn(`[@oy3o/rollup-plugin-html] Unsupported input type: ${typeof originalInput}. Ignored.`)
                normalizedInput = {}
            } else {
                normalizedInput = {} // Handle null/undefined
            }

            // --- 2. Filter HTML Entries ---
            const Html = [] // { dest, src }
            const nonHtml = {}
            for (const [dest, src] of Object.entries(normalizedInput)) {
                if (typeof src === 'string' && filter(src)) {
                    Html.push({ dest, src })
                } else {
                    // Keep non-HTML entries (JS files, non-string values)
                    nonHtml[dest] = src
                }
            }

            if (Html.length === 0) {
                // No HTML files matched, return original options if other entries exist
                return Object.keys(nonHtml).length > 0 ? rollupOptions : null
            }

            // --- 3. Process HTML Files ---
            const rollupHtml = new Set() // Stores all JS entry points (absolute paths or virtual IDs)
            const processed = new Set() // Track processed absolute HTML paths to avoid duplicates

            Html.forEach(({ dest, src }) => {
                const absolutePath = path.resolve(src)
                if (processed.has(absolutePath)) {
                    console.warn(`[@oy3o/rollup-plugin-html] HTML file resolved to the same path (${absolutePath}) processed multiple times (Input key: "${dest}", value: "${src}"). Skipping duplicate.`)
                    return
                }
                processed.add(absolutePath)

                try {
                    const dir = path.dirname(absolutePath)
                    const html = fs.readFileSync(absolutePath, 'utf-8')
                    const ast = parse(html, { sourceCodeLocationInfo: true }) // Keep location info for errors
                    const inlineModules = [] // { virtualId, code, value }

                    // --- 3a. Traverse and Transform AST ---
                    const traverse = (node) => {
                        // Remove comments
                        if (node.nodeName === '#comment') {
                            return config.removeComments ? null : node
                        }

                        // Process <style> tags with LightningCSS
                        if (node.nodeName === 'style' && config.lightningcss.minify !== false) {
                            const css = getTextContent(node)
                            if (!css) return null // Remove empty style tags
                            try {
                                const { code } = lightningTransform({
                                    filename: absolutePath, // For sourcemaps/errors
                                    code: Buffer.from(css),
                                    ...config.lightningcss
                                })
                                setTextContent(node, code.toString())
                            } catch (e) {
                                console.error(`[@oy3o/rollup-plugin-html] LightningCSS error in inline style (${src}): ${e}`)
                                // Keep original style on error
                            }
                        }

                        // Process <script> tags
                        if (node.nodeName === 'script') {
                            const type = node.attrs?.find(attr => attr.name === 'type')?.value
                            const src = node.attrs?.find(attr => attr.name === 'src')?.value
                            const isModule = type === 'module'

                            // External <script src="..."> (local files only)
                            if (src && !src.value.includes('://')) {
                                rollupHtml.add(path.resolve(dir, src.value))
                                return node // Keep node path updated later
                            }

                            // Other scripts (inline non-module, external non-module, external module URL)
                            const code = getTextContent(node)
                            if (!src && !code.trim()) return null // Remove empty inline non-module

                            // Inline <script type="module">
                            if (isModule && !src) {
                                // Create virtual module
                                const virtualId = `${INLINE_MODULE_PREFIX}${src}?index=${inlineModules.length}`
                                rollupHtml.add(virtualId)
                                const value = `__HTML_MODULE_PLACEHOLDER_${virtualId}__`
                                inlineModules.push({ virtualId, code, value })
                                // Replace with placeholder comment
                                return { nodeName: '#comment', value, parentNode: node.parentNode }
                            }

                            return node // Keep node non-modules processed later
                        }

                        // Compress whitespace in text nodes (basic implementation)
                        if (node.nodeName === '#text' && config.compressWhitespace) {
                            const parent = node.parentNode
                            // Avoid compressing inside sensitive tags
                            if (parent && !['pre', 'textarea', 'script', 'style'].includes(parent.nodeName)) {
                                let compressed = node.value.replace(/\s+/g, ' ')
                                // Trim whitespace potentially adjacent to block elements
                                if (parent.childNodes.length > 1) {
                                    if (parent.childNodes[0] === node) compressed = compressed.trimStart()
                                    if (parent.childNodes[parent.childNodes.length - 1] === node) compressed = compressed.trimEnd()
                                } else {
                                    compressed = compressed.trim() // Trim if it's the only child
                                }
                                if (!compressed) return null // Remove node if whitespace collapsed to nothing
                                node.value = compressed
                            }
                        }

                        // Recurse through children, filtering out nulls (removed nodes)
                        if (node.childNodes) {
                            node.childNodes = node.childNodes.map(child => traverse(child)).filter(Boolean)
                            // Ensure parentNode refs are updated after filtering/replacement
                            node.childNodes.forEach(child => { if (typeof child === 'object' && child !== null) child.parentNode = node })
                        }
                        // Recurse through <template> content
                        if (node.nodeName === 'template' && node.content?.childNodes) {
                            node.content.childNodes = node.content.childNodes.map(child => traverse(child)).filter(Boolean)
                            node.content.childNodes.forEach(child => { if (typeof child === 'object' && child !== null) child.parentNode = node.content })
                        }
                        return node // Return the (potentially modified) node
                    }

                    // Start traversal from the root
                    const traversed = traverse(ast)
                    if (!traversed || !traversed.childNodes || traversed.childNodes.length === 0) {
                        console.warn(`[@oy3o/rollup-plugin-html] Document became empty after processing ${src}.`)
                        return // Skip storing data for empty AST
                    }

                    // --- 3b. Store Processed Data ---
                    htmlData.set(absolutePath, {
                        src,                // Original input value (e.g., 'src/index.html')
                        dest,               // Original input key (e.g., 'index.html')
                        ast: traversed,     // Modified AST
                        inlineModules,
                    })

                } catch (e) {
                    // Catch errors during file reading or parsing
                    this.error(`Error processing HTML file ${src}: ${e}`)
                }
            }) // end forEach htmlEntry

            // --- 4. Build Final Rollup Input Config ---
            const rollups = { ...nonHtml } // Start with non-HTML entries
            rollupHtml.forEach(entry => {
                // Generate a unique but somewhat readable key for Rollup's input object
                const hash = crypto.createHash('sha256').update(entry).digest('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
                let keyBase = path.basename(entry.startsWith(INLINE_MODULE_PREFIX)
                    ? entry.split(':')[1].split('?')[0] // Inline: use html file name
                    : entry) // External: use js file name
                keyBase = keyBase.replace(/[^a-zA-Z0-9_.-]/g, '_') // Sanitize filename chars
                const key = `${keyBase}_${hash}`

                // Handle unlikely hash collision with a fallback
                if (rollups.hasOwnProperty(key)) {
                    console.warn(`[@oy3o/rollup-plugin-html] Input key collision: "${key}". Using fallback.`)
                    rollups[`${key}_${Date.now()}`] = entry
                } else {
                    rollups[key] = entry
                }
            })

            // Handle case: HTML files processed, but no JS modules found, and no other inputs
            if (Object.keys(rollups).length === 0 && Html.length > 0) {
                console.warn('[@oy3o/rollup-plugin-html] No JS modules found in HTML and no other inputs. Adding NOOP entry.')
                rollups['_html_noop_entry'] = NOOP_IMPORT_ID // Add virtual entry to prevent Rollup error
            }

            // If still no inputs, warn and return empty input object
            if (Object.keys(rollups).length === 0) {
                console.warn('[@oy3o/rollup-plugin-html] No valid inputs after processing.')
                return { ...rollupOptions, input: {} }
            }

            // --- 5. Return Modified Rollup Options ---
            // console.log('[@oy3o/rollup-plugin-html] Final input for Rollup:', rollups)
            return { ...rollupOptions, input: rollups }
        },

        /**
         * Rollup `resolveId` hook. Handles the plugin's virtual module IDs.
         * @param {string} id Module ID to resolve.
         * @returns {string | null} Resolved ID or null to delegate.
         */
        resolveId(id) {
            if (id === NOOP_IMPORT_ID || id.startsWith(INLINE_MODULE_PREFIX)) {
                return id // It's one of ours
            }
            return null // Let Rollup handle others
        },

        /**
         * Rollup `load` hook. Provides content for virtual modules.
         * @param {string} id Module ID to load.
         * @returns {string | null} Module content or null.
         */
        load(id) {
            if (id === NOOP_IMPORT_ID) {
                return '/* Rollup Plugin HTML: NOOP */' // Minimal content for NOOP
            }
            if (id.startsWith(INLINE_MODULE_PREFIX)) {
                // Find the corresponding inline module code stored in htmlData
                for (const data of htmlData.values()) {
                    const foundModule = data.inlineModules.find(m => m.virtualId === id)
                    if (foundModule) return foundModule.code
                }
                // Should not happen if resolveId worked correctly
                this.error(`Internal error: Could not load virtual module ${id}`)
                return null
            }
            return null // Let Rollup handle others
        },

        /**
         * Rollup `generateBundle` hook. Updates script tags in HTML ASTs with final
         * bundle paths and emits the final HTML files. Minifies inline non-module scripts.
         * @param {object} outputOptions Output options.
         * @param {object} bundle Generated bundle.
         */
        async generateBundle(outputOptions, bundle) {
            const outputDir = outputOptions.dir || (outputOptions.file ? path.dirname(outputOptions.file) : null)
            if (!outputDir) {
                this.error('Cannot determine output directory. Set `output.dir`.')
                return
            }

            const emitted = new Set() // Track emitted HTML filenames to detect collisions

            for (const [absolutePath, data] of htmlData.entries()) {
                const { src, dest, ast, inlineModules } = data
                const dir = path.dirname(absolutePath) // Original HTML directory

                // --- Minify inline non-module scripts with Terser ---
                if (config.terser && config.terser.compress !== false) {
                    // Find scripts that are inline and NOT type="module"
                    const inlineScripts = findNodes(ast, node =>
                        node.nodeName === 'script' &&
                        !node.attrs?.find(a => a.name === 'src')?.value && // No src attribute
                        node.attrs?.find(a => a.name === 'type')?.value !== 'module' // Not a module
                    )

                    for (const scriptNode of inlineScripts) {
                        const originalCode = getTextContent(scriptNode)
                        if (originalCode.trim()) { // Only process non-empty scripts
                            try {
                                const result = await terserMinify(originalCode, config.terser)
                                if (result.code !== undefined) {
                                    setTextContent(scriptNode, result.code)
                                } else {
                                    this.warn(`Terser returned undefined code for inline script in ${src}`)
                                }
                            } catch (error) {
                                // Warn on error but keep original code
                                this.warn(`Terser failed for inline script in ${src}: ${error}. Keeping original.`)
                            }
                        }
                    }
                }

                // --- Find placeholder comments and original local module script tags ---
                const nodesToReplace = findNodes(ast, node =>
                    // Is it a placeholder comment we added?
                    (node.nodeName === '#comment' && node.value?.startsWith('__HTML_MODULE_PLACEHOLDER_')) ||
                    // Is it a local <script type="module" src="...">?
                    (node.nodeName === 'script' &&
                        node.attrs?.find(a => a.name === 'type')?.value === 'module' &&
                        node.attrs?.find(a => a.name === 'src')?.value && // Has src
                        !node.attrs.find(a => a.name === 'src').value.includes('://') // Is not external URL
                    )
                )

                // --- Replace placeholders/scripts with final bundle references ---
                for (const node of nodesToReplace) {
                    let moduleId = null // The ID Rollup uses for this entry (virtual ID or absolute path)
                    let desc = '' // Description for logging

                    // Determine the module ID based on the node type
                    if (node.nodeName === '#comment') { // Placeholder for inline module
                        const match = node.value.match(/__HTML_MODULE_PLACEHOLDER_(\0oy3o-rollup-plugin-html-inline:[^?]+\?index=\d+)__/)
                        if (match && match[1]) {
                            moduleId = match[1]
                            desc = `inline module (index ${match[1].split('index=')[1]})`
                        } else {
                            this.warn(`Could not parse virtual ID from placeholder in ${src}: ${node.value}`)
                        }
                    } else { // Original <script type="module" src="...">
                        const src = node.attrs.find(a => a.name === 'src').value
                        moduleId = path.resolve(dir, src) // Resolve relative to HTML file
                        desc = `script src="${src}"`
                    }

                    // Find the corresponding output chunk in the Rollup bundle
                    let chunkName = null
                    if (moduleId) {
                        const chunk = Object.values(bundle).find(c =>
                            c.type === 'chunk' && // Must be a JS chunk
                            // Check if this chunk's entry point matches our module ID
                            (c.facadeModuleId === moduleId ||
                                // Fallback: Check if our module ID is part of this chunk's modules
                                (c.modules && c.modules[moduleId]))
                        )
                        if (chunk) {
                            chunkName = chunk.fileName // e.g., 'assets/index-a1b2c3d4.js'
                        } else {
                            // This might happen if the script was empty or treeshaken away entirely
                            this.warn(`Could not find output chunk for ${desc} (ID: ${moduleId}) referenced in ${src}.`)
                        }
                    }

                    // If chunk found, replace the AST node
                    if (chunkName) {
                        // --- Calculate paths for the new script tag ---
                        let relativePath // Final HTML path relative to outputDir
                        // Use input key if input was object and key differs from value, else use basename
                        if (isWithDest) {
                            relativePath = dest.startsWith('/') ? dest.substring(1) : dest // Treat key as relative path/name
                        } else if (config.preserveStructure) {
                            // Determine the output path based on config and input format
                            relativePath = src
                            // Ensure it's relative if original was absolute (edge case)
                            if (path.isAbsolute(relativePath)) {
                                relativePath = path.relative(process.cwd(), absolutePath)
                            }
                        } else {
                            relativePath = path.basename(src) // Output to root dir
                        }
                        const outputPath = path.resolve(outputDir, relativePath) // Absolute path where HTML will be written
                        const htmlDir = path.dirname(outputPath) // Directory containing the final HTML
                        const chunkPath = path.resolve(outputDir, chunkName) // Absolute path to the JS chunk

                        // Calculate relative path from HTML's location to JS chunk
                        let chunkRelPath = path.relative(htmlDir, chunkPath)
                            .split(path.sep).join('/') // Ensure POSIX separators ('/')
                        // Prepend './' if path doesn't start with '.' or '/' (needed for HTML src)
                        if (!chunkRelPath.startsWith('.') && !chunkRelPath.startsWith('/')) {
                            chunkRelPath = './' + chunkRelPath
                        }

                        // Create the new <script> node to insert
                        const newScriptNode = {
                            nodeName: 'script', tagName: 'script',
                            attrs: [
                                { name: 'type', value: 'module' },
                                { name: 'src', value: chunkRelPath } // Use calculated relative path
                            ],
                            childNodes: [], // Script tags with src shouldn't have content
                            namespaceURI: node.namespaceURI || 'http://www.w3.org/1999/xhtml', // Keep namespace
                            parentNode: node.parentNode // Will be updated by splice
                        }

                        // Replace the old node (placeholder or original script) with the new one
                        const parent = node.parentNode
                        if (parent?.childNodes) {
                            const index = parent.childNodes.findIndex(child => child === node)
                            if (index !== -1) {
                                parent.childNodes.splice(index, 1, newScriptNode)
                                newScriptNode.parentNode = parent // Ensure parent ref is correct on new node
                            } else {
                                this.warn(`Node index not found for replacement (${node.nodeName}) in ${src}`)
                            }
                        } else {
                            this.warn(`Parent node/childNodes not found for replacement (${node.nodeName}) in ${src}`)
                        }
                    } else if (moduleId) {
                        // Chunk not found for a module we expected: remove the original node
                        this.warn(`Removing node for ${desc} in ${src} as its output chunk was not found.`)
                        const parent = node.parentNode
                        if (parent?.childNodes) {
                            const index = parent.childNodes.findIndex(child => child === node)
                            if (index !== -1) parent.childNodes.splice(index, 1) // Remove node
                        }
                    } else if (!moduleId && node.nodeName === '#comment') {
                        // Placeholder parsing failed earlier: remove the placeholder comment
                        this.warn(`Removing unparsed placeholder comment in ${src}.`)
                        const parent = node.parentNode
                        if (parent?.childNodes) {
                            const index = parent.childNodes.findIndex(child => child === node)
                            if (index !== -1) parent.childNodes.splice(index, 1)
                        }
                    }
                } // end loop through nodesToReplace

                // --- Serialize the modified AST back to HTML ---
                const Htmlcode = serialize(ast)

                // --- Determine final HTML output filename (relative to outputDir) ---
                let Html // The fileName for emitFile
                if (isWithDest) {
                    Html = dest.startsWith('/') ? dest.substring(1) : dest
                } else if (config.preserveStructure) {
                    Html = src
                    if (path.isAbsolute(Html)) { // Ensure relative
                        Html = path.relative(process.cwd(), absolutePath)
                    }
                } else {
                    Html = path.basename(src)
                }

                // --- Check for output filename collisions ---
                if (emitted.has(Html)) {
                    // This typically happens with preserveStructure: false and multiple index.html files
                    this.error(`HTML output filename collision: "${Html}" in "${outputDir}". Use unique input keys or 'preserveStructure: true'.`)
                    continue // Skip emitting this file to prevent overwrite
                }
                emitted.add(Html)

                // --- Emit the final HTML file as an asset ---
                this.emitFile({
                    type: 'asset',
                    fileName: Html, // Path relative to output directory
                    source: Htmlcode // Content of the file
                })

            }
        }
    }
}
