/**
 * Push Steps
 *
 * `spfn db push` does not rename. drizzle-kit's `pushSchema` asks whether an
 * object removed and one added of the same kind are one object renamed, and
 * gives its caller no way to answer: a diff holding both ends in
 * `resolver(<kind>) was called without a HintsHandler` (ambiguousKindOf). So
 * push plans as drizzle-kit does — one pushSchema call on the plain diff — and
 * only when drizzle-kit itself reports such a kind does it plan two steps,
 * each of which has nothing to ask: first what disappeared is dropped, then
 * what is new is created (see planDropsThenCreates).
 */

import { sql } from 'drizzle-orm';

import type { PushConnection } from './drizzle.js';
import { compareChecks, typesThisPushChanges, type CheckComparison, type DeclaredEntity } from './changed-checks.js';
import { existingObjects, preserveEntityNames, type SchemaObject } from './push-identity.js';
import { qualifiedName, quoteIdent } from '../tenant/plan.js';

type Db = PushConnection['db'];

/**
 * Where push plans: its connection, and a transaction that always rolls back
 * on the one session `db` runs on — createPushConnection's, never a pool's.
 */
export type PlanConnection = Pick<PushConnection, 'db' | 'inRolledBackTransaction'>;

/** The statements one `pushSchema` call plans, its hints' statements first. */
export interface StepPlan
{
    statements: string[];
    hints: { hint: string; statement?: string }[];
}

/** Kinds of object `pushSchema` asks about, as drizzle-kit names them, with the word a person reads. */
const SCHEMA_WIDE_KINDS = new Map([
    ['schemas', 'schema'],
    ['enums', 'enum'],
    ['sequences', 'sequence'],
    ['tables', 'table'],
    ['views', 'view'],
]);

/** The kinds drizzle-kit asks about one table at a time. */
const TABLE_KINDS = new Map([
    ['columns', 'column'],
    ['indexes', 'index'],
    ['pks', 'primary key'],
    ['uniques', 'unique constraint'],
    ['fks', 'foreign key'],
    ['checks', 'check'],
    ['policies', 'policy'],
]);

/** Each kind drizzle-kit's resolver names (`resolver(<kind>)`), as its DDL keys the objects of that kind. */
const RESOLVER_KINDS = new Map([
    ['schema', 'schemas'],
    ['enum', 'enums'],
    ['sequence', 'sequences'],
    ['table', 'tables'],
    ['view', 'views'],
    ['column', 'columns'],
    ['index', 'indexes'],
    ['primary_key', 'pks'],
    ['unique', 'uniques'],
    ['foreign key', 'fks'],
    ['check', 'checks'],
    ['policy', 'policies'],
]);

/**
 * A table cannot hold two primary keys, so the new one cannot be created
 * beside the old to plan the drops (see planDropsThenCreates).
 */
const UNSPLITTABLE_KINDS = new Set(['pks']);

/**
 * What drizzle-kit 1.0.0-rc.4 throws when one diff holds objects of one kind
 * both removed and added: its resolver's `new Error(\`Internal error:
 * resolver(${entity}) was called without a HintsHandler\`)`, the whole message.
 */
const AMBIGUITY = /^Internal error: resolver\(([a-z_ ]+)\) was called without a HintsHandler$/;

/**
 * The kind drizzle-kit reports as removed and added in one diff, or undefined
 * for any other error — a drizzle-kit that words it otherwise included, so
 * that error surfaces unchanged.
 */
export function ambiguousKindOf(error: unknown): string | undefined
{
    return error instanceof Error ? AMBIGUITY.exec(error.message)?.[1] : undefined;
}

/** The word a person reads for a kind drizzle-kit's resolver names. */
function kindWord(kind: string): string
{
    const entityType = RESOLVER_KINDS.get(kind) ?? kind;

    return SCHEMA_WIDE_KINDS.get(entityType) ?? TABLE_KINDS.get(entityType) ?? kind;
}

/** One kind (one table, for a kind that lives in one) with objects both removed and added. */
export interface Replacement
{
    /** 'table', 'column', …: the kind as a person reads it */
    kind: string;
    /** `"schema"."table"`, for a kind that lives in a table */
    table?: string;
    removed: string[];
    added: string[];
}

export interface SchemaChanges
{
    /** Each group with something removed and something added: what the two steps drop, then create */
    replacements: Replacement[];
    /** Each object created before the drops whose name an object this push removes still holds (heldNames) */
    heldNames: HeldName[];
    /** The statements that create the added objects created before the drops are planned (planDropsThenCreates) */
    createAdded: () => Promise<string[]>;
}

/** An added object push must create before the drops, and the removed object that holds its name until then. */
export interface HeldName
{
    /** `index "idx_x" on "schema"."t"`, …: the object as a person reads it */
    created: string;
    holder: string;
    /** An object this push adds that `created` names by identifier (namesCreated), when it does */
    names?: string;
}

/**
 * The kinds created before the drops are planned whichever kind drizzle-kit
 * reported, since other objects live in them or are typed by them; each is
 * one object to drizzle-kit by name alone.
 */
const PREREQUISITE_KINDS = new Set(['schemas', 'enums', 'sequences', 'tables', 'columns']);

/**
 * PostgreSQL's namespaces that hold the names of more than one kind push
 * compares: a relation's name (a unique constraint's and a primary key's
 * index take theirs) and a type's (a table's and a view's row type) are
 * unique within a schema, a constraint's within a table. Two objects of one
 * kind and one name in one schema or table are one object to drizzle-kit.
 */
const NAMESPACES = [
    { kinds: new Set(['tables', 'views', 'sequences', 'indexes', 'uniques', 'pks']), scope: (object: SchemaObject) => [object.schema] },
    { kinds: new Set(['enums', 'tables', 'views']), scope: (object: SchemaObject) => [object.schema] },
    { kinds: new Set(['uniques', 'pks', 'fks', 'checks']), scope: (object: SchemaObject) => [object.schema, object.table] },
];

const isCompared = (object: SchemaObject) => SCHEMA_WIDE_KINDS.has(object.entityType) || TABLE_KINDS.has(object.entityType);

const keyOf = (object: SchemaObject) => JSON.stringify([object.entityType, object.schema ?? null, object.table ?? null, object.name]);

/** What drizzle-kit asks about together: a schema-wide kind, or a kind within one table. */
const groupOf = (object: SchemaObject) => JSON.stringify(TABLE_KINDS.has(object.entityType)
    ? [object.entityType, object.schema, object.table]
    : [object.entityType]);

/**
 * Which declared objects `db` lacks (added) and which objects it holds that
 * are not declared (removed), as drizzle-kit's push tells them apart
 * (push-identity.ts) — read once, reading only. Each group with objects both
 * removed and added is listed: the two steps drop, then create them all.
 * `kinds` are the DDL kinds drizzle-kit reported removed and added: what
 * must exist before the drops are planned is created first (createdFirst),
 * and each of those whose name a removed object still holds is returned.
 */
export async function readSchemaChanges(
    imports: Record<string, unknown>,
    db: Db,
    schemaFilter: string[],
    kinds: Set<string>,
): Promise<SchemaChanges>
{
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api-postgres');
    const snapshot = await generateDrizzleJson(imports, undefined, schemaFilter);
    const existing = (await existingObjects(db, imports, schemaFilter)).filter(isCompared);
    const declared = preserveEntityNames(existing, snapshot.ddl as SchemaObject[]);
    const added = without(declared.filter(isCompared), existing);
    const removed = without(existing, declared);
    const seeds = added.filter(object => kinds.has(object.entityType) || PREREQUISITE_KINDS.has(object.entityType));
    const named = namesCreated(seeds);
    const first = createdFirst(declared, added, seeds, named);

    return {
        replacements: replacementsOf(removed, added),
        heldNames: heldNames(declared.filter((object, i) => first.has(i) && isCompared(object)), removed, named),
        createAdded: () => generateMigration({ ...snapshot, ddl: snapshot.ddl.filter((_entity, i) => !first.has(i)) }, snapshot),
    };
}

/**
 * The positions in `declared` of what must exist before the drops are
 * planned: `seeds` — the added objects of the reported kinds and of
 * PREREQUISITE_KINDS — all that lives in an added table or schema, every
 * added object `named` finds naming one of them — planned in the drops step,
 * it would run before what it names exists — and what each foreign key among
 * them references (withKeysAndReferences). generateMigration orders them as
 * PostgreSQL accepts: a unique constraint or index before a foreign key.
 */
function createdFirst(
    declared: SchemaObject[],
    added: SchemaObject[],
    seeds: SchemaObject[],
    named: (object: SchemaObject) => SchemaObject | undefined,
): Set<number>
{
    const seeded = new Set(seeds.map(keyOf));
    const containers = new Set(seeds.filter(object => ['schemas', 'tables'].includes(object.entityType))
        .map(object => object.entityType === 'schemas' ? JSON.stringify([object.name]) : JSON.stringify([object.schema, object.name])));
    const inContainer = (object: SchemaObject) => containers.has(JSON.stringify([object.schema]))
        || containers.has(JSON.stringify([object.schema, object.table]));
    const first = withKeysAndReferences(added.filter(object => seeded.has(keyOf(object)) || inContainer(object) || named(object)), added);
    const firstKeys = new Set(first.map(keyOf));

    return new Set(declared.flatMap((object, i) => firstKeys.has(keyOf(object)) || inContainer(object) ? [i] : []));
}

/**
 * The one of `created` an object's own definition names by identifier, or
 * undefined: a column of its table among its columns, or an expression token
 * (identifiersOf) equal to the name of such a column or of an added table,
 * view, enum or sequence in any schema, whatever the token's role in the
 * expression — a type in a cast, a function, another table's column — so a
 * name shared by chance counts, and a dependency through another table's
 * column does not. Living on a table that gains a column is not naming it; a
 * foreign key that references a new column references a key added on it,
 * and joins with that key (withKeysAndReferences).
 */
function namesCreated(created: SchemaObject[]): (object: SchemaObject) => SchemaObject | undefined
{
    const columnKey = (schema: unknown, table: unknown, name: string) => JSON.stringify([schema, table, name]);
    const columns = new Map(created.filter(object => object.entityType === 'columns').map(column => [columnKey(column.schema, column.table, column.name), column]));
    const schemaWide = new Map(created.filter(object => ['tables', 'views', 'enums', 'sequences'].includes(object.entityType)).map(object => [object.name, object]));

    return object =>
    {
        const { columns: own, expressions } = definitionOf(object);
        const identifiers = expressions.flatMap(identifiersOf);

        return [...own, ...identifiers].map(name => columns.get(columnKey(object.schema, object.table, name))).find(Boolean)
            ?? identifiers.map(name => schemaWide.get(name)).find(Boolean);
    };
}

/** The columns an object of a table lists, and the SQL expressions it holds, as drizzle-kit's DDL keeps them. */
function definitionOf(object: SchemaObject): { columns: string[]; expressions: string[] }
{
    const texts = (...values: unknown[]) => values.filter((value): value is string => typeof value === 'string');

    switch (object.entityType)
    {
        case 'indexes':
        {
            const entries = object.columns as { value: string; isExpression: boolean }[];

            return {
                columns: entries.filter(entry => !entry.isExpression).map(entry => entry.value),
                expressions: texts(...entries.filter(entry => entry.isExpression).map(entry => entry.value), object.where),
            };
        }
        case 'uniques':
        case 'pks':
        case 'fks':
            return { columns: object.columns as string[], expressions: [] };
        case 'checks':
            return { columns: [], expressions: texts(object.value) };
        case 'policies':
            return { columns: [], expressions: texts(object.using, object.withCheck) };
        default:
            return { columns: [], expressions: [] };
    }
}

/**
 * The tokens of an SQL expression as PostgreSQL's lexer reads them with
 * standard_conforming_strings on, as drizzle-kit emits: a comment, a string
 * literal — standard (B'', X'', N'' and U&'' alike), E'' with its backslash
 * escapes, or the opening tag of a dollar-quoted one — a number, a quoted
 * identifier (group 1) or a bare one (group 2). What matches none is an
 * operator, punctuation or a parameter.
 */
const SQL_TOKEN = new RegExp([
    /--[^\n]*/.source,
    /\/\*/.source,
    /[Ee]'(?:[^'\\]|\\[\s\S]|'')*'/.source,
    /(?:[BbXxNn]|[Uu]&)?'(?:[^']|'')*'/.source,
    /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.source,
    /0[XxOoBb][0-9A-Fa-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[Ee][+-]?\d+)?/.source,
    /"((?:[^"]|"")*)"/.source,
    /([A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)/.source,
].join('|'), 'g');

/**
 * The identifiers an SQL expression names, as PostgreSQL folds them: a
 * quoted one as written, a bare one with its ASCII letters lower-cased;
 * comments, string literals and numbers skipped.
 */
function identifiersOf(expression: string): string[]
{
    const tokens = new RegExp(SQL_TOKEN);
    const identifiers: string[] = [];

    for (let match = tokens.exec(expression); match; match = tokens.exec(expression))
    {
        const [token, quoted, bare] = match;

        tokens.lastIndex = endOf(token, expression, tokens.lastIndex);
        if (quoted !== undefined)
        {
            identifiers.push(quoted.replaceAll('""', '"'));
        }
        else if (bare !== undefined)
        {
            identifiers.push(bare.replace(/[A-Z]/g, letter => letter.toLowerCase()));
        }
    }

    return identifiers;
}

/**
 * Where a token that starts at `from` ends in `expression`: a dollar-quoted
 * string at its closing tag, a block comment where its nesting closes, any
 * other token where SQL_TOKEN's match did.
 */
function endOf(token: string, expression: string, from: number): number
{
    if (token.startsWith('$'))
    {
        const close = expression.indexOf(token, from);

        return close === -1 ? expression.length : close + token.length;
    }

    return token === '/*' ? commentEnd(expression, from) : from;
}

/** Where a block comment whose opening ends at `from` closes: PostgreSQL nests them. */
function commentEnd(expression: string, from: number): number
{
    let depth = 1;
    let at = from;

    while (depth > 0 && at < expression.length)
    {
        const pair = expression.slice(at, at + 2);

        depth += pair === '/*' ? 1 : pair === '*/' ? -1 : 0;
        at += pair === '/*' || pair === '*/' ? 2 : 1;
    }

    return at;
}

/**
 * `first`, with each added unique constraint, primary key or unique index a
 * foreign key among them references, and each added foreign key that
 * references one among them — created after the drops, it would be planned
 * in the drops step while what it references exists only before them —
 * until no more is added. Such a key names only columns of its own table,
 * so it needs nothing more of this push.
 */
function withKeysAndReferences(first: SchemaObject[], added: SchemaObject[]): SchemaObject[]
{
    const keys = new Set(first.map(keyOf));
    const fks = added.filter(object => object.entityType === 'fks');
    const referenced = added.filter(object => fks.some(fk => references(fk, object)));
    const more = [
        ...referenced.filter(key => first.some(fk => references(fk, key))),
        ...fks.filter(fk => first.some(key => references(fk, key))),
    ].filter(object => !keys.has(keyOf(object)));

    return more.length === 0 ? first : withKeysAndReferences([...first, ...new Set(more)], added);
}

/** Whether `key` is the unique constraint, primary key or unique index foreign key `fk` references. */
function references(fk: SchemaObject, key: SchemaObject): boolean
{
    const columns = keyColumnsOf(key);
    const columnsTo = fk.columnsTo as string[] | undefined;

    return fk.entityType === 'fks' && columns !== undefined && key.schema === fk.schemaTo && key.table === fk.tableTo
        && columns.length === columnsTo!.length && columns.every(column => columnsTo!.includes(column));
}

/** The columns a unique constraint, primary key or unique index without a predicate or an expression holds unique, or undefined. */
function keyColumnsOf(object: SchemaObject): string[] | undefined
{
    if (object.entityType === 'uniques' || object.entityType === 'pks')
    {
        return object.columns as string[];
    }

    const entries = object.columns as { value: string; isExpression: boolean }[] | undefined;

    return object.entityType === 'indexes' && object.isUnique && !object.where && entries!.every(entry => !entry.isExpression)
        ? entries!.map(entry => entry.value)
        : undefined;
}

/**
 * Each of `created` whose name one of `removed` holds in a namespace of
 * PostgreSQL's (NAMESPACES): created before the drops, it would be refused.
 * Each carries what it names by identifier (`named`), when that is so.
 */
function heldNames(created: SchemaObject[], removed: SchemaObject[], named: (object: SchemaObject) => SchemaObject | undefined): HeldName[]
{
    return created.flatMap(object =>
    {
        const holder = removed.find(other => other.name === object.name && NAMESPACES.some(namespace =>
            namespace.kinds.has(object.entityType) && namespace.kinds.has(other.entityType)
            && JSON.stringify(namespace.scope(object)) === JSON.stringify(namespace.scope(other))));
        const names = named(object);

        return holder ? [{ created: describeObject(object), holder: describeObject(holder), ...names && { names: describeObject(names) } }] : [];
    });
}

/** An object as push names it to a person: its kind, its name, and the table it lives on. */
function describeObject(object: SchemaObject): string
{
    const kind = SCHEMA_WIDE_KINDS.get(object.entityType) ?? TABLE_KINDS.get(object.entityType)!;
    const where = object.table ? ` on ${qualifiedName({ schema: object.schema!, name: object.table })}` : '';

    return `${kind} ${displayName(object)}${where}`;
}

/** The objects of `objects` that `others` has no object of the same key for. */
function without(objects: SchemaObject[], others: SchemaObject[]): SchemaObject[]
{
    const keys = new Set(others.map(keyOf));

    return objects.filter(object => !keys.has(keyOf(object)));
}

/** One Replacement per group that has both removed and added objects. */
function replacementsOf(removed: SchemaObject[], added: SchemaObject[]): Replacement[]
{
    const addedGroups = new Set(added.map(groupOf));
    const groups = [...new Set(removed.map(groupOf))].filter(group => addedGroups.has(group));

    return groups.map(group =>
    {
        const names = (objects: SchemaObject[]) => objects.filter(object => groupOf(object) === group).map(displayName);
        const [entityType, schema, table] = JSON.parse(group) as string[];

        return {
            kind: SCHEMA_WIDE_KINDS.get(entityType) ?? TABLE_KINDS.get(entityType)!,
            ...(table === undefined ? {} : { table: qualifiedName({ schema, name: table }) }),
            removed: names(removed),
            added: names(added),
        };
    });
}

/** An object's name as push prints it: qualified by its schema when it has one and lives in no table. */
function displayName(object: SchemaObject): string
{
    return object.schema && !TABLE_KINDS.has(object.entityType)
        ? qualifiedName({ schema: object.schema, name: object.name })
        : quoteIdent(object.name);
}

/** What `pushSchema` plans from `db` to the declared schema: one diff, one step. */
export async function planStep(imports: Record<string, unknown>, db: Db, schemaFilter: string[]): Promise<StepPlan>
{
    const { pushSchema } = await import('drizzle-kit/api-postgres');
    const { sqlStatements, hints } = await pushSchema(imports, db, {
        schemas: schemaFilter,
        tables: [],
        entities: undefined,
        extensions: [],
    });

    return {
        statements: [...hints.flatMap(hint => hint.statement ? [hint.statement] : []), ...sqlStatements],
        hints,
    };
}

/** What push plans for the project schema: the pushSchema steps, in order, and the checks it replaces after them. */
export interface ProjectPlan
{
    steps: StepPlan[];
    /** The existing checks compared with the declared ones on the database the steps' statements leave (compareChecks) */
    checks: CheckComparison;
    /** Each kind drizzle-kit reported removed and added, as push reads it: planned as drops, then creates */
    replacements: Replacement[];
    /** Why push cannot plan it in two steps: nothing is planned, nothing applied */
    stop?: PushStop;
    /** What push must create before the drops while a removed object holds its name: nothing is planned, nothing applied */
    heldNames?: HeldName[];
    /** The error PostgreSQL gave a statement of the two steps, run in the rolled-back transaction */
    refused?: unknown;
}

/** A kind drizzle-kit reports removed and added that push does not plan in two steps, and why. */
export interface PushStop
{
    /** The kind as a person reads it */
    kind: string;
    reason: string;
    replacements: Replacement[];
}

/** drizzle-kit reported `kind` removed and added in one diff, in `error`. */
interface Ambiguity
{
    kind: string;
    error: unknown;
}

/** The comparison of a plan that stops before its statements: nothing to replace, nothing left uncompared. */
const NO_CHECKS: CheckComparison = { replacements: [], uncompared: [] };

/**
 * Plan the project schema as drizzle-kit does: one pushSchema call on the
 * plain diff, then the declared checks (`entities`) compared on the database
 * as it is. Only when drizzle-kit reports a kind with objects both removed
 * and added (ambiguousKindOf) is it planned in two steps, for that kind, in a
 * transaction that always rolls back — the only plan that writes, and the
 * only one that takes locks (planDropsThenCreates) — and the checks compared
 * there, after both steps. Any other error rejects as pushSchema gave it.
 */
export async function planProject(
    imports: Record<string, unknown>,
    connection: PlanConnection,
    schemaFilter: string[],
    entities: DeclaredEntity[],
): Promise<ProjectPlan>
{
    const plain = await stepOrAmbiguity(imports, connection.db, schemaFilter);

    if ('kind' in plain)
    {
        return planInTwoSteps(imports, connection, schemaFilter, entities, [plain.kind]);
    }

    return {
        steps: [plain],
        checks: await compareChecks(connection.db, connection.inRolledBackTransaction, entities, await typesThisPushChanges(connection.db, entities)),
        replacements: [],
    };
}

/** One pushSchema step, or the kind drizzle-kit reported removed and added instead. */
function stepOrAmbiguity(imports: Record<string, unknown>, db: Db, schemaFilter: string[]): Promise<StepPlan | Ambiguity>
{
    return planStep(imports, db, schemaFilter).catch((error: unknown) =>
    {
        const kind = ambiguousKindOf(error);

        return kind ? { kind, error } : Promise.reject(error);
    });
}

/**
 * The drops, then the creates, for `kinds` — the kinds drizzle-kit reported
 * removed and added, the last one last. When a step drizzle-kit plans still
 * holds another kind it asks about, the plan starts over with that kind
 * added: each round adds a kind not yet in `kinds`, so there are at most as
 * many rounds as kinds. A kind push does not split (a primary key) stops
 * push, naming it, and so does an object that must be created before the
 * drops while a removed object still holds its name (heldNames). A kind drizzle-kit reports again — push's read of the
 * database and drizzle-kit's diff disagree on it — rejects with drizzle-kit's
 * error, as before push planned two steps.
 */
async function planInTwoSteps(
    imports: Record<string, unknown>,
    connection: PlanConnection,
    schemaFilter: string[],
    entities: DeclaredEntity[],
    kinds: string[],
): Promise<ProjectPlan>
{
    const kind = kinds.at(-1)!;
    const entityTypes = new Set(kinds.map(each => RESOLVER_KINDS.get(each) ?? each));
    const changes = await readSchemaChanges(imports, connection.db, schemaFilter, entityTypes);

    if (UNSPLITTABLE_KINDS.has(RESOLVER_KINDS.get(kind) ?? kind))
    {
        const replacements = changes.replacements.filter(replacement => replacement.kind === kindWord(kind));

        return { steps: [], checks: NO_CHECKS, replacements: [], stop: { kind: kindWord(kind), reason: 'push cannot drop and create these in one push', replacements } };
    }

    if (changes.heldNames.length > 0)
    {
        return { steps: [], checks: NO_CHECKS, replacements: changes.replacements, heldNames: changes.heldNames };
    }

    const planned = await planDropsThenCreates(imports, connection, schemaFilter, entities, changes);

    if ('refused' in planned)
    {
        return { steps: [], checks: NO_CHECKS, replacements: changes.replacements, refused: planned.refused };
    }
    if (!('kind' in planned))
    {
        return { ...planned, replacements: changes.replacements };
    }

    return kinds.includes(planned.kind)
        ? Promise.reject(planned.error)
        : planInTwoSteps(imports, connection, schemaFilter, entities, [...kinds, planned.kind]);
}

/**
 * The drops, then the creates, planned by `pushSchema` on `connection` in one
 * transaction that always rolls back, so nothing done here stays:
 *
 * 1. Under a savepoint the added objects are created (`createAdded`), so the
 *    diff pushSchema plans next has nothing added and nothing to ask: its
 *    statements are the drops, with any change to an object both sides hold.
 * 2. Back at the savepoint — the database as it is — the drops run, and
 *    pushSchema plans what is left from there: the creates, nothing removed.
 * 3. The creates run, and the declared checks (`entities`) are compared
 *    (compareChecks) with the ones the database holds after both steps —
 *    where the replacements, appended after the steps' statements, will run.
 *    A check the steps drop with its column and create as declared is not
 *    replaced again; one on a table they leave is, as on the plain path.
 *    The types this push creates or changes are read before the transaction,
 *    on the database as it is, as the plain path reads them: after the
 *    steps, an enum they added a value to reads as declared, yet PostgreSQL
 *    refuses that value until the transaction commits.
 *
 * Each step is drizzle-kit's push diff against the database it will run on.
 * A statement PostgreSQL refuses here ends the plan, returned as a Refusal:
 * the steps cannot run in this order (a column moved onto the new enum before
 * the old one goes), or the push could not apply at all (a NOT NULL column
 * without a default added to a table with rows). A step in which drizzle-kit
 * still reports a kind removed and added is returned as that Ambiguity. Any
 * other error — drizzle-kit's, the connection's — rejects as it was given.
 *
 * The statements take their locks — `ACCESS EXCLUSIVE` for an `ALTER TABLE`
 * or `DROP TABLE` on an existing table — and hold them until the rollback,
 * on a dry run too. No `lock_timeout` is set, as none is for applying: the
 * plan waits for a lock as long as the server's setting lets it.
 */
async function planDropsThenCreates(
    imports: Record<string, unknown>,
    connection: PlanConnection,
    schemaFilter: string[],
    entities: DeclaredEntity[],
    changes: SchemaChanges,
): Promise<Pick<ProjectPlan, 'steps' | 'checks'> | Ambiguity | Refusal>
{
    const createAdded = await changes.createAdded();
    const changedTypes = await typesThisPushChanges(connection.db, entities);

    return connection.inRolledBackTransaction(async db =>
    {
        await db.execute(sql.raw('SAVEPOINT spfn_push_added'));
        const drops = await runStatements(db, createAdded) ?? await stepOrAmbiguity(imports, db, schemaFilter);

        if ('kind' in drops || 'refused' in drops)
        {
            return drops;
        }

        await db.execute(sql.raw('ROLLBACK TO SAVEPOINT spfn_push_added'));
        const creates = await runStatements(db, drops.statements) ?? await stepOrAmbiguity(imports, db, schemaFilter);

        if ('kind' in creates || 'refused' in creates)
        {
            return creates;
        }

        return await runStatements(db, creates.statements)
            ?? { steps: [drops, creates], checks: await compareChecks(db, inSavepoint(db), entities, changedTypes) };
    });
}

/**
 * A transaction that always rolls back, nested in the one `db` runs in: a
 * savepoint, rolled back to however `work` ends — as compareChecks needs one
 * per check, inside the steps' transaction.
 */
function inSavepoint(db: Db): PlanConnection['inRolledBackTransaction']
{
    return async work =>
    {
        await db.execute(sql.raw('SAVEPOINT spfn_push_compared'));
        try
        {
            return await work(db);
        }
        finally
        {
            await db.execute(sql.raw('ROLLBACK TO SAVEPOINT spfn_push_compared'));
        }
    };
}

/** PostgreSQL refused a statement of the two steps, with the error the driver gave. */
interface Refusal
{
    refused: unknown;
}

/** Run `statements` in order, up to the first PostgreSQL refuses; any other error rejects as it was given. */
async function runStatements(db: Db, statements: string[]): Promise<Refusal | undefined>
{
    for (const statement of statements)
    {
        const refusal = await db.execute(sql.raw(statement)).then(
            () => undefined,
            (error: unknown) => isRefusal(error) ? { refused: error } : Promise.reject(error),
        );

        if (refusal)
        {
            return refusal;
        }
    }

    return undefined;
}

/**
 * Whether `error` is PostgreSQL's error response to a statement — a SQLSTATE
 * and a severity, as pg and PGlite give it — on the error itself or on the
 * cause drizzle wraps it in.
 */
function isRefusal(error: unknown): boolean
{
    const fields = error as { code?: unknown; severity?: unknown; cause?: unknown } | null | undefined;

    return (typeof fields?.code === 'string' && typeof fields.severity === 'string')
        || (fields?.cause !== undefined && isRefusal(fields.cause));
}
