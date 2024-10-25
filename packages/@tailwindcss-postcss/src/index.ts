import QuickLRU from '@alloc/quick-lru'
import { compile, env } from '@tailwindcss/node'
import { clearRequireCache } from '@tailwindcss/node/require-cache'
import { Scanner } from '@tailwindcss/oxide'
import fs from 'fs'
import { Features, transform } from 'lightningcss'
import path from 'path'
import postcss, { type AcceptedPlugin, type PluginCreator } from 'postcss'
import fixRelativePathsPlugin from './postcss-fix-relative-paths'

interface CacheEntry {
  mtimes: Map<string, number>
  compiler: null | Awaited<ReturnType<typeof compile>>
  scanner: null | Scanner
  css: string
  optimizedCss: string
  fullRebuildPaths: string[]
}
let cache = new QuickLRU<string, CacheEntry>({ maxSize: 50 })

function getContextFromCache(inputFile: string, opts: PluginOptions): CacheEntry {
  let key = `${inputFile}:${opts.base ?? ''}:${opts.optimize ?? ''}`
  if (cache.has(key)) return cache.get(key)!
  let entry = {
    mtimes: new Map<string, number>(),
    compiler: null,
    scanner: null,
    css: '',
    optimizedCss: '',
    fullRebuildPaths: [] as string[],
  }
  cache.set(key, entry)
  return entry
}

export type PluginOptions = {
  // The base directory to scan for class candidates.
  base?: string

  // Optimize and minify the output CSS.
  optimize?: boolean | { minify?: boolean }
}

function tailwindcss(opts: PluginOptions = {}): AcceptedPlugin {
  let base = opts.base ?? process.cwd()
  let optimize = opts.optimize ?? process.env.NODE_ENV === 'production'

  return {
    postcssPlugin: '@tailwindcss/postcss',
    plugins: [
      // We need to handle the case where `postcss-import` might have run before
      // the Tailwind CSS plugin is run. In this case, we need to manually fix
      // relative paths before processing it in core.
      fixRelativePathsPlugin(),

      {
        postcssPlugin: 'tailwindcss',
        async OnceExit(root, { result }) {
          env.DEBUG && console.time('[@tailwindcss/postcss] Total time in @tailwindcss/postcss')
          let inputFile = result.opts.from ?? ''
          let context = getContextFromCache(inputFile, opts)
          let inputBasePath = path.dirname(path.resolve(inputFile))

          async function createCompiler() {
            env.DEBUG && console.time('[@tailwindcss/postcss] Setup compiler')
            clearRequireCache(context.fullRebuildPaths)

            context.fullRebuildPaths = []

            let compiler = await compile(root.toString(), {
              base: inputBasePath,
              onDependency: (path) => {
                context.fullRebuildPaths.push(path)
              },
            })

            env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Setup compiler')
            return compiler
          }

          // Whether this is the first build or not, if it is, then we can
          // optimize the build by not creating the compiler until we need it.
          let isInitialBuild = context.compiler === null

          // Setup the compiler if it doesn't exist yet. This way we can
          // guarantee a `build()` function is available.
          context.compiler ??= await createCompiler()

          let rebuildStrategy: 'full' | 'incremental' = 'incremental'

          // Track file modification times to CSS files
          {
            for (let file of context.fullRebuildPaths) {
              result.messages.push({
                type: 'dependency',
                plugin: '@tailwindcss/postcss',
                file,
                parent: result.opts.from,
              })
            }

            let files = result.messages.flatMap((message) => {
              if (message.type !== 'dependency') return []
              return message.file
            })
            files.push(inputFile)

            for (let file of files) {
              let changedTime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null
              if (changedTime === null) {
                if (file === inputFile) {
                  rebuildStrategy = 'full'
                }
                continue
              }

              let prevTime = context.mtimes.get(file)
              if (prevTime === changedTime) continue

              rebuildStrategy = 'full'
              context.mtimes.set(file, changedTime)
            }
          }

          let css = ''

          if (
            rebuildStrategy === 'full' &&
            // We can re-use the compiler if it was created during the
            // initial build. If it wasn't, we need to create a new one.
            !isInitialBuild
          ) {
            context.compiler = await createCompiler()
          }

          if (context.scanner === null || rebuildStrategy === 'full') {
            let sources = (() => {
              // Disable auto source detection
              if (context.compiler.root === 'none') {
                return []
              }

              // No root specified, use the base directory
              if (context.compiler.root === null) {
                return [{ base, pattern: '**/*' }]
              }

              // Use the specified root
              return [context.compiler.root]
            })().concat(context.compiler.globs)

            // Look for candidates used to generate the CSS
            context.scanner = new Scanner({ sources })
          }

          env.DEBUG && console.time('[@tailwindcss/postcss] Scan for candidates')
          let candidates = context.scanner.scan()
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Scan for candidates')

          // Add all found files as direct dependencies
          for (let file of context.scanner.files) {
            result.messages.push({
              type: 'dependency',
              plugin: '@tailwindcss/postcss',
              file,
              parent: result.opts.from,
            })
          }

          // Register dependencies so changes in `base` cause a rebuild while
          // giving tools like Vite or Parcel a glob that can be used to limit
          // the files that cause a rebuild to only those that match it.
          for (let { base, pattern } of context.scanner.globs) {
            result.messages.push({
              type: 'dir-dependency',
              plugin: '@tailwindcss/postcss',
              dir: base,
              glob: pattern,
              parent: result.opts.from,
            })
          }

          env.DEBUG && console.time('[@tailwindcss/postcss] Build CSS')
          css = context.compiler.build(candidates)
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Build CSS')

          // Replace CSS
          if (css !== context.css && optimize) {
            env.DEBUG && console.time('[@tailwindcss/postcss] Optimize CSS')
            context.optimizedCss = optimizeCss(css, {
              minify: typeof optimize === 'object' ? optimize.minify : true,
            })
            env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Optimize CSS')
          }
          context.css = css

          env.DEBUG && console.time('[@tailwindcss/postcss] Update PostCSS AST')
          root.removeAll()
          root.append(postcss.parse(optimize ? context.optimizedCss : context.css, result.opts))
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Update PostCSS AST')
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Total time in @tailwindcss/postcss')
        },
      },
    ],
  }
}

function optimizeCss(
  input: string,
  { file = 'input.css', minify = false }: { file?: string; minify?: boolean } = {},
) {
  return transform({
    filename: file,
    code: Buffer.from(input),
    minify,
    sourceMap: false,
    drafts: {
      customMedia: true,
    },
    nonStandard: {
      deepSelectorCombinator: true,
    },
    include: Features.Nesting,
    exclude: Features.LogicalProperties,
    targets: {
      safari: (16 << 16) | (4 << 8),
    },
    errorRecovery: true,
  }).code.toString()
}

export default Object.assign(tailwindcss, { postcss: true }) as PluginCreator<PluginOptions>
