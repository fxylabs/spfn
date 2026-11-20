---
title: "Custom Generators"
description: "Learn how to create custom code generators for your Superfunction project"
order: 5
available: true
---

# Custom Generators

Superfunction's code generation system is extensible, allowing you to create custom generators for any code generation needs in your project.

## What are Generators?

Generators are automated tools that scan your codebase and generate code based on patterns or conventions. Common use cases include:

- Generating route metadata for RPC clients (built-in)
- Creating navigation menus from route configurations
- Building database migrations from schema definitions
- Generating type definitions from external APIs
- Creating form components from data models

## Basic Generator Structure

A generator is a simple object that implements the `Generator` interface. The file must
**default-export a zero-argument factory** that returns it — the loader calls the default
export with no arguments (a named `createGenerator` export is the only accepted
alternative), so a factory that requires parameters will not load:

```typescript
// src/generators/my-generator.ts
import type { Generator, GeneratorOptions } from '@spfn/core/codegen';

export default function createMyGenerator(): Generator {
  return {
    // Unique name for this generator
    name: 'my-generator',

    // File patterns to watch (glob syntax)
    watchPatterns: ['src/features/**/*.config.ts'],

    // When to run: 'watch' | 'manual' | 'build' | 'start'
    // Default: ['watch', 'manual', 'build'] — omit it unless you mean to narrow it
    runOn: ['watch', 'manual', 'build'],

    // Main generation function
    async generate(options: GeneratorOptions): Promise<void> {
      const { cwd, debug } = options;

      // 1. Scan source files
      // 2. Process data
      // 3. Generate output files

      if (debug) {
        console.log('✅ Generated successfully');
      }
    }
  };
}
```

## Understanding `runOn`

The `runOn` option controls when your generator executes:

| Trigger | Fired by | Use Case |
|---------|----------|----------|
| `watch` | `spfn dev` — the initial pass and every file change | Development-time updates |
| `manual` | `spfn codegen run` and `spfn contract` | On-demand generation |
| `build` | `spfn build` | Build-time generation |
| `start` | nothing in the shipped CLI | reserved for a programmatic caller |

> **Include `build` if the generator has to run during `spfn build`.** This is the trap:
> `runOn: ['watch', 'manual']` looks like "development and on demand", but it silently skips
> the build. Both built-in generators list `build` for exactly this reason — a route map or a
> contract that is not regenerated during the build is a stale artifact shipped to production.

**Examples:**

```typescript
// The default when `runOn` is omitted — every trigger the CLI actually fires
runOn: ['watch', 'manual', 'build']

// Development and builds, but not `spfn codegen run`
runOn: ['watch', 'build']

// Only on an explicit run — for something too slow to sit in the watcher
runOn: ['manual']
```

## Example: Admin Navigation Generator

Let's build a real-world generator that creates navigation menus from route configuration files.

### Step 1: Define the Structure

```typescript
// src/app/admin/users/nav.config.tsx
export const navConfig = {
  title: 'Users',
  icon: 'Users',
  path: '/admin/users',
  order: 10
};
```

### Step 2: Create the Generator

```typescript
// src/generators/admin-nav-generator.ts
import type { Generator, GeneratorOptions } from '@spfn/core/codegen';
import { glob } from 'glob';
import { createJiti } from 'jiti';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

interface NavItem {
  title: string;
  icon: string;
  path: string;
  order: number;
}

export default function createAdminNavGenerator(): Generator {
  return {
    name: 'admin-nav',
    watchPatterns: ['src/app/admin/**/nav.config.tsx'],
    runOn: ['watch', 'manual', 'build'],

    async generate(options: GeneratorOptions): Promise<void> {
      const { cwd, debug } = options;

      if (debug) {
        console.log('🔄 Generating admin navigation...');
      }

      // 1. Find all nav.config.tsx files
      const configFiles = await glob(
        'src/app/admin/**/nav.config.tsx',
        { cwd, absolute: true }
      );

      // 2. Extract nav items
      const navItems: NavItem[] = [];

      // Note: plain `await import()` cannot load .ts/.tsx in Node. Load through jiti —
      // the same loader the codegen system uses to load this generator file.
      const jiti = createJiti(cwd, { interopDefault: true, moduleCache: false });

      for (const file of configFiles) {
        const module = jiti(file);
        if (module.navConfig) {
          navItems.push(module.navConfig);
        }
      }

      // 3. Sort by order
      navItems.sort((a, b) => a.order - b.order);

      // 4. Generate TypeScript file
      const outputPath = join(cwd, 'src/lib/admin/nav-data.generated.ts');
      const code = generateNavCode(navItems);

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, code, 'utf-8');

      if (debug) {
        console.log(`✅ Generated ${navItems.length} navigation items`);
      }
    }
  };
}

function generateNavCode(items: NavItem[]): string {
  return `/**
 * Auto-generated admin navigation
 * Do not edit this file manually!
 */

export const adminNavItems = ${JSON.stringify(items, null, 2)} as const;

export type AdminNavItem = typeof adminNavItems[number];
`;
}
```

### Step 3: Register the Generator

`.spfnrc.ts` is the primary config file — it is what `spfn codegen init` and `spfn init`
scaffold, and its default export *is* the config:

```typescript
// .spfnrc.ts
import { defineConfig } from '@spfn/core/codegen';

export default defineConfig({
  generators: [
    { path: './src/generators/admin-nav-generator.ts' },
  ],
});
```

`.spfnrc.json` also works, but the config must sit under a top-level `codegen` key
(a bare top-level `generators` array is ignored):

```json
// .spfnrc.json
{
  "codegen": {
    "generators": [
      {
        "path": "./src/generators/admin-nav-generator.ts"
      }
    ]
  }
}
```

Resolution order is `.spfnrc.ts` → `.spfnrc.json` → `package.json` (`spfn.codegen`), and
the **first file found wins** — configs are not merged.

### Step 4: Use Generated Code

```typescript
// src/app/admin/layout.tsx
import { adminNavItems } from '@/lib/admin/nav-data.generated';

export default function AdminLayout({ children }) {
  return (
    <div>
      <nav>
        {adminNavItems.map((item) => (
          <a key={item.path} href={item.path}>
            {item.title}
          </a>
        ))}
      </nav>
      {children}
    </div>
  );
}
```

## Implementing Incremental Updates

For better performance, generators can implement smart regeneration by checking the `trigger` option:

```typescript
async generate(options: GeneratorOptions): Promise<void> {
  const { cwd, trigger } = options;

  // Check if triggered by file change
  if (trigger?.changedFile) {
    const { path, event } = trigger.changedFile;

    // If you can do incremental update
    if (event === 'change' && canUpdateIncrementally(path)) {
      await updateSingleFile(path);
      return; // Skip full regeneration
    }

    // If file was added or deleted, need full regeneration
    if (event === 'add' || event === 'unlink') {
      // Fall through to full regeneration
    }
  }

  // Full regeneration
  await fullRegenerate(cwd);
}
```

`changedFile` is set only when exactly one change triggered the run. `spfn dev`'s watcher takes
every change that arrived while a generation ran into the next one, so a run can be for several:
`trigger.changedFiles` lists them all (each `{ path, event }`, relative to the project root).
Neither is set on the initial watch pass, or for `manual`/`build`; fall back to a full
regeneration then.

### When to Use Incremental Updates

**Good candidates:**
- Large codebases with many source files
- Independent file processing (no cross-file dependencies)
- Expensive computation per file

**Not recommended:**
- Small projects (overhead > benefit)
- Files with complex interdependencies
- When full regen is already fast (< 100ms)

## Generator Configuration

A `{ path: ... }` entry gets **no configuration**. The loader calls the file's default
export with zero arguments and ignores every other key on the entry — an `"options"` key
next to `"path"` is silently dropped. So a file-based generator holds its settings itself:

```typescript
// src/generators/feature-generator.ts
import type { Generator, GeneratorOptions } from '@spfn/core/codegen';
import { join } from 'path';

const OUTPUT_DIR = 'src/lib/features';

export default function createFeatureGenerator(): Generator {
  return {
    name: 'feature-generator',
    watchPatterns: ['src/features/**/*.feature.ts'],

    async generate(options: GeneratorOptions): Promise<void> {
      const output = join(options.cwd, OUTPUT_DIR);
      // ...
    }
  };
}
```

To make a generator configurable, publish it as a **package generator** instead. Those are
named `package:generator` and the loader imports `${package}/codegen`, looks up
`generators[generatorName]`, and calls it with the config entry minus `name` and `enabled`:

```typescript
// my-package/src/codegen/index.ts
export const generators = {
  'feature': (config: FeatureGeneratorConfig) => createFeatureGenerator(config),
};
```

```jsonc
// .spfnrc.json — extra keys sit on the entry itself, not under "options"
{
  "codegen": {
    "generators": [
      {
        "name": "my-package:feature",
        "outputDir": "src/lib/features",
        "includeTests": true
      }
    ]
  }
}
```

The `name` **must** contain a `:` — a colon-less name is rejected as invalid. Set
`"enabled": false` to skip an entry without deleting it.

## Testing Your Generator

Create tests to ensure your generator works correctly:

```typescript
// src/generators/__tests__/admin-nav-generator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import createAdminNavGenerator from '../admin-nav-generator';

const TEST_DIR = join(process.cwd(), '.test-tmp');

describe('Admin Nav Generator', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should generate navigation from config files', async () => {
    // Setup: Create test config files
    const configDir = join(TEST_DIR, 'src/app/admin/users');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, 'nav.config.tsx'),
      `export const navConfig = {
        title: 'Users',
        icon: 'Users',
        path: '/admin/users',
        order: 10
      };`
    );

    // Run generator
    const generator = createAdminNavGenerator();
    await generator.generate({
      cwd: TEST_DIR,
      debug: true
    });

    // Verify output
    const outputPath = join(TEST_DIR, 'src/lib/admin/nav-data.generated.ts');
    const output = readFileSync(outputPath, 'utf-8');

    expect(output).toContain('Users');
    expect(output).toContain('/admin/users');
  });
});
```

## Best Practices

### 1. Always Generate with Headers

Add a header comment to generated files:

```typescript
const code = `/**
 * Auto-generated by ${generator.name}
 *
 * DO NOT EDIT THIS FILE MANUALLY!
 * Changes will be overwritten on next generation.
 *
 * Generated at: ${new Date().toISOString()}
 * Source: ${sourceFiles.join(', ')}
 */

${generatedCode}
`;
```

### 2. Use Consistent File Naming

Follow conventions for generated files:

```typescript
// Good
'src/lib/api.generated.ts'
'src/types/models.generated.ts'
'src/config/routes.generated.ts'

// Avoid
'src/lib/api.ts'  // Looks like manual code
'src/lib/api_gen.ts'  // Inconsistent naming
```

### 3. Validate Input Before Generation

```typescript
async generate(options: GeneratorOptions): Promise<void> {
  const sourceFiles = await findSourceFiles(options.cwd);

  // Validate before generating
  if (sourceFiles.length === 0) {
    if (options.debug) {
      console.warn('No source files found, skipping generation');
    }
    return;
  }

  // Validate each file
  for (const file of sourceFiles) {
    const isValid = await validateFile(file);
    if (!isValid) {
      throw new Error(`Invalid source file: ${file}`);
    }
  }

  // Now generate
  await doGeneration(sourceFiles);
}
```

### 4. Handle Errors Gracefully

```typescript
async generate(options: GeneratorOptions): Promise<void> {
  try {
    await doGeneration(options);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    console.error(`[${this.name}] Generation failed:`, err.message);

    if (options.debug) {
      console.error('Stack trace:', err.stack);
    }

    throw err; // Re-throw for orchestrator to handle
  }
}
```

The orchestrator catches per generator, so one failure is logged and the remaining
generators still run. Don't throw to mean "nothing to do" — it is recorded as a failure.
Return early instead, the way the built-in route-map generator does when its router file
is absent.

### 5. Provide Debug Information

```typescript
async generate(options: GeneratorOptions): Promise<void> {
  const startTime = Date.now();

  if (options.debug) {
    console.log(`[${this.name}] Starting generation...`);
  }

  const result = await doGeneration(options);

  if (options.debug) {
    const duration = Date.now() - startTime;
    console.log(`[${this.name}] Generated ${result.filesGenerated} files in ${duration}ms`);
  }
}
```

## Advanced Example: Database Schema Generator

A more complex generator that creates TypeScript types from database schemas:

```typescript
// src/generators/db-schema-generator.ts
import type { Generator, GeneratorOptions } from '@spfn/core/codegen';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Client } from 'pg';

export default function createDbSchemaGenerator(): Generator {
  return {
    name: 'db-schema',
    watchPatterns: ['src/db/schema/**/*.ts'],
    runOn: ['manual'], // Not watch (DB changes are less frequent)

    async generate(options: GeneratorOptions): Promise<void> {
      const { cwd, debug } = options;

      // Connect to database
      const client = new Client({
        connectionString: process.env.DATABASE_URL
      });

      await client.connect();

      try {
        // Query schema information
        const tables = await client.query(`
          SELECT table_name, column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position
        `);

        // Generate TypeScript types
        const types = generateTypesFromSchema(tables.rows);

        // Write to file
        const outputPath = join(cwd, 'src/types/db.generated.ts');
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, types);

        if (debug) {
          console.log(`✅ Generated types for ${tables.rowCount} columns`);
        }
      } finally {
        await client.end();
      }
    }
  };
}
```

## Troubleshooting

### Generator Not Running

**Check `runOn` configuration:**
```typescript
// If the generator isn't running during `spfn dev`
runOn: ['watch', ...]   // include 'watch'

// If it isn't running on `spfn codegen run`
runOn: ['manual', ...]  // include 'manual'

// If it isn't running during `spfn build`
runOn: ['build', ...]   // include 'build' — this one is easy to miss
```

**Verify registration:**
```json
// .spfnrc.json - Check path is correct
{
  "codegen": {
    "generators": [
      {
        "path": "./src/generators/my-generator.ts"  // Must be relative to project root
      }
    ]
  }
}
```

Remember that `.spfnrc.ts` **fully shadows** `.spfnrc.json`. If both exist, only the
TypeScript one is read — the JSON registration is never seen.

**Check the loader's expectations:** a `{ path }` generator file must default-export a
zero-argument function. Exporting the `Generator` object itself, or a factory that needs
arguments, logs `Invalid generator at <path>: expected function` (or throws) and the
generator is skipped. A failed load never stops the other generators.

### Files Not Being Watched

**Check glob patterns:**
```typescript
// Too specific
watchPatterns: ['src/app/admin/users/nav.config.tsx']  // Only one file

// Better
watchPatterns: ['src/app/admin/**/nav.config.tsx']  // All nav.config.tsx files
```

What the watcher regenerates for is a file matching `watchPatterns`, or a project file a
previous run of the generator *imported through the codegen loader* (as the built-in generators
load the router). A file your generator reads with `fs` is watched only through
`watchPatterns`; `.env` files, packages under `node_modules` and the codegen config are not
watched — restart `spfn dev` after changing them. See the codegen README's "Watch mode".

### Performance Issues

**Use incremental updates:**
```typescript
if (options.trigger?.changedFile) {
  // Only process changed file
  await processFile(options.trigger.changedFile.path);
  return;
}

// Fallback: full regeneration
await processAllFiles();
```

## Next Steps

- Review the [built-in route-map generator](/docs/packages/core/codegen) for a complete example
- See [`@spfn/core/errors`](/docs/packages/core/errors) for the error classes a generator should throw

> **Tip:** Start simple! Create a basic generator first, then add features like incremental updates and configuration options as needed.