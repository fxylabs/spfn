interface RouteSegment
{
    kind: 'static' | 'parameter' | 'wildcard';
    value: string;
    optional: boolean;
}

function routeSegments(path: string): RouteSegment[]
{
    return path.split('/').slice(1).map((raw): RouteSegment =>
    {
        if (raw === '*' || raw.endsWith('*'))
        {
            return { kind: 'wildcard', value: raw, optional: true };
        }
        if (raw.startsWith(':'))
        {
            return {
                kind: 'parameter',
                value: raw.slice(1).replace(/\?$/, ''),
                optional: raw.endsWith('?'),
            };
        }

        return { kind: 'static', value: raw, optional: false };
    });
}

function customPattern(parameter: string): string | null
{
    const openingBrace = parameter.indexOf('{');

    return openingBrace >= 0 && parameter.endsWith('}')
        ? parameter.slice(openingBrace + 1, -1)
        : null;
}

function parameterAccepts(parameter: string, value: string): boolean
{
    const pattern = customPattern(parameter);
    if (pattern === null)
    {
        return value.length > 0 && !value.includes('/');
    }

    try
    {
        return new RegExp(`^(?:${pattern})$`).test(value);
    }
    catch
    {
        // Hono will reject an invalid pattern when registering it. Treat it as
        // overlapping here so it cannot bypass the scope check first.
        return true;
    }
}

function remainingStaticPath(segments: RouteSegment[], from: number): string | null
{
    const remaining = segments.slice(from);

    return remaining.every(segment => segment.kind === 'static')
        ? remaining.map(segment => segment.value).join('/')
        : null;
}

/**
 * Whether two Hono route patterns can claim at least one common URL.
 *
 * Custom-regex intersection is deliberately conservative. If disjointness
 * cannot be established from static material, composition is refused: scope
 * middleware must never depend on registration order.
 */
export function routePatternsOverlap(firstPath: string, secondPath: string): boolean
{
    const first = routeSegments(firstPath);
    const second = routeSegments(secondPath);
    const length = Math.max(first.length, second.length);

    for (let index = 0; index < length; index++)
    {
        const left = first[index];
        const right = second[index];

        if (!left || !right)
        {
            const remaining = left ? first.slice(index) : second.slice(index);

            return remaining.every(segment => segment.optional || segment.kind === 'wildcard');
        }
        if (left.kind === 'wildcard' || right.kind === 'wildcard')
        {
            return true;
        }
        if (left.kind === 'static' && right.kind === 'static')
        {
            if (left.value !== right.value)
            {
                return false;
            }
            continue;
        }
        if (left.kind === 'parameter' && right.kind === 'static')
        {
            const remaining = remainingStaticPath(second, index);
            if (customPattern(left.value) !== null && remaining !== null
                && parameterAccepts(left.value, remaining))
            {
                return true;
            }
            if (!parameterAccepts(left.value, right.value))
            {
                return customPattern(left.value) !== null && remaining === null;
            }
            if (customPattern(left.value) !== null && first.length !== second.length)
            {
                return true;
            }
            continue;
        }
        if (left.kind === 'static' && right.kind === 'parameter')
        {
            const remaining = remainingStaticPath(first, index);
            if (customPattern(right.value) !== null && remaining !== null
                && parameterAccepts(right.value, remaining))
            {
                return true;
            }
            if (!parameterAccepts(right.value, left.value))
            {
                return customPattern(right.value) !== null && remaining === null;
            }
            if (customPattern(right.value) !== null && first.length !== second.length)
            {
                return true;
            }
            continue;
        }

        // Two parameters both admit some non-empty segment. Custom regexes
        // may also consume separators, which only strengthens the overlap.
        return true;
    }

    return true;
}
