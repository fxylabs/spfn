/**
 * native 로그인의 실패 경로마다 서로 다른 code가 나온다 (issue #58)
 *
 * 모바일 SDK는 HTTP status가 아니라 봉투의 code로만 실패를 분류한다. 그래서 이 라우트의
 * 실패 경로가 전부 같은 모양으로 나가면 앱은 "알 수 없는 실패" 하나만 보게 되고, 다시
 * 시도해도 되는지(429뿐)조차 판단할 수 없다.
 *
 * 아래 표가 이 라우트의 유한한 실패 목록이고, 테스트는 표의 칸과 1:1로 대응한다. 표에 있는
 * code가 계약에도 같은 status로 실려 있는지까지 여기서 잠근다 — 서버와 계약이 갈리면 앱은
 * 서버가 실제로 내는 코드를 모르는 채로 생성된다.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';

const {
    createOrLinkUser,
    assertActiveForOAuthSession,
    socialAccountsRepository,
    registerPublicKeyService,
} = vi.hoisted(() => ({
    createOrLinkUser: vi.fn(async () => ({ userId: 1, isNewUser: true })),
    assertActiveForOAuthSession: vi.fn(async () => undefined),
    socialAccountsRepository: {
        findByProviderAndProviderId: vi.fn(async () => null),
    },
    registerPublicKeyService: vi.fn(async () => undefined),
}));

vi.mock('@spfn/core/db', () => ({
    runInTransaction: (fn: () => unknown) => fn(),
    onAfterCommit: (fn: () => void) => fn(),
}));

vi.mock('../../server/repositories', () => ({ socialAccountsRepository }));

vi.mock('../../server/services/oauth.service', () => ({
    createOrLinkUser,
    assertActiveForOAuthSession,
    backfillVerifiedEmail: vi.fn(async () => undefined),
}));

vi.mock('../../server/services/key.service', () => ({ registerPublicKeyService }));
// The login event carries `mfaEnrolled` (#95); this route's failure taxonomy is
// what is under test, so the lookup behind it is stubbed like every other
// service the route reaches.
vi.mock('../../server/services/mfa.service', () => ({ mfaEnrolledForUser: vi.fn(async () => false) }));
vi.mock('../../server/services/user.service', () => ({ updateLastLoginService: vi.fn(async () => undefined) }));

vi.mock('../../server/events', () => ({
    authLoginEvent: { emit: vi.fn() },
    authRegisterEvent: { emit: vi.fn() },
}));

const verifyNativeIdToken = vi.fn(async () => ({
    providerUserId: 'provider-user-1',
    email: 'user@example.com',
    emailVerified: true,
}));

const provider: { id: string; verifyNativeIdToken?: typeof verifyNativeIdToken } = {
    id: 'kakao',
    verifyNativeIdToken,
};

vi.mock('../../server/lib/oauth', () => ({
    getOAuthProvider: () => provider,
}));

import { oauthNativeService } from '../../server/services/oauth-native.service';
import { buildMobileContractBundle } from '../../server/client-proof/contract-bundle';
// 서비스가 던지는 것과 같은 모듈에서 가져온다 — 상대경로로 받으면 별칭 해석이 갈려 다른
// 클래스 객체가 로드되고 instanceof가 어긋난다.
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    InvalidKeyFingerprintError,
    InvalidSocialTokenError,
    KeyIdAlreadyRegisteredError,
    NativeSignInUnsupportedError,
    NonceKeyBindingError,
    UnverifiedEmailLinkError,
} from '@spfn/auth/errors';

/** 클라이언트가 만드는 것과 같은 모양의 키 한 벌 — Base64 DER(SPKI)과 그 SHA-256 hex. */
function generateClientKey(): { publicKey: string; fingerprint: string }
{
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ type: 'spki', format: 'der' });

    return {
        publicKey: der.toString('base64'),
        fingerprint: createHash('sha256').update(der).digest('hex'),
    };
}

function paramsFor(key: { publicKey: string; fingerprint: string }, nonce?: string)
{
    return {
        provider: 'kakao' as const,
        idToken: 'id.token.value',
        nonce: nonce ?? key.fingerprint,
        publicKey: key.publicKey,
        keyId: 'key-id-1',
        fingerprint: key.fingerprint,
        algorithm: 'ES256' as const,
    };
}

/** 던져진 에러가 응답으로 나갈 때의 모양 — 핸들러가 code를 이 필드에서 읽는다. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; status: number }>
{
    try
    {
        await run();
    }
    catch (error)
    {
        const err = error as { statusCode: number; toJSON(): { __type: string } };

        return { code: err.toJSON().__type, status: err.statusCode };
    }

    throw new Error('expected a refusal, got a success');
}

describe('native sign-in answers each failure path with its own code', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        provider.verifyNativeIdToken = verifyNativeIdToken;
    });

    it('cell 2 — provider without native sign-in: NativeSignInUnsupportedError 400', async () =>
    {
        delete provider.verifyNativeIdToken;
        const key = generateClientKey();

        await expect(oauthNativeService(paramsFor(key))).rejects.toThrow(NativeSignInUnsupportedError);
        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'NativeSignInUnsupportedError', status: 400 });
    });

    it('cell 3 — nonce is not the key fingerprint: NonceKeyBindingError 400', async () =>
    {
        const key = generateClientKey();

        await expect(oauthNativeService(paramsFor(key, 'f'.repeat(64)))).rejects.toThrow(NonceKeyBindingError);
        expect(await refusalOf(() => oauthNativeService(paramsFor(key, 'f'.repeat(64)))))
            .toEqual({ code: 'NonceKeyBindingError', status: 400 });
    });

    it('cell 4 — fingerprint is not the hash of the key: InvalidKeyFingerprintError 400', async () =>
    {
        const victim = generateClientKey();
        const attacker = generateClientKey();
        const params = { ...paramsFor(victim), publicKey: attacker.publicKey };

        await expect(oauthNativeService(params)).rejects.toThrow(InvalidKeyFingerprintError);
        expect(await refusalOf(() => oauthNativeService(params)))
            .toEqual({ code: 'InvalidKeyFingerprintError', status: 400 });
    });

    it('cell 5 — id_token fails verification: InvalidSocialTokenError 401', async () =>
    {
        verifyNativeIdToken.mockRejectedValueOnce(new InvalidSocialTokenError());
        const key = generateClientKey();

        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'InvalidSocialTokenError', status: 401 });
    });

    it('cell 6 — linking an account on an unverified email: UnverifiedEmailLinkError 400', async () =>
    {
        createOrLinkUser.mockRejectedValueOnce(new UnverifiedEmailLinkError());
        const key = generateClientKey();

        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'UnverifiedEmailLinkError', status: 400 });
    });

    it('cell 7 — account not active: AccountDisabledError 403', async () =>
    {
        assertActiveForOAuthSession.mockRejectedValueOnce(new AccountDisabledError({ status: 'suspended' }));
        const key = generateClientKey();

        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'AccountDisabledError', status: 403 });
    });

    it('cell 8 — account pending deletion: AccountPendingDeletionError 403', async () =>
    {
        assertActiveForOAuthSession.mockRejectedValueOnce(new AccountPendingDeletionError({}));
        const key = generateClientKey();

        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'AccountPendingDeletionError', status: 403 });
    });

    it('cell 9 — keyId taken or revoked: KeyIdAlreadyRegisteredError 409', async () =>
    {
        registerPublicKeyService.mockRejectedValueOnce(new KeyIdAlreadyRegisteredError());
        const key = generateClientKey();

        expect(await refusalOf(() => oauthNativeService(paramsFor(key))))
            .toEqual({ code: 'KeyIdAlreadyRegisteredError', status: 409 });
    });

    it('every cell of the table is a contract code with the same status', () =>
    {
        // 1·10·11·12는 서비스가 아니라 프레임워크가 만든다: 입력 스키마 검증, rate limit,
        // 서버가 설명하지 않는 실패, 그리고 앱이 끼운 beforeRegister 검사의 가입 거부.
        // 계약에는 그 넷도 있어야 앱이 분류할 수 있다.
        const table = [
            { code: 'ValidationError', status: 400, retryable: false },
            { code: 'NativeSignInUnsupportedError', status: 400, retryable: false },
            { code: 'NonceKeyBindingError', status: 400, retryable: false },
            { code: 'InvalidKeyFingerprintError', status: 400, retryable: false },
            // Added to the REST vocabulary in contract 0.10.1; held to its error
            // class in contract-export.test.ts.
            { code: 'KeyAlgorithmMismatchError', status: 400, retryable: false },
            { code: 'InvalidSocialTokenError', status: 401, retryable: false },
            { code: 'UnverifiedEmailLinkError', status: 400, retryable: false },
            { code: 'AccountDisabledError', status: 403, retryable: false },
            { code: 'AccountPendingDeletionError', status: 403, retryable: false },
            { code: 'RegistrationRejectedError', status: 403, retryable: false },
            { code: 'KeyIdAlreadyRegisteredError', status: 409, retryable: false },
            { code: 'TooManyRequestsError', status: 429, retryable: true },
            { code: 'Error', status: 500, retryable: false },
        ];

        const declared = buildMobileContractBundle().errors as {
            code: string;
            httpStatus: number;
            retryable: boolean;
            surface: string;
        }[];

        for (const cell of table)
        {
            const entry = declared.find(e => e.code === cell.code && e.surface === 'rest');

            expect(entry, `contract is missing rest error ${cell.code}`).toBeDefined();
            expect(entry!.httpStatus, `status for ${cell.code}`).toBe(cell.status);
            expect(entry!.retryable, `retryable for ${cell.code}`).toBe(cell.retryable);
        }

        // The fence stays exact rather than becoming "at least these": the rest
        // surface is enumerated one operation at a time, so a code here that this
        // table does not name must belong to another enumerated family. Device-code
        // login is the second one (contract 0.10.0), and its four codes are held to
        // their error classes in contract-export.test.ts.
        const deviceCodes = [
            'DeviceAuthExpiredError',
            'DeviceAuthDeniedError',
            'DeviceAuthNotFoundError',
            'DeviceAuthAlreadyHandledError',
        ];

        // Second-factor step-up is the third enumerated family (contract 0.13.0,
        // #95). It adds exactly one code: every way `auth.mfa.verify` can refuse
        // a proof is one 401 with one body, deliberately, so that a guess cannot
        // be told from a stale code. Its other two refusals — a body naming two
        // proofs or none, and the rate limit — are `ValidationError` and
        // `TooManyRequestsError`, both already in the table above.
        const mfaCodes = ['MfaVerificationFailedError'];

        expect(declared.filter(e => e.surface === 'rest').map(e => e.code).sort())
            .toEqual([...table.map(cell => cell.code), ...deviceCodes, ...mfaCodes].sort());
    });

    it('only the rate limit invites a retry of the same request', () =>
    {
        const declared = buildMobileContractBundle().errors as { code: string; retryable: boolean }[];

        expect(declared.filter(e => e.retryable).map(e => e.code)).toEqual(['TooManyRequestsError']);
    });
});
