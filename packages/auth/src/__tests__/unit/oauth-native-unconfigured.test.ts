/**
 * A provider that is compiled in but not configured.
 *
 * Every built-in provider reads its accepted audiences from an env var. With
 * that var unset the provider cannot verify a native id_token at all — a fact
 * about this server, not about the request the app sent. The app's answer to
 * the two is different: a configuration refusal means hide the native button,
 * a malformed request means fix the request. So the two cannot share a code.
 *
 * The route's own "this provider has no native implementation" guard does not
 * cover this: these providers do implement it, they just have nothing to
 * accept.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { appleProvider } from '@/server/lib/oauth/apple-provider';
import { googleProvider } from '@/server/lib/oauth/google-provider';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { naverProvider } from '@/server/lib/oauth/naver-provider';

const UNCONFIGURED = [
    { name: 'apple', provider: appleProvider, envVar: 'SPFN_AUTH_APPLE_CLIENT_IDS' },
    { name: 'google', provider: googleProvider, envVar: 'SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS' },
    { name: 'kakao', provider: kakaoProvider, envVar: 'SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS' },
    { name: 'naver', provider: naverProvider, envVar: 'SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS' },
];

describe('an unconfigured native provider refuses as a configuration fact', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    for (const { name, provider, envVar } of UNCONFIGURED)
    {
        it(`${name}: NativeSignInUnsupportedError, not ValidationError`, async () =>
        {
            vi.stubEnv(envVar, '');
            // Google falls back to its web client id, so that has to be empty too.
            vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', '');
            vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', '');
            vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', '');
            // Apple accepts its web Services ID as a native audience too (#142).
            vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', '');

            const verify = provider.verifyNativeIdToken;
            expect(verify, `${name} should implement native sign-in`).toBeDefined();

            const error = await verify!('any.id.token', { nonce: 'nonce' }).catch((e: unknown) => e);

            expect((error as Error).name).toBe('NativeSignInUnsupportedError');
            expect((error as { statusCode: number }).statusCode).toBe(400);
            expect((error as { toJSON(): { __type: string } }).toJSON().__type)
                .toBe('NativeSignInUnsupportedError');
        });
    }
});
