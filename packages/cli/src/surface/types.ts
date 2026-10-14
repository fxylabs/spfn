/**
 * What a surface manifest describes and a call sends, as the client sees it.
 */

export type SurfaceEffect = 'read' | 'write' | 'destructive';

export interface SurfaceModuleDescriptor
{
    id: string;
    source: string;
    contractVersion: string;
    summary: string;
}

export interface SurfaceCommandDescriptor
{
    name: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    module?: string;
    summary?: string;
    effect?: SurfaceEffect;
    scopes?: string[];

    /**
     * Set when the app announced module metadata that failed validation, so
     * this command's effect is unknown rather than absent. Callers must treat
     * it as needing confirmation.
     */
    metadataRejected?: boolean;
    input: {
        params?: Record<string, unknown>;
        query?: Record<string, unknown>;
        body?: Record<string, unknown>;
    };
}

export interface SurfaceManifest
{
    manifestVersion: 1;
    modules?: SurfaceModuleDescriptor[];
    commands: SurfaceCommandDescriptor[];
}

export interface SurfaceCallInput
{
    params: Record<string, string>;
    query: Record<string, string>;
    body: unknown | undefined;
}

export interface SurfaceResponse
{
    status: number;
    body: unknown;
}
