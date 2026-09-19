/**
 * @spfn/auth - Middleware
 */

export * from './authenticate';
export { authenticateForRenewal, admitsForRenewal } from './authenticate-for-renewal';
export {
    registerAuthProfile,
    selectAuthProfile,
    runAuthProfile,
    resolveAuthenticatedUser,
    type AuthProfileOutcome,
    type AuthProfileVerifier,
} from './auth-profiles';
export {
    registerMachineVerifier,
    machineAuth,
    getMachinePrincipal,
    requireMachineScope,
    type MachinePrincipal,
    type MachineVerifierRegistration,
} from './machine-principals';
export * from './require-permission';
export * from './require-role';
export * from './role-guard';
export * from './one-time-token-auth';
export * from './ops-token-auth';
export * from './ops-or-user';
