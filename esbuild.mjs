import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 uses optional native accelerators behind try/catch and has a complete
  // pure-JS fallback. Keep those optional imports unresolved so the packaged
  // extension does not depend on platform-specific binaries.
  external: ['vscode', 'cpu-features', '*.node'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await esbuild.build(options);
  console.log('[esbuild] build complete');
}
