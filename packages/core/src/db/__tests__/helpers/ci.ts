/**
 * Whether the tests run in CI, where a missing test service is a broken setup
 * rather than a machine without it.
 *
 * `CI` set to anything but nothing, `false` or `0` — the reading most CI tools
 * and libraries share. A truthiness test took `CI=false`, which a developer
 * sets to tell such tools "not CI", for CI, and turned a skip into a failure.
 */
export function runsInCi(env: NodeJS.ProcessEnv = process.env): boolean
{
    const value = env.CI?.trim().toLowerCase();

    return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}
