/** A read of the request path the scan found: where, and the expression as the lists name it */
export interface Found
{
    file: string;
    line: number;
    text: string;
}

export function productionSources(directory: string): string[];

export function scanFile(root: string, file: string, text?: string): { logged: Found[]; reads: Found[] };

export function againstList(root: string, found: Found[], list: ReadonlyMap<string, number>): { unlisted: string[]; inexact: string[] };
