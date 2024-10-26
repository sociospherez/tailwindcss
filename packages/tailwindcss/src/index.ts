import { version } from '../package.json'
import { substituteAtApply } from './apply'
import {
  atRoot,
  atRule,
  comment,
  context,
  decl,
  styleRule,
  toCss,
  walk,
  WalkAction,
  type AstNode,
  type AtRule,
  type StyleRule,
} from './ast'
import { substituteAtImports } from './at-import'
import { applyCompatibilityHooks } from './compat/apply-compat-hooks'
import type { UserConfig } from './compat/config/types'
import { type Plugin } from './compat/plugin-api'
import { compileCandidates } from './compile'
import { substituteFunctions } from './css-functions'
import * as CSS from './css-parser'
import { buildDesignSystem, type DesignSystem } from './design-system'
import { Theme, ThemeOptions } from './theme'
import { segment } from './utils/segment'
import { compoundsForSelectors } from './variants'
export type Config = UserConfig

const IS_VALID_PREFIX = /^[a-z]+$/
const IS_VALID_UTILITY_NAME = /^[a-z][a-zA-Z0-9/%._-]*$/

type CompileOptions = {
  base?: string
  loadModule?: (
    id: string,
    base: string,
    resourceHint: 'plugin' | 'config',
  ) => Promise<{ module: Plugin | Config; base: string }>
  loadStylesheet?: (id: string, base: string) => Promise<{ content: string; base: string }>
}

function throwOnLoadModule(): never {
  throw new Error('No `loadModule` function provided to `compile`')
}

function throwOnLoadStylesheet(): never {
  throw new Error('No `loadStylesheet` function provided to `compile`')
}

function parseThemeOptions(params: string) {
  let options = ThemeOptions.NONE
  let prefix = null

  for (let option of segment(params, ' ')) {
    if (option === 'reference') {
      options |= ThemeOptions.REFERENCE
    } else if (option === 'inline') {
      options |= ThemeOptions.INLINE
    } else if (option === 'default') {
      options |= ThemeOptions.DEFAULT
    } else if (option.startsWith('prefix(') && option.endsWith(')')) {
      prefix = option.slice(7, -1)
    }
  }

  return [options, prefix] as const
}

async function parseCss(
  css: string,
  {
    base = '',
    loadModule = throwOnLoadModule,
    loadStylesheet = throwOnLoadStylesheet,
  }: CompileOptions = {},
) {
  let ast = [context({ base }, CSS.parse(css))] as AstNode[]

  await substituteAtImports(ast, base, loadStylesheet)

  let important: boolean | null = null
  let theme = new Theme()
  let customVariants: ((designSystem: DesignSystem) => void)[] = []
  let customUtilities: ((designSystem: DesignSystem) => void)[] = []
  let firstThemeRule = null as StyleRule | null
  let globs: { base: string; pattern: string }[] = []

  // Handle at-rules
  walk(ast, (node, { parent, replaceWith, context }) => {
    if (node.kind !== 'at-rule') return

    // Collect custom `@utility` at-rules
    if (node.name === 'utility') {
      if (parent !== null) {
        throw new Error('`@utility` cannot be nested.')
      }

      let name = node.params

      if (!IS_VALID_UTILITY_NAME.test(name)) {
        throw new Error(
          `\`@utility ${name}\` defines an invalid utility name. Utilities should be alphanumeric and start with a lowercase letter.`,
        )
      }

      if (node.nodes.length === 0) {
        throw new Error(
          `\`@utility ${name}\` is empty. Utilities should include at least one property.`,
        )
      }

      customUtilities.push((designSystem) => {
        designSystem.utilities.static(name, (candidate) => {
          if (candidate.negative) return
          return structuredClone(node.nodes)
        })
      })

      return
    }

    // Collect paths from `@source` at-rules
    if (node.name === 'source') {
      if (node.nodes.length > 0) {
        throw new Error('`@source` cannot have a body.')
      }

      if (parent !== null) {
        throw new Error('`@source` cannot be nested.')
      }

      let path = node.params
      if (
        (path[0] === '"' && path[path.length - 1] !== '"') ||
        (path[0] === "'" && path[path.length - 1] !== "'") ||
        (path[0] !== "'" && path[0] !== '"')
      ) {
        throw new Error('`@source` paths must be quoted.')
      }
      globs.push({ base: context.base, pattern: path.slice(1, -1) })
      replaceWith([])
      return
    }

    // Register custom variants from `@variant` at-rules
    if (node.name === 'variant') {
      if (parent !== null) {
        throw new Error('`@variant` cannot be nested.')
      }

      // Remove `@variant` at-rule so it's not included in the compiled CSS
      replaceWith([])

      let [name, selector] = segment(node.params, ' ')

      if (node.nodes.length > 0 && selector) {
        throw new Error(`\`@variant ${name}\` cannot have both a selector and a body.`)
      }

      // Variants with a selector, but without a body, e.g.: `@variant hocus (&:hover, &:focus);`
      if (node.nodes.length === 0) {
        if (!selector) {
          throw new Error(`\`@variant ${name}\` has no selector or body.`)
        }

        let selectors = segment(selector.slice(1, -1), ',')

        let atRuleParams: string[] = []
        let styleRuleSelectors: string[] = []

        for (let selector of selectors) {
          selector = selector.trim()

          if (selector[0] === '@') {
            atRuleParams.push(selector)
          } else {
            styleRuleSelectors.push(selector)
          }
        }

        customVariants.push((designSystem) => {
          designSystem.variants.static(
            name,
            (r) => {
              let nodes: AstNode[] = []

              if (styleRuleSelectors.length > 0) {
                nodes.push(styleRule(styleRuleSelectors.join(', '), r.nodes))
              }

              for (let selector of atRuleParams) {
                nodes.push(CSS.parseAtRule(selector, r.nodes))
              }

              r.nodes = nodes
            },
            {
              compounds: compoundsForSelectors([...styleRuleSelectors, ...atRuleParams]),
            },
          )
        })

        return
      }

      // Variants without a selector, but with a body:
      //
      // E.g.:
      //
      // ```css
      // @variant hocus {
      //   &:hover {
      //     @slot;
      //   }
      //
      //   &:focus {
      //     @slot;
      //   }
      // }
      // ```
      else {
        customVariants.push((designSystem) => {
          designSystem.variants.fromAst(name, node.nodes)
        })

        return
      }
    }

    if (node.name === 'media') {
      let params = segment(node.params, ' ')
      let unknownParams: string[] = []

      for (let param of params) {
        // Handle `@media theme(…)`
        //
        // We support `@import "tailwindcss/theme" theme(reference)` as a way to
        // import an external theme file as a reference, which becomes `@media
        // theme(reference) { … }` when the `@import` is processed.
        if (param.startsWith('theme(')) {
          let themeParams = param.slice(6, -1)

          walk(node.nodes, (child) => {
            if (child.kind !== 'at-rule') {
              throw new Error(
                'Files imported with `@import "…" theme(…)` must only contain `@theme` blocks.',
              )
            }
            if (child.name === 'theme') {
              child.params += ' ' + themeParams
              return WalkAction.Skip
            }
          })
        }

        // Handle `@media prefix(…)`
        //
        // We support `@import "tailwindcss" prefix(ident)` as a way to
        // configure a theme prefix for variables and utilities.
        else if (param.startsWith('prefix(')) {
          let prefix = param.slice(7, -1)

          walk(node.nodes, (child) => {
            if (child.kind !== 'at-rule') return
            if (child.name === 'theme') {
              child.params += ` prefix(${prefix})`
              return WalkAction.Skip
            }
          })
        }

        // Handle important
        else if (param === 'important') {
          important = true
        }

        //
        else {
          unknownParams.push(param)
        }
      }

      if (unknownParams.length > 0) {
        node.params = unknownParams.join(' ')
      } else if (params.length > 0) {
        replaceWith(node.nodes)
      }

      return WalkAction.Skip
    }

    // Handle `@theme`
    if (node.name === 'theme') {
      let [themeOptions, themePrefix] = parseThemeOptions(node.params)

      if (themePrefix) {
        if (!IS_VALID_PREFIX.test(themePrefix)) {
          throw new Error(
            `The prefix "${themePrefix}" is invalid. Prefixes must be lowercase ASCII letters (a-z) only.`,
          )
        }

        theme.prefix = themePrefix
      }

      // Record all custom properties in the `@theme` declaration
      walk(node.nodes, (child, { replaceWith }) => {
        // Collect `@keyframes` rules to re-insert with theme variables later,
        // since the `@theme` rule itself will be removed.
        if (child.kind === 'at-rule' && child.name === 'keyframes') {
          theme.addKeyframes(child)
          replaceWith([])
          return WalkAction.Skip
        }

        if (child.kind === 'comment') return
        if (child.kind === 'declaration' && child.property.startsWith('--')) {
          theme.add(child.property, child.value ?? '', themeOptions)
          return
        }

        let snippet = toCss([atRule(node.name, node.params, [child])])
          .split('\n')
          .map((line, idx, all) => `${idx === 0 || idx >= all.length - 2 ? ' ' : '>'} ${line}`)
          .join('\n')

        throw new Error(
          `\`@theme\` blocks must only contain custom properties or \`@keyframes\`.\n\n${snippet}`,
        )
      })

      // Keep a reference to the first `@theme` rule to update with the full
      // theme later, and delete any other `@theme` rules.
      if (!firstThemeRule && !(themeOptions & ThemeOptions.REFERENCE)) {
        firstThemeRule = styleRule(':root', node.nodes)
        replaceWith([firstThemeRule])
      } else {
        replaceWith([])
      }
      return WalkAction.Skip
    }
  })

  let designSystem = buildDesignSystem(theme)

  if (important) {
    designSystem.important = important
  }

  // Apply hooks from backwards compatibility layer. This function takes a lot
  // of random arguments because it really just needs access to "the world" to
  // do whatever ungodly things it needs to do to make things backwards
  // compatible without polluting core.
  await applyCompatibilityHooks({ designSystem, base, ast, loadModule, globs })

  for (let customVariant of customVariants) {
    customVariant(designSystem)
  }

  for (let customUtility of customUtilities) {
    customUtility(designSystem)
  }

  // Output final set of theme variables at the position of the first `@theme`
  // rule.
  if (firstThemeRule) {
    let nodes = []

    for (let [key, value] of theme.entries()) {
      if (value.options & ThemeOptions.REFERENCE) continue
      nodes.push(decl(key, value.value))
    }

    let keyframesRules = theme.getKeyframes()
    if (keyframesRules.length > 0) {
      let animationParts = [...theme.namespace('--animate').values()].flatMap((animation) =>
        animation.split(' '),
      )

      for (let keyframesRule of keyframesRules) {
        // Remove any keyframes that aren't used by an animation variable.
        let keyframesName = keyframesRule.params
        if (!animationParts.includes(keyframesName)) {
          continue
        }

        // Wrap `@keyframes` in `AtRoot` so they are hoisted out of `:root` when
        // printing.
        nodes.push(
          Object.assign(
            keyframesRule,
            atRoot([atRule(keyframesRule.name, keyframesRule.params, keyframesRule.nodes)]),
          ),
        )
      }
    }
    firstThemeRule.nodes = nodes
  }

  // Replace `@apply` rules with the actual utility classes.
  substituteAtApply(ast, designSystem)

  substituteFunctions(ast, designSystem.resolveThemeValue)

  // Remove `@utility`, we couldn't replace it before yet because we had to
  // handle the nested `@apply` at-rules first.
  walk(ast, (node, { replaceWith }) => {
    if (node.kind !== 'at-rule') return

    if (node.name === 'utility') {
      replaceWith([])
    }

    // The `@utility` has to be top-level, therefore we don't have to traverse
    // into nested trees.
    return WalkAction.Skip
  })

  return {
    designSystem,
    ast,
    globs,
  }
}

export async function compile(
  css: string,
  opts: CompileOptions = {},
): Promise<{
  globs: { base: string; pattern: string }[]
  build(candidates: string[]): string
}> {
  let { designSystem, ast, globs } = await parseCss(css, opts)

  let tailwindUtilitiesNode: AtRule | null = null

  // Find `@tailwind utilities` so that we can later replace it with the actual
  // generated utility class CSS.
  walk(ast, (node) => {
    if (node.kind === 'at-rule' && node.name === 'tailwind' && node.params === 'utilities') {
      tailwindUtilitiesNode = node

      // Stop walking after finding `@tailwind utilities` to avoid walking all
      // of the generated CSS. This means `@tailwind utilities` can only appear
      // once per file but that's the intended usage at this point in time.
      return WalkAction.Stop
    }
  })

  if (process.env.NODE_ENV !== 'test') {
    ast.unshift(comment(`! tailwindcss v${version} | MIT License | https://tailwindcss.com `))
  }

  // Track all invalid candidates
  function onInvalidCandidate(candidate: string) {
    designSystem.invalidCandidates.add(candidate)
  }

  // Track all valid candidates, these are the incoming `rawCandidate` that
  // resulted in a generated AST Node. All the other `rawCandidates` are invalid
  // and should be ignored.
  let allValidCandidates = new Set<string>()
  let compiledCss = toCss(ast)
  let previousAstNodeCount = 0

  return {
    globs,
    build(newRawCandidates: string[]) {
      let didChange = false

      // Add all new candidates unless we know that they are invalid.
      let prevSize = allValidCandidates.size
      for (let candidate of newRawCandidates) {
        if (!designSystem.invalidCandidates.has(candidate)) {
          allValidCandidates.add(candidate)
          didChange ||= allValidCandidates.size !== prevSize
        }
      }

      // If no new candidates were added, we can return the original CSS. This
      // currently assumes that we only add new candidates and never remove any.
      if (!didChange) {
        return compiledCss
      }

      if (tailwindUtilitiesNode) {
        let newNodes = compileCandidates(allValidCandidates, designSystem, {
          onInvalidCandidate,
        }).astNodes

        // If no new ast nodes were generated, then we can return the original
        // CSS. This currently assumes that we only add new ast nodes and never
        // remove any.
        if (previousAstNodeCount === newNodes.length) {
          return compiledCss
        }

        previousAstNodeCount = newNodes.length

        tailwindUtilitiesNode.nodes = newNodes
        compiledCss = toCss(ast)
      }

      return compiledCss
    },
  }
}

export async function __unstable__loadDesignSystem(css: string, opts: CompileOptions = {}) {
  let result = await parseCss(css, opts)
  return result.designSystem
}

export default function postcssPluginWarning() {
  throw new Error(
    `It looks like you're trying to use \`tailwindcss\` directly as a PostCSS plugin. The PostCSS plugin has moved to a separate package, so to continue using Tailwind CSS with PostCSS you'll need to install \`@tailwindcss/postcss\` and update your PostCSS configuration.`,
  )
}
