/**
 * `createSigner()` — one configuration in, the `Signer` its provider builds out.
 *
 * Its own module so that the purpose registry can build signers without
 * importing the package's entry point, which re-exports the registry.
 */

import { LocalSigner, type LocalSignerOptions } from './providers/local';
import type { AwsKmsSignerOptions } from './providers/aws-kms';
import type { GcpKmsSignerOptions } from './providers/gcp-kms';
import type { Signer } from './types';

/** What `createSigner()` takes, one member per provider. */
export type SignerConfig =
    | ({ provider: 'local' } & LocalSignerOptions)
    | ({ provider: 'gcp-kms' } & GcpKmsSignerOptions)
    | ({ provider: 'aws-kms' } & AwsKmsSignerOptions);

/**
 * Build the signer a configuration names.
 *
 * Asynchronous for every provider: a KMS signer has to read its key's
 * algorithm and public half before it can claim to be one.
 */
export async function createSigner(config: SignerConfig): Promise<Signer>
{
    if (config.provider === 'local')
    {
        return new LocalSigner(config);
    }

    if (config.provider === 'gcp-kms')
    {
        const { createGcpKmsSigner } = await import('./providers/gcp-kms');

        return createGcpKmsSigner(config);
    }

    const { createAwsKmsSigner } = await import('./providers/aws-kms');

    return createAwsKmsSigner(config);
}
