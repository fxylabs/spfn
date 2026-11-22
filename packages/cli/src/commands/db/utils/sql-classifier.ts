/**
 * SQL Statement Classifier
 *
 * Classifies SQL statements into safe / destructive / warning categories
 * for safe-push mode in `spfn db push`.
 */

// ============================================================================
// Types
// ============================================================================

export type StatementCategory = 'safe' | 'destructive' | 'warning';

export interface ClassifiedStatement
{
    sql: string;
    category: StatementCategory;
    reason: string;
}

export interface ClassificationResult
{
    safe: ClassifiedStatement[];
    destructive: ClassifiedStatement[];
    warning: ClassifiedStatement[];
}

// ============================================================================
// Check replacement (checked before the destructive patterns: its DROP
// CONSTRAINT deletes no data, and the ADD in the same statement re-creates it)
// ============================================================================

const REPLACE_CHECK = {
    pattern: /^\s*ALTER\s+TABLE\s+.+?\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+("(?:[^"]|"")+")\s*,\s*ADD\s+CONSTRAINT\s+\1\s+CHECK\b/is,
    reason: 'Replaces a check (fails if a row violates the new expression)',
};

// ============================================================================
// Destructive patterns (checked first — highest priority)
// ============================================================================

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> =
    [
        { pattern: /^\s*DROP\s+TABLE/i, reason: 'Drops entire table' },
        { pattern: /^\s*DROP\s+INDEX/i, reason: 'Drops index' },
        { pattern: /^\s*DROP\s+SCHEMA/i, reason: 'Drops schema' },
        { pattern: /^\s*DROP\s+TYPE/i, reason: 'Drops custom type' },
        { pattern: /ALTER\s+TABLE\s+.*\bDROP\s+COLUMN\b/i, reason: 'Drops column' },
        { pattern: /ALTER\s+TABLE\s+.*\bDROP\s+CONSTRAINT\b/i, reason: 'Drops constraint' },
        { pattern: /ALTER\s+TABLE\s+.*ALTER\s+COLUMN\s+.*\bTYPE\b/i, reason: 'Changes column type (potential data loss)' },
        { pattern: /ALTER\s+TYPE\s+.*\bRENAME\s+VALUE\b/i, reason: 'Renames enum value' },
        { pattern: /^\s*TRUNCATE\b/i, reason: 'Truncates table data' },
        { pattern: /^\s*DELETE\s+FROM\b/i, reason: 'Deletes table data' },
    ];

// ============================================================================
// Warning patterns (auto-applied but shown with caution)
// ============================================================================

const WARNING_PATTERNS: Array<{ pattern: RegExp; reason: string }> =
    [
        { pattern: /ALTER\s+TABLE\s+.*ALTER\s+COLUMN\s+.*\bSET\s+NOT\s+NULL\b/i, reason: 'Adds NOT NULL (fails if NULLs exist)' },
        { pattern: /ALTER\s+TABLE\s+.*\bRENAME\s+COLUMN\b/i, reason: 'Renames column' },
    ];

// ============================================================================
// Public API
// ============================================================================

/**
 * Classify a single SQL statement
 */
export function classifyStatement(sql: string): ClassifiedStatement
{
    if (REPLACE_CHECK.pattern.test(sql))
    {
        return { sql, category: 'warning', reason: REPLACE_CHECK.reason };
    }

    // Then destructive (highest priority of the patterns)
    for (const { pattern, reason } of DESTRUCTIVE_PATTERNS)
    {
        if (pattern.test(sql))
        {
            return { sql, category: 'destructive', reason };
        }
    }

    // Then check warnings
    for (const { pattern, reason } of WARNING_PATTERNS)
    {
        if (pattern.test(sql))
        {
            return { sql, category: 'warning', reason };
        }
    }

    // Everything else is safe
    return { sql, category: 'safe', reason: '' };
}

/**
 * Classify an array of SQL statements into grouped result
 */
export function classifyStatements(statements: string[]): ClassificationResult
{
    const result: ClassificationResult = { safe: [], destructive: [], warning: [] };

    for (const sql of statements)
    {
        const classified = classifyStatement(sql);
        result[classified.category].push(classified);
    }

    return result;
}
