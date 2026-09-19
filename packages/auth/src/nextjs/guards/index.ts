import 'server-only';

/**
 * Next.js Server Component Guards
 *
 * React components for protecting routes and content based on authentication state,
 * roles, and permissions.
 *
 * @example
 * ```tsx
 * import { RequireAuth, RequireRole, RequirePermission } from '@spfn/auth/nextjs';
 *
 * export default async function AdminPage() {
 *   return (
 *     <RequireAuth>
 *       <RequireRole roles={['admin', 'superadmin']}>
 *         <AdminDashboard />
 *       </RequireRole>
 *     </RequireAuth>
 *   );
 * }
 * ```
 */

export { RequireAuth } from './require-auth';
export type { RequireAuthProps } from './require-auth';

export { RequireRole } from './require-role';
export type { RequireRoleProps } from './require-role';

export { RequirePermission } from './require-permission';
export type { RequirePermissionProps } from './require-permission';

export { getAuthSessionData, getUserRole, getUserPermissions, hasAnyRole, hasAnyPermission, RENEWAL_REQUIRED } from './auth-utils';
export type { AuthSessionData, AuthSessionState } from './auth-utils';
