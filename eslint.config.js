import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'eslint.config.js'] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Tool results and wire payloads are inherently loosely typed; unknown +
      // narrow-at-use is the pattern here, but tests assert on parsed JSON.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Async methods implementing PloidClient/TokenVerifier often have no
      // await (mock, dev bypass) — the interface contract is what matters.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // node:test's test()/before()/after() return promises the runner owns.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: ['test', 'before', 'after', 'describe', 'it'], package: 'node:test' },
          ],
        },
      ],
    },
  }
)
