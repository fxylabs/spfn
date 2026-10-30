/**
 * Social Accounts Repository
 *
 * OAuth 소셜 계정 데이터 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { eq, and } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';

import { userSocialAccounts, NewUserSocialAccount, UserSocialAccount } from '../entities';
import { type SocialProvider } from '../types';
import {
    encryptToken,
    decryptToken,
    type OAuthTokenContext,
} from '../lib/oauth/token-cipher';

/**
 * Social Accounts Repository 클래스
 */
export class SocialAccountsRepository extends BaseRepository
{
    /**
     * 저장 row 의 토큰을 평문으로 복호화해 반환한다.
     *
     * 레거시 평문(마커 없음)이 감지되면 즉시 재암호화해 저장하는
     * self-healing 마이그레이션을 수행한다. 호출자에게는 항상 평문이 반환되어
     * 외부 API 계약(평문 토큰)이 유지된다.
     */
    private async decryptAccount(account: UserSocialAccount): Promise<UserSocialAccount>;
    private async decryptAccount(account: UserSocialAccount | null): Promise<UserSocialAccount | null>;
    private async decryptAccount(account: UserSocialAccount | null): Promise<UserSocialAccount | null>
    {
        if (!account)
        {
            return account;
        }

        const context = (tokenType: OAuthTokenContext['tokenType']): OAuthTokenContext => ({
            provider: account.provider,
            providerUserId: account.providerUserId,
            tokenType,
        });
        const access = account.accessToken
            ? await decryptToken(account.accessToken, context('access'))
            : null;
        const refresh = account.refreshToken
            ? await decryptToken(account.refreshToken, context('refresh'))
            : null;
        const heal: { accessToken?: string; refreshToken?: string } = {};

        // Self-healing is best-effort: a key-rotation write must not break a read.
        // Compare the original ciphertext in the WHERE clause so a concurrent token
        // refresh cannot be overwritten with the older value read above.
        if (access?.needsRotation || refresh?.needsRotation)
        {
            try
            {
                if (access?.needsRotation)
                {
                    heal.accessToken = await encryptToken(access.value, context('access'));
                }

                if (refresh?.needsRotation)
                {
                    heal.refreshToken = await encryptToken(refresh.value, context('refresh'));
                }

                await this.db
                    .update(userSocialAccounts)
                    .set(heal)
                    .where(and(
                        eq(userSocialAccounts.id, account.id),
                        access?.needsRotation && account.accessToken !== null
                            ? eq(userSocialAccounts.accessToken, account.accessToken)
                            : undefined,
                        refresh?.needsRotation && account.refreshToken !== null
                            ? eq(userSocialAccounts.refreshToken, account.refreshToken)
                            : undefined,
                    ));
            }
            catch
            {
                // best-effort: 무시하고 read 결과 반환 진행
            }
        }

        return {
            ...account,
            accessToken: access?.value ?? account.accessToken,
            refreshToken: refresh?.value ?? account.refreshToken,
        };
    }

    /**
     * 저장할 row의 토큰을 암호화한 사본
     */
    private async withEncryptedTokens(data: NewUserSocialAccount): Promise<NewUserSocialAccount>
    {
        const context = (tokenType: OAuthTokenContext['tokenType']): OAuthTokenContext => ({
            provider: data.provider,
            providerUserId: data.providerUserId,
            tokenType,
        });

        return {
            ...data,
            accessToken: data.accessToken
                ? await encryptToken(data.accessToken, context('access'))
                : data.accessToken,
            refreshToken: data.refreshToken
                ? await encryptToken(data.refreshToken, context('refresh'))
                : data.refreshToken,
        };
    }

    /**
     * provider와 providerUserId로 소셜 계정 조회
     * Read replica 사용
     */
    async findByProviderAndProviderId(provider: SocialProvider, providerUserId: string)
    {
        const result = await this.readDb
            .select()
            .from(userSocialAccounts)
            .where(
                and(
                    eq(userSocialAccounts.provider, provider),
                    eq(userSocialAccounts.providerUserId, providerUserId),
                ),
            )
            .limit(1);

        return this.decryptAccount(result[0] ?? null);
    }

    /**
     * userId로 모든 소셜 계정 조회
     * Read replica 사용
     */
    async findByUserId(userId: number)
    {
        const result = await this.readDb
            .select()
            .from(userSocialAccounts)
            .where(eq(userSocialAccounts.userId, userId));

        return Promise.all(result.map(account => this.decryptAccount(account)));
    }

    /**
     * userId와 provider로 소셜 계정 조회
     * Read replica 사용
     */
    async findByUserIdAndProvider(userId: number, provider: SocialProvider)
    {
        const result = await this.readDb
            .select()
            .from(userSocialAccounts)
            .where(
                and(
                    eq(userSocialAccounts.userId, userId),
                    eq(userSocialAccounts.provider, provider),
                ),
            )
            .limit(1);

        return this.decryptAccount(result[0] ?? null);
    }

    /**
     * 소셜 계정 생성
     * Write primary 사용
     */
    async create(data: NewUserSocialAccount)
    {
        const created = await this._create(userSocialAccounts, await this.withEncryptedTokens(data));

        // repo 외부 계약을 "토큰은 항상 평문"으로 통일 (read/update 경로와 일관)
        return this.decryptAccount(created);
    }

    /**
     * 소셜 계정 생성 — (provider, providerUserId)가 이미 있으면 아무것도 쓰지 않고 null
     *
     * 세션에서 시작한 연결(#154)이 쓴다. 두 계정이 같은 provider 신원을 동시에 연결해도
     * unique 위반으로 트랜잭션이 깨지지 않고, 진 쪽은 null을 받아 소유자를 다시 읽는다.
     * Write primary 사용
     */
    async createIfAbsent(data: NewUserSocialAccount)
    {
        const result = await this.db
            .insert(userSocialAccounts)
            .values(await this.withEncryptedTokens(data))
            .onConflictDoNothing({ target: [userSocialAccounts.provider, userSocialAccounts.providerUserId] })
            .returning();

        return this.decryptAccount(result[0] ?? null);
    }

    /**
     * 토큰 정보 업데이트 (provider가 보고한 handle 포함)
     * Write primary 사용
     */
    async updateTokens(
        id: number,
        data: {
            accessToken?: string | null;
            refreshToken?: string | null;
            tokenExpiresAt?: Date | null;
            providerHandle?: string | null;
        },
    )
    {
        const accounts = await this.db
            .select({
                provider: userSocialAccounts.provider,
                providerUserId: userSocialAccounts.providerUserId,
            })
            .from(userSocialAccounts)
            .where(eq(userSocialAccounts.id, id))
            .limit(1);
        const account = accounts[0];

        if (!account)
        {
            return null;
        }

        const context = (tokenType: OAuthTokenContext['tokenType']): OAuthTokenContext => ({
            provider: account.provider,
            providerUserId: account.providerUserId,
            tokenType,
        });
        const result = await this.db
            .update(userSocialAccounts)
            .set({
                ...data,
                accessToken: data.accessToken
                    ? await encryptToken(data.accessToken, context('access'))
                    : data.accessToken,
                refreshToken: data.refreshToken
                    ? await encryptToken(data.refreshToken, context('refresh'))
                    : data.refreshToken,
            })
            .where(eq(userSocialAccounts.id, id))
            .returning();

        return this.decryptAccount(result[0] ?? null);
    }

    /**
     * 소셜 계정 삭제
     * Write primary 사용
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(userSocialAccounts)
            .where(eq(userSocialAccounts.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * userId와 provider로 소셜 계정 삭제
     * Write primary 사용
     */
    async deleteByUserIdAndProvider(userId: number, provider: SocialProvider)
    {
        const result = await this.db
            .delete(userSocialAccounts)
            .where(
                and(
                    eq(userSocialAccounts.userId, userId),
                    eq(userSocialAccounts.provider, provider),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자의 모든 소셜 계정 삭제 (계정 익명화 파기용)
     *
     * provider unique index(provider, providerUserId)를 해제해 같은 소셜 계정으로
     * 재가입할 수 있게 한다.
     * Write primary 사용
     */
    async deleteAllByUserId(userId: number): Promise<number>
    {
        const result = await this.db
            .delete(userSocialAccounts)
            .where(eq(userSocialAccounts.userId, userId))
            .returning();

        return result.length;
    }
}

// Default instance export
export const socialAccountsRepository = new SocialAccountsRepository();
