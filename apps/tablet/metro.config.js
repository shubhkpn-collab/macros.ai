const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

/**
 * Metro monorepo resolution.
 *
 * `watchFolders` makes the workspace source VISIBLE, but visibility alone does
 * not make `@macros/*` resolvable by name — and this repository is not an npm
 * workspace, so there are no symlinks in the root `node_modules` for Metro to
 * follow either.
 *
 * `enableGlobalPackages` is the supported mechanism: Metro reads the `name`
 * field of every package.json under the project root and watch folders and
 * treats them as first-party packages.
 *
 * `nodeModulesPaths` lists the app's own `node_modules` FIRST so React and
 * React Native resolve from there. Two copies of React in one bundle is a
 * hook-dispatcher crash, not a warning.
 */
const defaultConfig = getDefaultConfig(projectRoot);

/**
 * ESM-STYLE `.js` SPECIFIER FALLBACK.
 *
 * The monorepo writes TypeScript with Node/ESM relative specifiers — `import
 * './composition.js'` where the file on disk is `composition.ts`. That is
 * correct for `tsc` under NodeNext and is used throughout the first-party
 * packages; Metro's default resolver does not know the convention and returned
 * HTTP 500 with `UnableToResolveError`.
 *
 * Rewriting hundreds of imports across the monorepo to suit one bundler would
 * be the wrong trade, so this narrows the gap instead. The fallback is
 * deliberately hard to over-apply:
 *
 *   1. Metro's own resolver runs FIRST and always wins when it succeeds.
 *   2. Only RELATIVE specifiers (`./` or `../`) are eligible.
 *   3. Only specifiers ending in `.js`.
 *   4. Only when the importing file lives inside the workspace — a `.js`
 *      specifier from inside node_modules is a real third-party path and must
 *      keep failing loudly rather than being silently rewritten.
 *   5. On any failure of the retry, the ORIGINAL error is rethrown, so a
 *      genuine missing module still reports the specifier the author wrote.
 */
const isWithinWorkspace = (filePath) => {
  if (typeof filePath !== 'string') return false;
  const relative = path.relative(workspaceRoot, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  // node_modules is outside our source convention even when nested inside.
  return !relative.split(path.sep).includes('node_modules');
};

const resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (originalError) {
    const relative = moduleName.startsWith('./') || moduleName.startsWith('../');
    if (!relative || !moduleName.endsWith('.js')) throw originalError;
    if (!isWithinWorkspace(context.originModulePath)) throw originalError;

    // Drop the `.js` and let Metro apply its normal sourceExts (.ts/.tsx/.js).
    const withoutSuffix = moduleName.slice(0, -'.js'.length);
    try {
      return context.resolveRequest(context, withoutSuffix, platform);
    } catch {
      throw originalError;
    }
  }
};

module.exports = mergeConfig(defaultConfig, {
  watchFolders: [workspaceRoot],
  resolver: {
    enableGlobalPackages: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    resolveRequest,
  },
});
