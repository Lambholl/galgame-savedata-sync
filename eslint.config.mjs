// ESLint 配置，按顺序分为四部分：
// 1. 推荐规则集：ESLint、typescript-eslint、React、React Hooks。
// 2. eslint-config-prettier：关掉和 Prettier 排版冲突的规则，排版设置只在 .prettierrc.json。
// 3. 项目规则：代码写法、命名、文档注释、React 写法。
// 4. 模块边界：shared、desktop、mobile 之间能导入什么（ADR-0002）。
// 后面的配置块覆盖前面同名规则的设置。

import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier/flat'
import jsdoc from 'eslint-plugin-jsdoc'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import { builtinModules } from 'node:module'
import tseslint from 'typescript-eslint'

const JS_FILES = '**/*.{js,mjs,cjs}'
const TS_FILES = '**/*.{ts,tsx}'
const ALL_FILES = '**/*.{js,mjs,cjs,ts,tsx}'

// ---------------------------------------------------------------------------
// 命名
// ---------------------------------------------------------------------------

// 布尔变量、参数和属性的前缀，前缀后的部分用 PascalCase，如 isConnected。
const BOOLEAN_PREFIXES = [
  'is',
  'has',
  'can',
  'should',
  'was',
  'did',
  'will',
  'must',
  'need',
  'allow',
  'support',
  'contain',
  'include',
  'exist',
  'match',
]
// 和 DOM 属性同名的组件布尔 props 沿用 DOM 的名字，如 <Button disabled />。
const DOM_BOOLEAN_NAMES = ['checked', 'disabled', 'hidden', 'open', 'readOnly', 'required']

/**
 * 生成 @typescript-eslint/naming-convention 的选项。
 *
 * @param {{ isReact: boolean }} options isReact 为 true 时允许组件用 PascalCase 的函数名和常量名。
 * @returns {unknown[]} 规则选项。
 */
function namingConvention({ isReact }) {
  const componentFormat = isReact ? ['PascalCase'] : []
  return [
    'error',
    {
      selector: [
        'variable',
        'parameter',
        'parameterProperty',
        'classProperty',
        'typeProperty',
        'accessor',
      ],
      types: ['boolean'],
      filter: { regex: `^(${DOM_BOOLEAN_NAMES.join('|')})$`, match: false },
      format: ['PascalCase'],
      prefix: BOOLEAN_PREFIXES,
    },
    { selector: 'default', format: ['camelCase'] },
    {
      selector: 'variable',
      modifiers: ['const'],
      format: ['camelCase', 'UPPER_CASE', ...componentFormat],
    },
    { selector: 'function', format: ['camelCase', ...componentFormat] },
    // tsconfig 开了 noUnusedParameters，排在用到的参数前面的未用参数以 _ 开头。
    {
      selector: 'parameter',
      modifiers: ['unused'],
      format: ['camelCase'],
      leadingUnderscore: 'require',
    },
    { selector: 'typeLike', format: ['PascalCase'] },
    { selector: 'enumMember', format: ['PascalCase'] },
    // 导入名和对象字面量的键由外部模块、HTTP 头和第三方 API 决定。
    { selector: ['import', 'objectLiteralProperty'], format: null },
    { selector: ['property', 'objectLiteralMethod'], modifiers: ['requiresQuotes'], format: null },
  ]
}

// ---------------------------------------------------------------------------
// 模块边界
// ---------------------------------------------------------------------------

// 只有某个平台才有的模块。
const PLATFORM_MODULES = [
  ...builtinModules,
  'node:*',
  '@tauri-apps/*',
  '@capacitor/*',
  'react-dom',
  'react-dom/*',
  'antd-mobile',
  'antd-mobile/*',
]
const UI_MODULES = ['react', 'react/*', 'antd', 'antd/*', '@ant-design/*']
const NO_APP_IMPORTS = {
  regex: '(^|/)(desktop|mobile)(/|$)',
  message: 'shared 不能依赖桌面或移动应用。',
}

/**
 * 生成 no-restricted-imports 的选项。
 *
 * @param {object[]} patterns no-restricted-imports 的 patterns 项。
 * @returns {unknown[]} 规则选项。
 */
function restrictImports(...patterns) {
  return ['error', { patterns }]
}

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/.reports/**',
      'docs/design/**',
      'apps/mobile/android/**',
      // Agent 工具在 .claude/worktrees/ 下放其他分支的完整工作区，检查它们会让 lint 时间翻倍。
      '.claude/**',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  // -------------------------------------------------------------------------
  // 1. 推荐规则集
  // -------------------------------------------------------------------------
  {
    files: [JS_FILES],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: [TS_FILES],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [react.configs.flat.recommended, react.configs.flat['jsx-runtime']],
    // ESLint 10 去掉了 context.getFilename，插件的 'detect' 会报错，所以写明版本，和 apps 的 react 依赖一致。
    settings: { react: { version: '18.3' } },
  },
  {
    files: [TS_FILES],
    extends: [reactHooks.configs.flat.recommended],
  },

  // -------------------------------------------------------------------------
  // 2. Prettier 管排版
  // -------------------------------------------------------------------------
  prettierConfig,

  // -------------------------------------------------------------------------
  // 3. 项目规则
  // -------------------------------------------------------------------------
  {
    files: [ALL_FILES],
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'arrow-body-style': ['error', 'as-needed'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-coercion': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      // 只用命名导出。要求默认导出的配置文件在下面单独放开。
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    files: [
      'eslint.config.mjs',
      '**/vite.config.ts',
      '**/vite.sidecar.config.ts',
      '**/capacitor.config.ts',
    ],
    rules: { 'no-restricted-exports': 'off' },
  },
  {
    files: [JS_FILES],
    rules: { camelcase: ['error', { properties: 'never' }] },
  },
  {
    files: [TS_FILES],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      // 下面三条用有类型信息的版本替换基础规则。
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      'prefer-promise-reject-errors': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/naming-convention': namingConvention({ isReact: false }),
    },
  },
  {
    files: ['**/*.tsx'],
    rules: { '@typescript-eslint/naming-convention': namingConvention({ isReact: true }) },
  },
  {
    // 模块外可见的函数、类、公共方法、类型和导出常量写文档注释。
    files: [ALL_FILES],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          checkConstructors: false,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            // 原生插件接口 *NativePlugin 的方法和同文件网页接口的同名方法一一对应，文档写在网页接口上。
            'TSMethodSignature:not(TSInterfaceDeclaration[id.name=/NativePlugin$/] *)',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react/self-closing-comp': ['error', { component: true, html: true }],
      'react/jsx-fragments': ['error', 'syntax'],
      'react/jsx-no-useless-fragment': 'error',
      'react/jsx-curly-brace-presence': ['error', { props: 'never', children: 'never' }],
      'react/jsx-boolean-value': ['error', 'never'],
      'react/no-array-index-key': 'error',
      // 传给 props 的渲染函数（antd 的 itemRender、footer 等）由组件直接调用，不会被当作组件挂载。
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      'react/jsx-no-leaked-render': 'error',
      'react/jsx-handler-names': 'error',
      'react/hook-use-state': 'error',
      'react/no-danger': 'error',
      // 类型检查已经覆盖 props。
      'react/prop-types': 'off',
      'react-hooks/exhaustive-deps': 'error',
      // 组件文件只导出组件，Vite 热更新才能保留组件状态。
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // 提示统一走各端 app/app-message.ts 的 useAppMessage：直接用 antd 的 message 重开同 key 的提示时，提示会一直不消失。
    files: ['apps/mobile/src/**/*.{ts,tsx}', 'apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/app/app-message.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='antd'] > ImportSpecifier[imported.name='message']",
          message: '提示用 app/app-message.ts 的 useAppMessage。',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 4. 模块边界
  // -------------------------------------------------------------------------
  {
    // shared 主入口给电脑主进程、协议和 node 测试用，只放纯数据和业务规则。
    files: ['apps/shared/src/**/*.ts'],
    ignores: ['apps/shared/src/ui/**'],
    rules: {
      'no-restricted-imports': restrictImports(
        {
          group: [...PLATFORM_MODULES, ...UI_MODULES],
          message: 'shared 主入口只放纯数据和业务规则；界面放 src/ui，平台能力留在各应用。',
        },
        { regex: '(^|/)ui(/|$)', message: 'shared 主入口不能导入界面入口 src/ui。' },
        NO_APP_IMPORTS,
      ),
    },
  },
  {
    // shared/ui 只放两端交互一致的渲染；弹层、antd-mobile 和平台能力留在各应用。
    files: ['apps/shared/src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictImports(
        { group: PLATFORM_MODULES, message: 'shared/ui 不能用平台模块和 antd-mobile。' },
        NO_APP_IMPORTS,
      ),
      // 共用组件的外观只能通过含义明确的参数变化，两端不能各自传样式或透传属性。
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSPropertySignature[key.name=/^(style|className|styles|classNames)$/]',
          message: '共用组件参数不接受样式；用含义明确的排版参数表达两端差异。',
        },
        {
          selector:
            ':matches(TSTypeReference > Identifier.typeName, TSQualifiedName > Identifier.right, TSInterfaceHeritage > Identifier.expression, TSInterfaceHeritage > MemberExpression > Identifier.property)[name=/^(HTMLAttributes|AllHTMLAttributes|ComponentProps|ComponentPropsWithRef|ComponentPropsWithoutRef|CSSProperties)$/]',
          message: '共用组件参数逐项声明，不继承 DOM、组件或样式属性。',
        },
        { selector: 'JSXSpreadAttribute', message: '共用组件逐项传属性，不展开透传。' },
        { selector: 'ObjectPattern > RestElement', message: '共用组件不收集剩余参数。' },
      ],
    },
  },
  {
    files: ['apps/mobile/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictImports({
        regex: '(^|/)desktop(/|$)',
        message: '移动应用通过 shared 复用代码，不导入桌面源码。',
      }),
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictImports({
        regex: '(^|/)mobile(/|$)',
        message: '桌面应用通过 shared 复用代码，不导入移动源码。',
      }),
    },
  },
)
