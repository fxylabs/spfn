/**
 * What an app's page catches for a backend answer: the error `createAuthApi`
 * throws when its fetch is handed that answer. The client restores the class
 * through the registry it builds — core's errors, then `authErrorRegistry` —
 * exactly as `authApi` does, so a row reading the result reads what the app's
 * screen reads.
 *
 * The client is the package's own entry, `@spfn/auth`, as the app imports it:
 * the services throw `@spfn/auth/errors`' classes, and a row compares what the
 * client restores against those same classes.
 */

import { createAuthApi } from '@spfn/auth';

/**
 * The error the auth client throws for `response`, or null when the call
 * resolves. The response is read by the client, so pass a clone of one the row
 * still reads itself.
 */
export async function restoredByAuthApi(response: Response): Promise<unknown>
{
    return await createAuthApi({ fetch: async () => response })
        .getAuthSession.call({})
        .then(() => null, (thrown: unknown) => thrown);
}
