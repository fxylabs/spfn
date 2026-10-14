/**
 * `spfn ops call <name> --describe` — the surface client's usage text, with
 * the line that invokes the command from this CLI.
 */

import { renderCommandUsage as renderSurfaceUsage } from '../../surface/describe.js';
import type { OpsCommandDescriptor } from './client.js';

export { plain } from '../../surface/plain.js';

export function renderCommandUsage(command: OpsCommandDescriptor): string
{
    return renderSurfaceUsage(command, 'spfn ops call');
}
