/**
 * @spfn/auth - Auth Events
 *
 * 인증 관련 이벤트 정의
 * - auth.login: 로그인 성공 시 (기존 사용자만)
 * - auth.register: 회원가입 성공 시 (OAuth 신규 가입 포함)
 */

import { defineEvent } from '@spfn/core/event';
import { Type } from '@sinclair/typebox';

import { SOCIAL_PROVIDERS } from '../types';

/**
 * Auth provider type
 *
 * 직접 인증(email/phone) + 등록 가능한 모든 소셜 provider(SOCIAL_PROVIDERS).
 */
export const AuthProviderSchema = Type.Union([
    Type.Literal('email'),
    Type.Literal('phone'),
    ...SOCIAL_PROVIDERS.map(p => Type.Literal(p)),
]);

/**
 * Login provider type
 *
 * AuthProviderSchema + `'device'` and `'passkey'`.
 *
 * `'device'` is how a device-code login names itself: the account was proven on
 * another device that was already signed in, so no credential was presented here
 * and none of the values above describes it. `'passkey'` is a WebAuthn assertion
 * — a credential of the account, but not one of the sign-up channels.
 *
 * A separate union rather than a widened AuthProviderSchema. Neither is a way to
 * register — a device-code request can only ever be approved by an existing
 * account, and a passkey has to be enrolled from a session that already exists —
 * and neither is something a provider can unlink, so the two events that mean
 * those things must not start accepting them.
 */
export const AuthLoginProviderSchema = Type.Union([
    Type.Literal('email'),
    Type.Literal('phone'),
    Type.Literal('device'),
    Type.Literal('passkey'),
    ...SOCIAL_PROVIDERS.map(p => Type.Literal(p)),
]);

/**
 * auth.login - 로그인 성공 이벤트
 *
 * 발행 시점:
 * - 이메일/전화 로그인 성공 시
 * - OAuth 기존 사용자 로그인 시
 * - 기기 코드 승인이 소비되어 새 기기 키가 등록될 때 (provider: 'device')
 *
 * @example
 * ```typescript
 * authLoginEvent.subscribe(async (payload) => {
 *     await analytics.trackLogin(payload.userId, payload.provider);
 * });
 * ```
 */
export const authLoginEvent = defineEvent(
    'auth.login',
    Type.Object({
        userId: Type.String(),
        provider: AuthLoginProviderSchema,
        email: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
    }),
);

/**
 * auth.register - 회원가입 성공 이벤트
 *
 * 발행 시점:
 * - 이메일/전화 회원가입 성공 시
 * - OAuth 신규 사용자 가입 시
 *
 * @example
 * ```typescript
 * authRegisterEvent.subscribe(async (payload) => {
 *     await emailService.sendWelcome(payload.email);
 * });
 * ```
 */
export const authRegisterEvent = defineEvent(
    'auth.register',
    Type.Object({
        userId: Type.String(),
        provider: AuthProviderSchema,
        email: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
);

/**
 * auth.passkey.enrolled — a WebAuthn credential was added to an account
 *
 * 발행 시점:
 * - finishPasskeyEnrollmentService()가 커밋된 직후
 *
 * A new way into the account, added from a session that already existed. Apps
 * subscribe to tell the owner about it — the same notice a new device login
 * deserves, since that is what this becomes.
 *
 * @example
 * ```typescript
 * passkeyEnrolledEvent.subscribe(async (payload) => {
 *     await notifyOwner(payload.userId, 'A passkey was added to your account');
 * });
 * ```
 */
export const passkeyEnrolledEvent = defineEvent(
    'auth.passkey.enrolled',
    Type.Object({
        userId: Type.String(),
        passkeyId: Type.String(),
        label: Type.Optional(Type.String()),
    }),
);

/**
 * auth.passkey.revoked — a WebAuthn credential was retired
 *
 * 발행 시점:
 * - revokePasskeyService()가 커밋된 직후
 *
 * `reason` is why the row was retired, not who asked: `'user'` is the only value
 * the package emits today, and it exists so a later automatic revocation is
 * distinguishable to a subscriber that already ships.
 */
export const passkeyRevokedEvent = defineEvent(
    'auth.passkey.revoked',
    Type.Object({
        userId: Type.String(),
        passkeyId: Type.String(),
        reason: Type.String(),
    }),
);

/**
 * auth.invitation.created - 초대 생성 이벤트
 *
 * 발행 시점:
 * - createInvitation() 성공 시
 * - resendInvitation() 성공 시
 *
 * @example
 * ```typescript
 * invitationCreatedEvent.subscribe(async (payload) => {
 *     const inviteUrl = `${APP_URL}/invite/${payload.token}`;
 *     await notificationService.send({
 *         channel: 'email',
 *         to: payload.email,
 *         subject: 'You are invited!',
 *         html: renderInviteEmail({ inviteUrl, ...payload.metadata }),
 *     });
 * });
 * ```
 */
export const invitationCreatedEvent = defineEvent(
    'auth.invitation.created',
    Type.Object({
        invitationId: Type.String(),
        email: Type.String(),
        token: Type.String(),
        roleId: Type.Number(),
        invitedBy: Type.String(),
        expiresAt: Type.String(),
        isResend: Type.Boolean(),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
);

/**
 * auth.invitation.accepted - 초대 수락 이벤트
 *
 * 발행 시점:
 * - acceptInvitation() 성공 시
 *
 * @example
 * ```typescript
 * invitationAcceptedEvent.subscribe(async (payload) => {
 *     await onboardingService.start(payload.userId);
 * });
 * ```
 */
export const invitationAcceptedEvent = defineEvent(
    'auth.invitation.accepted',
    Type.Object({
        invitationId: Type.String(),
        email: Type.String(),
        userId: Type.String(),
        roleId: Type.Number(),
        invitedBy: Type.String(),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
);

/**
 * auth.deletion.requested - 계정 탈퇴 요청 이벤트
 *
 * 발행 시점:
 * - requestAccountDeletionService() 성공 시 (self/admin 공통)
 *
 * @example
 * ```typescript
 * authDeletionRequestedEvent.subscribe(async (payload) => {
 *     await analytics.trackChurnRisk(payload.userId);
 * });
 * ```
 */
export const authDeletionRequestedEvent = defineEvent(
    'auth.deletion.requested',
    Type.Object({
        userId: Type.String(),
        userPublicId: Type.String(),
        purgeScheduledAt: Type.String(),
        requestedBy: Type.Union([Type.Literal('self'), Type.Literal('admin')]),
    }),
);

/**
 * auth.deletion.cancelled - 계정 탈퇴 복구 이벤트
 *
 * 발행 시점:
 * - cancelAccountDeletionService() 성공 시 (유예 기간 내 복구)
 */
export const authDeletionCancelledEvent = defineEvent(
    'auth.deletion.cancelled',
    Type.Object({
        userId: Type.String(),
        userPublicId: Type.String(),
    }),
);

/**
 * auth.deletion.completed - 계정 파기 완료 이벤트
 *
 * 발행 시점:
 * - purge job(또는 즉시 파기 경로)이 유저를 파기한 직후
 *
 * PII를 담지 않는다 — userId(내부 순번)/email/phone 없이 userPublicId만 실어
 * 파기 완료 이후에도 구독자가 식별 정보를 다시 축적하지 않도록 한다.
 */
export const authDeletionCompletedEvent = defineEvent(
    'auth.deletion.completed',
    Type.Object({
        userPublicId: Type.String(),
        purgeStrategy: Type.Union([Type.Literal('anonymize'), Type.Literal('hard-delete')]),
    }),
);

/**
 * auth.oauth.unlinked - provider발 연동 해제 이벤트
 *
 * 발행 시점:
 * - provider(카카오·네이버 등)가 unlink-notify 웹훅으로 연동 해제를 알려와
 *   소셜 계정 연결과 저장 토큰이 삭제된 직후
 *
 * 연결 삭제까지는 프레임워크가 수행하고, 그 이후(계정 탈퇴로 이어갈지 등)는
 * 앱 정책이므로 이 이벤트를 구독해 처리한다.
 *
 * @example
 * ```typescript
 * oauthUnlinkedEvent.subscribe(async (payload) => {
 *     await requestAccountDeletionService({ userId: payload.userId, requestedBy: 'self' });
 * });
 * ```
 */
export const oauthUnlinkedEvent = defineEvent(
    'auth.oauth.unlinked',
    Type.Object({
        userId: Type.String(),
        provider: AuthProviderSchema,
        providerUserId: Type.String(),
        /** provider가 전달한 해제 경로 (kakao referrer_type 등) */
        reason: Type.Optional(Type.String()),
    }),
);

/**
 * Auth event payload types
 */
export type AuthLoginPayload = typeof authLoginEvent._payload;
export type PasskeyEnrolledPayload = typeof passkeyEnrolledEvent._payload;
export type PasskeyRevokedPayload = typeof passkeyRevokedEvent._payload;
export type AuthRegisterPayload = typeof authRegisterEvent._payload;
export type InvitationCreatedPayload = typeof invitationCreatedEvent._payload;
export type InvitationAcceptedPayload = typeof invitationAcceptedEvent._payload;
export type AuthDeletionRequestedPayload = typeof authDeletionRequestedEvent._payload;
export type AuthDeletionCancelledPayload = typeof authDeletionCancelledEvent._payload;
export type AuthDeletionCompletedPayload = typeof authDeletionCompletedEvent._payload;
export type OAuthUnlinkedPayload = typeof oauthUnlinkedEvent._payload;
