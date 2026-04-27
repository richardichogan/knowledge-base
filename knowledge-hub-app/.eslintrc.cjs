// @ts-check
/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigFile} */

const { FlatCompat } = require('@eslint/eslintrc');
const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = {
  root: true,
  extends: ['@react-native'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    'no-console': ['error', { allow: ['warn', 'error'] }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
};
