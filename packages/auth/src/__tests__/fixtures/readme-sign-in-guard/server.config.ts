// server.config.ts
import { createAuthLifecycle } from '@spfn/auth/server';
import { signInPolicy } from './src/server/sign-in-policy';

export const authLifecycle = createAuthLifecycle({ signIn: signInPolicy });
