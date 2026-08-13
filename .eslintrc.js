module.exports = {
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended', 'plugin:prettier/recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    // Possible Errors
    'no-console': 'warn',
    'no-unused-vars': 'warn',
    'no-undef': 'error',
    
    // Best Practices
    'eqeqeq': ['error', 'always'],
    'no-var': 'error',
    'prefer-const': 'error',
    
    // Style
    'indent': ['error', 2],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'],
    
    // Node.js
    'no-process-exit': 'off',
    'no-sync': 'warn',
  },
  overrides: [
    {
      files: ['**/*.test.js'],
      env: {
        node: true,
        mocha: true,
      },
    },
  ],
};
