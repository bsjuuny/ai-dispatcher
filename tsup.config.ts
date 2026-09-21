import { defineConfig } from 'tsup';

// The CLI is bundled with its JavaScript dependencies so a portable USB kit does
// not inherit pnpm's source-tree symlinks or require a package manager. The
// optional pino-pretty transport is not used by Dispatcher; Node built-ins stay
// external, including node:sqlite below.
export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    'harness-cli': 'src/harness/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: false,
  noExternal: ['commander', 'execa', 'js-yaml', 'pino', 'zod'],
  // esbuild has been observed to rewrite `node:sqlite` to the bare specifier
  // `sqlite` (which does not exist as an npm package) despite `platform: 'node'` -
  // explicitly listing it external, with the exact prefixed spelling, works around
  // that rewrite. Verified by inspecting dist/cli.js after build - see
  // docs/architecture.md.
  external: ['node:sqlite'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
