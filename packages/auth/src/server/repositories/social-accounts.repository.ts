/**
 * Social Accounts Repository
 *
 * OAuth 소셜 계정 데이터 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { eq, and } from 'drizzle-orm';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

import { userSocialAccounts, type NewUserSocialAccount, type UserSocialAccount } from '../entities';
import { type SocialProvider } from '../types';
import {
    encryptToken,
    decryptToken,
    type OAuthTokenContext,
} from '../lib/oauth/token-cipher';

/**
 * A social account as sign-in, listing and unlinking read it: everything but the
 * stored provider tokens, which only the code that uses them decrypts.
 */
export type SocialAccountLink = Omit<UserSocialAccount, 'accessToken' | 'refreshToken'>;

/** A social account's provider tokens, decrypted. */
export interface SocialAccountTokens
{
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
}

/** Every column but the two token columns. */
const linkColumns = {
    id: userSocialAccounts.id,
    userId: userSocialAccounts.userId,
    provider: userSocialAccounts.provider,
    providerUserId: userSocialAccounts.providerUserId,
    providerEmail: userSocialAccounts.providerEmail,
    providerHandle: userSocialAccounts.providerHandle,
    tokenExpiresAt: userSocialAccounts.tokenExpiresAt,
    createdAt: userSocialAccounts.createdAt,
    updatedAt: userSocialAccounts.updatedAt,
};

/**
 * Social Accounts Repository 클래스
 */
export class SocialAccountsRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<SocialAccountsRepository> = {
        rotateTokens: { exempt: 'a re-encryption of the provider\'s own tokens (and display handle): no admission or sign-in here reads them, and the identity columns — account, provider, provider user id — are not written; conditional on the ciphertext read' },
        createIfAbsent: { account: data => data.userId },
        updateTokens: { exempt: 'the provider\'s own tokens (and display handle): no admission or sign-in here reads them, and the identity columns — account, provider, provider user id — are not written' },
        deleteById: { account: link => link.userId },
        deleteByUserIdAndProvider: { account: userId => userId },
        deleteAllByUserId: { account: userId => userId },
    };

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
     * provider와 providerUserId로 소셜 계정 조회 — tokens are not read
     * Read replica 사용
     */
    async findByProviderAndProviderId(provider: SocialProvider, providerUserId: string): Promise<SocialAccountLink | null>
    {
        const result = await this.readDb
            .select(linkColumns)
            .from(userSocialAccounts)
            .where(
                and(
                    eq(userSocialAccounts.provider, provider),
                    eq(userSocialAccounts.providerUserId, providerUserId),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * userId로 모든 소셜 계정 조회 — tokens are not read
     * Read replica 사용
     */
    async findByUserId(userId: number): Promise<SocialAccountLink[]>
    {
        return await this.readDb
            .select(linkColumns)
            .from(userSocialAccounts)
            .where(eq(userSocialAccounts.userId, userId));
    }

    /**
     * userId와 provider로 소셜 계정 조회 — tokens are not read
     *
     * At most one row: `(user_id, provider)` is unique.
     * Read replica 사용
     */
    async findByUserIdAndProvider(userId: number, provider: SocialProvider): Promise<SocialAccountLink | null>
    {
        const result = await this.readDb
            .select(linkColumns)
            .from(userSocialAccounts)
            .where(
                and(
                    eq(userSocialAccounts.userId, userId),
                    eq(userSocialAccounts.provider, provider),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * The account's stored provider tokens, decrypted — for the code that calls the provider with them.
     *
     * A token still under a retired key or stored before encryption is
     * re-encrypted under the active key here, guarded by the ciphertext read so a
     * concurrent refresh is never overwritten with the older value. A token that
     * does not decrypt throws: this is the only place that needs it to.
     * Write primary 사용
     */
    async readTokens(id: number): Promise<SocialAccountTokens | null>
    {
        const [account] = await this.db
            .select()
            .from(userSocialAccounts)
            .where(eq(userSocialAccounts.id, id))
            .limit(1);

        if (!account)
        {
            return null;
        }

        const context = (tokenType: OAuthTokenContext['tokenType']): OAuthTokenContext => ({
            provider: account.provider,
            providerUserId: account.providerUserId,
            tokenType,
        });
        const access = account.accessToken ? await decryptToken(account.accessToken, context('access')) : null;
        const refresh = account.refreshToken ? await decryptToken(account.refreshToken, context('refresh')) : null;

        await this.rotateTokens(account, {
            accessToken: access?.needsRotation ? await encryptToken(access.value, context('access')) : undefined,
            refreshToken: refresh?.needsRotation ? await encryptToken(refresh.value, context('refresh')) : undefined,
        });

        return {
            accessToken: access?.value ?? null,
            refreshToken: refresh?.value ?? null,
            tokenExpiresAt: account.tokenExpiresAt,
        };
    }

    /** Store the re-encrypted tokens, only where the row still holds the ciphertext they were read from. */
    private async rotateTokens(
        account: UserSocialAccount,
        rotated: { accessToken?: string; refreshToken?: string },
    ): Promise<void>
    {
        if (!rotated.accessToken && !rotated.refreshToken)
        {
            return;
        }

        await this.db
            .update(userSocialAccounts)
            .set(rotated)
            .where(and(
                eq(userSocialAccounts.id, account.id),
                rotated.accessToken ? eq(userSocialAccounts.accessToken, account.accessToken!) : undefined,
                rotated.refreshToken ? eq(userSocialAccounts.refreshToken, account.refreshToken!) : undefined,
            ));
    }

    /**
     * 소셜 계정 생성 — or nothing, and null, when the row would break either rule
     * the table holds: one account per provider identity (`provider`,
     * `provider_user_id`) and one identity per provider per account (`user_id`,
     * `provider`).
     *
     * Never a unique violation, so the caller's transaction stays usable to read
     * which rule stood in the way.
     * Write primary 사용
     */
    async createIfAbsent(data: NewUserSocialAccount): Promise<SocialAccountLink | null>
    {
        const result = await this.db
            .insert(userSocialAccounts)
            .values(await this.withEncryptedTokens(data))
            .onConflictDoNothing()
            .returning(linkColumns);

        return result[0] ?? null;
    }

    /**
     * 토큰 정보 업데이트 (provider가 보고한 handle 포함)
     *
     * A field left out (or `undefined`) keeps its stored value — a sign-in whose
     * provider sent no new refresh token keeps the stored one without reading it.
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
            .returning(linkColumns);

        return result[0] ?? null;
    }

    /**
     * 소셜 계정 삭제
     * Write primary 사용
     */
    async deleteById(link: Pick<UserSocialAccount, 'id' | 'userId'>)
    {
        const result = await this.db
            .delete(userSocialAccounts)
            .where(and(eq(userSocialAccounts.id, link.id), eq(userSocialAccounts.userId, link.userId)))
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
