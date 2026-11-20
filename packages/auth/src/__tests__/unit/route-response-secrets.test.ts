/**
 * @spfn/auth - No auth route answers a secret-named key (T6, w-etq2g)
 *
 * The invitation list once answered every pending invitation's token, and
 * `PATCH /_auth/users/username` the account's `passwordHash`, because both
 * returned what the query selected and no route declares its response shape.
 * This test walks every route of `mainAuthRouter` and fails when the response
 * type of any of them carries a key named like a secret.
 *
 * Why the handlers' inferred response types and not calls: a route that returns
 * a raw row has the row's type, and a drizzle row type names every column —
 * `passwordHash`, `tokenHash`, `codeHash` — whether or not a test managed to
 * reach the line that returns it. Calling 107 routes as an authorised user
 * would reach the success path of only the few whose inputs and state a
 * generic walk can build; the rest would answer 400/404 and prove nothing.
 * Declared response schemas cover only the mobile-contract routes. The type
 * covers all of them, so it is what this reads, through the TypeScript
 * compiler, the way `tsc` sees it.
 *
 * What a type cannot show is closed the other way: a response typed `any` or
 * `unknown`, an index signature (`Record<string, …>`), or a raw `Response`
 * built with `c.json`, hides its keys, so each of
 * those also fails unless it is listed below with its reason. An index
 * signature's values are still walked, at `.[string]` / `.[number]`, so its
 * entry exempts only the hidden keys: anything beneath needs its own entry.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROUTES_ENTRY = path.join(PACKAGE_ROOT, 'src/server/routes/index.ts');

/**
 * A key named like something that admits its holder: any `token` (`opsToken`,
 * `accessToken`, `verificationToken`), `secret` or `hash`; a `password`; an
 * `otpauth` value; a code (`code`, `deviceCode`, `userCode`, `recoveryCodes`);
 * and a URL or link, which can carry any of those (`invitationUrl`, `otpauthUri`).
 * Wider than what leaks today on purpose: a harmless match costs one listed
 * reason, a missed one costs a credential.
 */
const SECRET_KEY = /token|secret|hash|password$|otpauth|codes?$|ur[li]$|link$/i;

/** How many types deep a response may nest; the deepest route today is well under it. */
const MAX_DEPTH = 32;

/** Types whose own members are not response keys. */
const OPAQUE_TYPES = new Set(['Date', 'Uint8Array', 'Buffer']);

/**
 * Secret-named keys a route answers on purpose, by `route:path`.
 */
const ALLOWED_SECRET_KEYS: Record<string, string> = {
    'createInvitation:.token': 'the invitation link token, answered once at creation; only its hash is stored',
    'resendInvitation:.token': 'the new invitation link token a resend mints, answered once; the old one stops working',
    'createInvitation:.invitationUrl': 'the invitation link, carrying the token answered beside it once at creation',
    'resendInvitation:.invitationUrl': 'the new invitation link, carrying the token answered beside it once at resend',
    'issueOneTimeToken:.token': 'the one-time token is what the route issues, to the signed-in caller',
    'issueOpsToken:.token': 'an ops token is shown once, at issue, to the caller who minted it',
    'issueOpsToken:.opsToken': 'the issued token\'s summary (id, name, scopes, dates); its own keys are walked',
    'listOpsTokens:.opsTokens': 'ops token summaries (id, name, scopes, dates); their keys are walked',
    'revokeOpsToken:.opsToken': 'the revoked token\'s summary (id, name, scopes, dates); its own keys are walked',
    'verifyCode:.verificationToken': 'the token the caller earns by presenting the emailed code, for the registration that follows',
    'startDeviceAuth:.deviceCode': 'RFC 8628: the device that started the flow polls with its device code',
    'startDeviceAuth:.userCode': 'RFC 8628: the device shows the user code for the person to enter elsewhere',
    'startDeviceAuthWeb:.deviceCode': 'RFC 8628: the device that started the flow polls with its device code',
    'startDeviceAuthWeb:.userCode': 'RFC 8628: the device shows the user code for the person to enter elsewhere',
    'issueDeviceLink:.userCode': 'the signed-in device shows the code the new device enters',
    'redeemDeviceLink:.deviceCode': 'the redeeming device polls with it; it proved the user code to get it',
    'redeemDeviceLinkWeb:.deviceCode': 'the redeeming device polls with it; it proved the user code to get it',
    'createOAuth2AuthorizationCode:.code': 'RFC 6749: the authorization code, to the signed-in user who just consented, for the client',
    'createOAuth2AuthorizationCode:.redirectUri': 'the client\'s registered redirect URI, carrying no credential of its own',
    'mfaTotpEnroll:.otpauthUri': 'the otpauth URI holds the TOTP secret, shown once at enrolment for the authenticator app',
    'mfaTotpConfirm:.recoveryCodes': 'recovery codes are shown once, when the second factor is confirmed',
    'mfaRegenerateRecoveryCodes:.recoveryCodes': 'regenerated recovery codes are shown once, to the account that asked',
    'getAuthSession:.hasPassword': 'a boolean: whether the account has a password',
    'getAuthChannels:.deviceCode': 'a boolean: whether the app offers device-code login',
    'getAuthChannels:.deviceLink': 'a boolean: whether the app offers device link',
    'oauthStart:.authUrl': 'the provider\'s authorize URL; its state is bound to the caller\'s cookie, not a credential',
    'getGoogleOAuthUrl:.authUrl': 'the provider\'s authorize URL; its state is bound to the caller\'s cookie, not a credential',
    'getProviderOAuthUrl:.authUrl': 'the provider\'s authorize URL; its state is bound to the caller\'s cookie, not a credential',
    'oauthAppleNativeStart:.authUrl': 'the provider\'s authorize URL; its state is bound to the caller\'s cookie, not a credential',
    'oauthLinkStart:.authUrl': 'the provider\'s authorize URL; its state is bound to the caller\'s cookie, not a credential',
    'oauthFinalize:.returnUrl': 'the app path to return to after sign-in',
    'getUserProfile:.profile.avatarUrl': 'a public image URL',
    'updateUserProfile:.avatarUrl': 'a public image URL',
    'updateUsername:.profile.avatarUrl': 'a public image URL',
    'mfaTotpEnroll:.secret': 'the TOTP secret is shown once at enrolment so the authenticator app can scan it',
    'confirmSignupLink:.setupSecret': 'moved into an HttpOnly cookie and stripped from the body by the Next.js interceptor',
    'confirmPasswordReset:.setupSecret': 'moved into an HttpOnly cookie and stripped from the body by the Next.js interceptor',
    'login:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'completePasswordReset:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'passkeyLoginVerify:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'oauthNative:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'sessionRenewVerify:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'mfaVerify:.challenge.secret': 'the new-device challenge secret, the only credential that completes this sign-in',
    'mfaVerify:.challengeHash': 'the hash of the challenge the caller just presented; the mfa-verify interceptor binds it to its pending session',
    'passkeyRegisterOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'passkeyLoginOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'mfaStepUpOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'mfaVerifyOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'sessionBindingDisableOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'passkeyProofOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
    'sessionRenewOptions:.extensions.hmacCreateSecret': 'a WebAuthn extension flag (boolean), not a secret',
};

/**
 * Responses whose keys the type does not show, by `route:path`.
 */
const ALLOWED_OPAQUE: Record<string, string> = {
    'oauthGoogleStart::Response': 'a redirect to the provider',
    'oauthGoogleCallback::Response': 'a redirect back to the app',
    'oauthProviderStart::Response': 'a redirect to the provider',
    'oauthProviderCallback::Response': 'a redirect back to the app',
    'oauthProviderCallbackPost::Response': 'a redirect back to the app (form_post)',
    'oauthUnlinkNotify::Response': 'the provider\'s unlink webhook acknowledgement, no account data',
    'oauthUnlinkNotifyGet::Response': 'the provider\'s unlink webhook acknowledgement, no account data',
    'androidAssetLinks::Response': 'the public assetlinks.json document',
    'registerOAuth2Client::Response': 'RFC 7591 client registration, a public client: no client secret is issued',
    'oauth2Token::Response': 'RFC 6749 token endpoint: the access token is what the route issues, to the client holding the grant',
    'oauth2Revoke::Response': 'RFC 7009 revocation: an empty 200',
    'oauth2AuthorizationServerMetadata::Response': 'RFC 8414 public metadata document',
    'getInvitation:.metadata:index-signature': 'the inviter-supplied metadata object, not a row',
    'getInvitation:.metadata.[string]:any': 'a value of the inviter-supplied metadata object, whatever JSON the inviter sent',
    'listInvitations:.invitations[].metadata:index-signature': 'the inviter-supplied metadata object, not a row',
    'listInvitations:.invitations[].metadata.[string]:any': 'a value of the inviter-supplied metadata object, whatever JSON the inviter sent',
    'getUserProfile:.profile.metadata:index-signature': 'the person\'s own profile metadata, checked against defineProfileFields',
    'getUserProfile:.profile.metadata.[string]:any': 'a value of the person\'s own profile metadata, checked against defineProfileFields',
    'updateUserProfile:.metadata:index-signature': 'the person\'s own profile metadata, checked against defineProfileFields',
    'updateUserProfile:.metadata.[string]:any': 'a value of the person\'s own profile metadata, checked against defineProfileFields',
    'updateUsername:.profile.metadata:index-signature': 'the person\'s own profile metadata, checked against defineProfileFields',
    'updateUsername:.profile.metadata.[string]:any': 'a value of the person\'s own profile metadata, checked against defineProfileFields',
    'passkeyRegisterOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'passkeyLoginOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'mfaStepUpOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'mfaVerifyOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'sessionBindingDisableOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'passkeyProofOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'sessionRenewOptions:.extensions.prf.evalByCredential:index-signature': 'WebAuthn PRF salts keyed by public credential id',
    'listSettings:.settings[].value:unknown': 'a declared setting\'s value, checked against the key\'s schema',
    'getSetting:.value:unknown': 'a declared setting\'s value, checked against the key\'s schema',
    'setSetting:.value:unknown': 'a declared setting\'s value, checked against the key\'s schema',
};

interface Finding
{
    secretKeys: string[];
    opaque: string[];
}

function createChecker(): { checker: ts.TypeChecker; routes: ts.Symbol[] }
{
    const config = ts.getParsedCommandLineOfConfigFile(
        path.join(PACKAGE_ROOT, 'tsconfig.json'),
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    const program = ts.createProgram([ROUTES_ENTRY], { ...config!.options, noEmit: true });
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(ROUTES_ENTRY)!)!;
    const router = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === 'mainAuthRouter')!;
    const routes = checker.getTypeOfSymbol(checker.getTypeOfSymbol(router).getProperty('routes')!);

    return { checker, routes: routes.getProperties() };
}

/**
 * Record every secret-named key and every key-hiding type reachable from a response type.
 *
 * `ancestors` holds the types on the path from the response down to here, so a
 * recursive type stops at its own repetition while a type reached by a second
 * path is still walked there — a secret under it is reported at each path.
 * A type that never repeats yet keeps nesting fails the walk past MAX_DEPTH.
 */
function walk(checker: ts.TypeChecker, type: ts.Type, at: string, ancestors: Set<ts.Type>, found: Finding): void
{
    const awaited = checker.getAwaitedType(type) ?? type;

    // A generic that instantiates a new type at every level never repeats, so
    // the ancestor check cannot end it; failing names where, stopping would hide it.
    if (ancestors.size >= MAX_DEPTH)
    {
        throw new Error(`T6 walker: response type nested deeper than ${MAX_DEPTH} levels at '${at}'`);
    }

    if (awaited.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    {
        found.opaque.push(`${at}:${checker.typeToString(awaited)}`);

        return;
    }

    if (ancestors.has(awaited))
    {
        return;
    }
    ancestors.add(awaited);
    walkMembers(checker, awaited, at, ancestors, found);
    ancestors.delete(awaited);
}

function walkMembers(checker: ts.TypeChecker, type: ts.Type, at: string, ancestors: Set<ts.Type>, found: Finding): void
{
    if (type.isUnion() || type.isIntersection())
    {
        type.types.forEach((member) => walk(checker, member, at, ancestors, found));

        return;
    }

    if (checker.isArrayType(type) || checker.isTupleType(type))
    {
        checker.getTypeArguments(type as ts.TypeReference)
            .forEach((element) => walk(checker, element, `${at}[]`, ancestors, found));

        return;
    }

    walkObject(checker, type, at, ancestors, found);
}

function walkObject(checker: ts.TypeChecker, type: ts.Type, at: string, ancestors: Set<ts.Type>, found: Finding): void
{
    const name = type.getSymbol()?.name;

    if (!(type.flags & ts.TypeFlags.Object) || (name && OPAQUE_TYPES.has(name)))
    {
        return;
    }

    if (name === 'Response')
    {
        found.opaque.push(`${at}:Response`);

        return;
    }

    // An index signature names no keys, so it is flagged; what it holds is
    // still walked, so a secret-named key in its values is reported too.
    for (const index of checker.getIndexInfosOfType(type))
    {
        found.opaque.push(`${at}:index-signature`);
        walk(checker, index.type, `${at}.[${checker.typeToString(index.keyType)}]`, ancestors, found);
    }

    for (const property of type.getProperties())
    {
        if (SECRET_KEY.test(property.name))
        {
            found.secretKeys.push(`${at}.${property.name}`);
        }
        walk(checker, checker.getTypeOfSymbol(property), `${at}.${property.name}`, ancestors, found);
    }
}

/**
 * What the walk finds in `Probe`, a type declared in a source of its own
 */
function walkProbe(source: string): Finding
{
    const file = path.join(PACKAGE_ROOT, '__probe__.ts');
    const host = ts.createCompilerHost({ strict: true });
    const readFile = host.readFile.bind(host);
    host.readFile = (name) => (name === file ? source : readFile(name));
    host.fileExists = (name) => name === file || ts.sys.fileExists(name);
    const program = ts.createProgram([file], { strict: true, noEmit: true }, host);
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    const probe = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === 'Probe')!;
    const found: Finding = { secretKeys: [], opaque: [] };

    walk(checker, checker.getDeclaredTypeOfSymbol(probe), '', new Set(), found);

    return found;
}

describe('auth route responses', () =>
{
    it('T6 walker: a type reached by two paths is walked at both', () =>
    {
        const found = walkProbe('interface Shared { token: string } export interface Probe { a: Shared; b: Shared }');

        expect(found.secretKeys).toEqual(['.a.token', '.b.token']);
    });

    it('T6 walker: a recursive type ends at its own repetition', () =>
    {
        const found = walkProbe('export interface Probe { child?: Probe; secret: string }');

        expect(found.secretKeys).toEqual(['.secret']);
    });

    it('T6 walker: an index signature hides its keys like any', () =>
    {
        const found = walkProbe('export interface Probe { a: Record<string, string>; b: { [id: number]: boolean } }');

        expect(found.opaque).toEqual(['.a:index-signature', '.b:index-signature']);
    });

    it('T6 walker: the values of a string or number index signature are walked', () =>
    {
        const found = walkProbe('export interface Probe { a: Record<string, { tokenHash: string }>; '
            + 'b: { [id: number]: { secret: string } }; c: Record<string, unknown> }');

        expect(found.secretKeys).toEqual(['.a.[string].tokenHash', '.b.[number].secret']);
        expect(found.opaque).toEqual(['.a:index-signature', '.b:index-signature', '.c:index-signature', '.c.[string]:unknown']);
    });

    it('T6 walker: a type that keeps nesting fails, naming the path, instead of overflowing', () =>
    {
        const probe = 'interface Grow<T> { next: Grow<T[]>; value: T } export type Probe = Grow<string>';

        expect(() => walkProbe(probe)).toThrow(/nested deeper than 32 levels at '(\.next){32}'/);
    });

    it('T6 walker: every credential-bearing name is secret-named', () =>
    {
        const names = ['token', 'tokenHash', 'secret', 'password', 'otpauthUri', 'invitationUrl', 'opsToken',
            'verificationToken', 'deviceCode', 'userCode', 'accessToken', 'refreshToken', 'recoveryCodes', 'magicLink'];
        const found = walkProbe(`export interface Probe { ${names.map((name) => `${name}: string;`).join(' ')} }`);

        expect(found.secretKeys).toEqual(names.map((name) => `.${name}`));
    });

    it('T6: no route answers a secret-named key, or hides its keys, unless listed with a reason', () =>
    {
        const { checker, routes } = createChecker();
        const unlisted: string[] = [];
        const matched = new Set<string>();

        expect(routes.length).toBeGreaterThan(100);

        for (const route of routes)
        {
            const response = checker.getTypeOfSymbol(route).getProperty('_response')!;
            const found: Finding = { secretKeys: [], opaque: [] };

            walk(checker, checker.getTypeOfSymbol(response), '', new Set(), found);

            found.secretKeys.forEach((key) => matched.add(`${route.name}:${key}`));
            found.opaque.forEach((key) => matched.add(`${route.name}:${key}`));
            found.secretKeys
                .filter((key) => !ALLOWED_SECRET_KEYS[`${route.name}:${key}`])
                .forEach((key) => unlisted.push(`${route.name} answers ${key}`));
            found.opaque
                .filter((key) => !ALLOWED_OPAQUE[`${route.name}:${key}`])
                .forEach((key) => unlisted.push(`${route.name} hides its keys at ${key}`));
        }

        expect(unlisted).toEqual([]);
        // An entry nothing matches any more is a reason no longer true; it goes.
        expect([...Object.keys(ALLOWED_SECRET_KEYS), ...Object.keys(ALLOWED_OPAQUE)]
            .filter((entry) => !matched.has(entry))).toEqual([]);
    }, 60_000);
});
