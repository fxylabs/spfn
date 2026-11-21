/**
 * Probes on the built entries, run by scripts/check-bundle-identity.mjs at the repository root
 * after the build.
 *
 * Private imports (`scripts/lib/private-imports.mjs` at the repository root): `nextjs/client`
 * is a build of its own that reaches the main build only through `#nextjs/client-shared`, and
 * every `#…` import in `dist` resolves to a file exporting what it imports, and in declarations
 * to a declaration file.
 */

import { fileURLToPath } from 'node:url';

import { checkPrivateImports } from '../../../scripts/lib/private-imports.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

if (!await checkPrivateImports(DIST, specifier => import.meta.resolve(specifier)))
{
    process.exit(1);
}
