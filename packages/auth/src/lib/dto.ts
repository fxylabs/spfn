/**
 * Role information for client/API responses
 */
export interface Role
{
    id: number;
    name: string;
    displayName: string;
    description: string | null;
    isBuiltin: boolean;
    isSystem: boolean;
    isActive: boolean;
    priority: number;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Permission information for client/API responses
 */
export interface Permission
{
    id: number;
    name: string;
    displayName: string;
    description: string | null;
    category: string | null;
    isBuiltin: boolean;
    isSystem: boolean;
    isActive: boolean;
    metadata: Record<string, any> | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface AuthSession
{
    userId: number;
    publicId: string;
    email: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    hasPassword: boolean;
    role: Role;
    permissions: Permission[];
}

export interface ProfileInfo
{
    profileId: number;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    /** The person's language choice, or `'en'` when they never made one. */
    locale: string;
    /** The person's language choice, or `null` when they never made one. */
    chosenLocale: string | null;
    timezone: string;
    website: string | null;
    location: string | null;
    company: string | null;
    jobTitle: string | null;
    metadata: Record<string, any> | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * User Profile Response
 *
 * Complete user data including:
 * - User fields at top level (userId, email, etc.)
 * - Profile data as nested field (optional)
 *
 * Excludes:
 * - Role and permissions (use auth session API)
 */
export interface UserProfile
{
    userId: number;
    publicId: string;
    email: string | null;
    username: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    profile: ProfileInfo | null;
}
