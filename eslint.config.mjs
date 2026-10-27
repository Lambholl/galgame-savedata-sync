import js from '@eslint/js'
import { builtinModules } from 'node:module'
import prettierConfig from 'eslint-config-prettier/flat'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const booleanNamePrefixes = [
  'is',
  'has',
  'can',
  'should',
  'was',
  'were',
  'did',
  'do',
  'will',
  'must',
  'may',
  'need',
  'require',
  'allow',
  'support',
  'accept',
  'contain',
  'include',
  'exist',
  'match',
  'use',
  'own',
]
// 这些字段属于已发布的跨端 JSON 或原生事件名称，改名需要协议与数据迁移。
const legacyBooleanNames = ['blocked', 'cancelRequested', 'dark', 'upload', 'refresh']
const booleanNamingRule = {
  selector: [
    'variable',
    'parameter',
    'parameterProperty',
    'classProperty',
    'typeProperty',
    'classicAccessor',
  ],
  filter: {
    regex: `^(?!(?:${legacyBooleanNames.join('|')})$).*$`,
    match: true,
  },
  types: ['boolean'],
  format: ['PascalCase'],
  prefix: booleanNamePrefixes,
  leadingUnderscore: 'forbid',
  trailingUnderscore: 'forbid',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '.reports/**',
      'apps/mobile/android/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-with': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
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
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      camelcase: ['error', { properties: 'never' }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // 对 TypeScript 源码使用具备类型信息的规则替代基础检查。
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      'prefer-promise-reject-errors': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        booleanNamingRule,
        { selector: 'default', format: ['camelCase'] },
        { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        // 对象字面量和导入可使用外部 API 定义的名称。
        { selector: ['objectLiteralProperty', 'import'], format: null },
        { selector: 'property', modifiers: ['requiresQuotes'], format: null },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        booleanNamingRule,
        { selector: 'default', format: ['camelCase'] },
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
        },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        // 组件常作为参数传入（如 antd Modal footer 的 OkBtn），并允许 _ 占位参数。
        {
          selector: 'parameter',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: ['objectLiteralProperty', 'import'], format: null },
        { selector: 'property', modifiers: ['requiresQuotes'], format: null },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // 这些工具通过默认导出加载配置。
    files: [
      'eslint.config.mjs',
      'apps/desktop/electron.vite.config.ts',
      'apps/mobile/vite.config.ts',
      'apps/mobile/capacitor.config.ts',
    ],
    rules: { 'no-restricted-exports': 'off' },
  },
  {
    files: ['apps/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                ...builtinModules,
                'react',
                'react/*',
                'react-dom',
                'react-dom/*',
                'antd',
                'antd/*',
                'antd-mobile',
                'antd-mobile/*',
                '@ant-design/*',
                'electron',
                'electron/*',
                '@capacitor/*',
                'node:*',
              ],
              message: '共享包只保存纯数据与业务规则，界面和平台能力留在各自应用。',
            },
            {
              regex: '(^|/)(desktop|mobile)(/|$)',
              message: '共享包不能依赖桌面或移动应用。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mobile/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)desktop(/|$)',
              message: '移动应用通过共享包和协议复用业务，不导入桌面源码。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)mobile(/|$)',
              message: '桌面应用通过共享包和协议复用业务，不导入移动源码。',
            },
          ],
        },
      ],
    },
  },
  // 排版由 .prettierrc.json 定义；关闭冲突规则后，再启用兼容的代码结构规则。
  {
    ...prettierConfig,
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      curly: ['error', 'all'],
      'arrow-body-style': ['error', 'as-needed'],
    },
  },
)
