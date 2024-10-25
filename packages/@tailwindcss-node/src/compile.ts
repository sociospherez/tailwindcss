import EnhancedResolve from 'enhanced-resolve'
import { createJiti, type Jiti } from 'jiti'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path, { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  __unstable__loadDesignSystem as ___unstable__loadDesignSystem,
  compile as _compile,
} from 'tailwindcss'
import { getModuleDependencies } from './get-module-dependencies'

export async function compile(
  css: string,
  { base, onDependency }: { base: string; onDependency: (path: string) => void },
) {
  let compiler = await _compile(css, {
    base,
    async loadModule(id, base) {
      return loadModule(id, base, onDependency)
    },
    async loadStylesheet(id, base) {
      return loadStylesheet(id, base, onDependency)
    },
  })

  // Verify if the `source(…)` path exists (until the glob pattern starts)
  if (compiler.root && compiler.root !== 'none') {
    let globSymbols = /[*{]/
    let basePath = []
    for (let segment of compiler.root.pattern.split('/')) {
      if (globSymbols.test(segment)) {
        break
      }

      basePath.push(segment)
    }

    let exists = await fsPromises
      .stat(path.resolve(base, basePath.join('/')))
      .then((stat) => stat.isDirectory())
      .catch(() => false)

    if (!exists) {
      throw new Error(`The \`source(${compiler.root.pattern})\` does not exist`)
    }
  }

  return compiler
}

export async function __unstable__loadDesignSystem(css: string, { base }: { base: string }) {
  return ___unstable__loadDesignSystem(css, {
    base,
    async loadModule(id, base) {
      return loadModule(id, base, () => {})
    },
    async loadStylesheet(id, base) {
      return loadStylesheet(id, base, () => {})
    },
  })
}

export async function loadModule(id: string, base: string, onDependency: (path: string) => void) {
  if (id[0] !== '.') {
    let resolvedPath = await resolveJsId(id, base)
    if (!resolvedPath) {
      throw new Error(`Could not resolve '${id}' from '${base}'`)
    }

    let module = await importModule(pathToFileURL(resolvedPath).href)
    return {
      base: dirname(resolvedPath),
      module: module.default ?? module,
    }
  }

  let resolvedPath = await resolveJsId(id, base)
  if (!resolvedPath) {
    throw new Error(`Could not resolve '${id}' from '${base}'`)
  }
  let [module, moduleDependencies] = await Promise.all([
    importModule(pathToFileURL(resolvedPath).href + '?id=' + Date.now()),
    getModuleDependencies(resolvedPath),
  ])

  for (let file of moduleDependencies) {
    onDependency(file)
  }
  return {
    base: dirname(resolvedPath),
    module: module.default ?? module,
  }
}

async function loadStylesheet(id: string, base: string, onDependency: (path: string) => void) {
  let resolvedPath = await resolveCssId(id, base)
  if (!resolvedPath) throw new Error(`Could not resolve '${id}' from '${base}'`)

  onDependency(resolvedPath)

  if (typeof globalThis.__tw_readFile === 'function') {
    let file = await globalThis.__tw_readFile(resolvedPath, 'utf-8')
    if (file) {
      return {
        base: path.dirname(resolvedPath),
        content: file,
      }
    }
  }

  let file = await fsPromises.readFile(resolvedPath, 'utf-8')
  return {
    base: path.dirname(resolvedPath),
    content: file,
  }
}

// Attempts to import the module using the native `import()` function. If this
// fails, it sets up `jiti` and attempts to import this way so that `.ts` files
// can be resolved properly.
let jiti: null | Jiti = null
async function importModule(path: string): Promise<any> {
  try {
    return await import(path)
  } catch (error) {
    jiti ??= createJiti(import.meta.url, { moduleCache: false, fsCache: false })
    return await jiti.import(path)
  }
}

const cssResolver = EnhancedResolve.ResolverFactory.createResolver({
  fileSystem: new EnhancedResolve.CachedInputFileSystem(fs, 4000),
  useSyncFileSystemCalls: true,
  extensions: ['.css'],
  mainFields: ['style'],
  conditionNames: ['style'],
})
async function resolveCssId(id: string, base: string): Promise<string | false | undefined> {
  if (typeof globalThis.__tw_resolve === 'function') {
    let resolved = globalThis.__tw_resolve(id, base)
    if (resolved) {
      return Promise.resolve(resolved)
    }
  }

  return runResolver(cssResolver, id, base)
}

const jsResolver = EnhancedResolve.ResolverFactory.createResolver({
  fileSystem: new EnhancedResolve.CachedInputFileSystem(fs, 4000),
  useSyncFileSystemCalls: true,
  extensions: ['.js', '.json', '.node', '.ts'],
  conditionNames: import.meta.url ? ['node', 'import'] : ['node', 'require'],
})

function resolveJsId(id: string, base: string): Promise<string | false | undefined> {
  return runResolver(jsResolver, id, base)
}

function runResolver(
  resolver: EnhancedResolve.Resolver,
  id: string,
  base: string,
): Promise<string | false | undefined> {
  return new Promise((resolve, reject) =>
    resolver.resolve({}, base, id, {}, (err, result) => {
      if (err) return reject(err)
      resolve(result)
    }),
  )
}
