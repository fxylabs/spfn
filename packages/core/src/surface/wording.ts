/**
 * How refusals name the surface they come from.
 *
 * A command surface is generic, but the ops surface predates it and its
 * refusals already say "ops route" and point at `opsRoute`. The ops layer
 * passes its own wording so an operator reading an ops refusal sees the same
 * text as before; every other surface reads the neutral one.
 */
export interface SurfaceWording
{
    /** What a route on this surface is called: "ops route", "surface route". */
    noun: string;

    /** The builder that applies the namespace, as named in a refusal. */
    builder: string;

    /** The function that builds the surface, as named in a refusal. */
    factory: string;
}

export const SURFACE_WORDING: SurfaceWording = {
    noun: 'surface',
    builder: '`<surface>.route`',
    factory: 'defineSurface',
};

/** The noun at the start of a sentence. */
export function capitalized(noun: string): string
{
    return noun.charAt(0).toUpperCase() + noun.slice(1);
}
