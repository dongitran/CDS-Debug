export default {
  'src/**/*.ts': (files) =>
    `pnpm exec eslint --fix --max-warnings=0 ${files.join(' ')}`,
  'test/**/*.ts': (files) =>
    `pnpm exec eslint --fix --max-warnings=0 ${files.join(' ')}`,
  '**/*.{ts,json}': (files) =>
    `pnpm exec cspell --no-progress --no-summary ${files.join(' ')}`,
};
