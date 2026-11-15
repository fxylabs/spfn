/**
 * @spfn/auth - Middleware
 */

export * from './authenticate';
export { authenticateForRenewal } from './authenticate-for-renewal';
export {
    registerAuthProfile,
    selectAuthProfile,
    runAuthProfile,
    type AuthProfile,
    type AuthProfileIdentity,
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
export {
    signedTokenAuth,
    getSignedToken,
    type SignedTokenAuthOptions,
    type VerifiedSignedToken,
} from './signed-token-auth';
export * from './ops-or-user';
