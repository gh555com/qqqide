// ESLint — deliberately minimal static gate for the payload (server-app/).
// Policy: exactly three rules, all "warn" — a stable, reviewable advisory
// surface that never blocks a build. Do NOT add formatting rules (Prettier
// et al.): a repo-wide reformat would pollute history and break diffs.
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  env: {
    es2022: true,
  },
  ignorePatterns: [
    'node_modules/',
    'server-app/vendor/',
    'shell-out/',
    'dist-pack/',
    'Data/',
    'engines/',
    '_qqq/',
    '_qqqvault/',
    'cache/',
    'logs/',
    '**/*.min.js',
  ],
  rules: {
    'no-empty': 'warn',
    'no-dupe-keys': 'warn',
    'no-unreachable': 'warn',
  },
};
