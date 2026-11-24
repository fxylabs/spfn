/**
 * Not one of the README's blocks: the app's own record of the temporary
 * passwords it issued, which the README's policy imports and does not show.
 * No account in the sign-in guard suite carries one.
 */
export const temporaryPasswordsRepository = {
    hasExpired: async (_userId: number): Promise<boolean> => false,
};
