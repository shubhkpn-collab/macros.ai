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
 * treats them as first-party packages. That is exactly our layout, and it means
 * we do not have to convert the repository to npm workspaces just to satisfy
 * the bundler.
 *
 * `nodeModulesPaths` deliberately lists the app's own `node_modules` FIRST so
 * React and React Native resolve from there. Two copies of React in one bundle
 * is a hook-dispatcher crash, not a warning.
 */
module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  watchFolders: [workspaceRoot],
  resolver: {
    enableGlobalPackages: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
});
