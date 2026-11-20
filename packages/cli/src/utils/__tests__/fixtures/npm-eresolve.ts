/**
 * npm's own stderr for a refused install, captured verbatim from real runs of
 * npm 10.9.9 (Node 22.23.4) on 2026-11-20; only the home directory in the log
 * paths is shortened to `~`. Should npm change this wording, the rows that
 * read these strings no longer describe npm: capture them again.
 */

/**
 * `npm install --save-dev @svgr/webpack` in an app whose package.json declares
 * `drizzle-orm@1.0.0-rc.4` and `drizzle-typebox@^0.3.3`.
 */
export const NPM_ERESOLVE_DRIZZLE_TYPEBOX = `npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: app@0.0.0
npm error Found: drizzle-orm@1.0.0-rc.4
npm error node_modules/drizzle-orm
npm error   drizzle-orm@"1.0.0-rc.4" from the root project
npm error
npm error Could not resolve dependency:
npm error peer drizzle-orm@">=0.36.0" from drizzle-typebox@0.3.3
npm error node_modules/drizzle-typebox
npm error   drizzle-typebox@"^0.3.3" from the root project
npm error
npm error Fix the upstream dependency conflict, or retry
npm error this command with --force or --legacy-peer-deps
npm error to accept an incorrect (and potentially broken) dependency resolution.
npm error
npm error
npm error For a full report see:
npm error ~/.npm/_logs/2026-11-20T14_10_26_348Z-eresolve-report.txt
npm error A complete log of this run can be found in: ~/.npm/_logs/2026-11-20T14_10_26_348Z-debug-0.log`;

/**
 * `npm install` in an app whose package.json declares `react@18.3.1` and
 * `react-dom@19.2.1`: an ERESOLVE that names another package.
 */
export const NPM_ERESOLVE_OTHER = `npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: app@0.0.0
npm error Found: react@18.3.1
npm error node_modules/react
npm error   react@"18.3.1" from the root project
npm error
npm error Could not resolve dependency:
npm error peer react@"^19.2.1" from react-dom@19.2.1
npm error node_modules/react-dom
npm error   react-dom@"19.2.1" from the root project
npm error
npm error Fix the upstream dependency conflict, or retry
npm error this command with --force or --legacy-peer-deps
npm error to accept an incorrect (and potentially broken) dependency resolution.
npm error
npm error
npm error For a full report see:
npm error ~/.npm/_logs/2026-11-20T14_10_30_403Z-eresolve-report.txt
npm error A complete log of this run can be found in: ~/.npm/_logs/2026-11-20T14_10_30_403Z-debug-0.log`;
