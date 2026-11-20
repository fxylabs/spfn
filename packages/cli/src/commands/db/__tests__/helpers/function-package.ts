import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * The fake function package `@spfn/i163fix` installed in `root`'s node_modules,
 * shipping one migration folder `name` whose SQL is `sql`. Its bookkeeping table
 * is `drizzle."__spfn_fn_i163fix_migrations"`; the schema it owns is spfn_i163fix.
 */
export function writeFunctionPackage(root: string, name: string, sql: string): void
{
    const packageRoot = join(root, 'node_modules', '@spfn', 'i163fix');
    const migration = join(packageRoot, 'migrations', name);

    mkdirSync(migration, { recursive: true });
    writeFileSync(join(migration, 'migration.sql'), sql);
    writeFileSync(join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@spfn/i163fix', version: '1.0.0', spfn: { migrations: { dir: './migrations' } } }));
}
