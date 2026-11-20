/**
 * Identity probe on the built entries, run by scripts/check-bundle-identity.mjs at the
 * repository root after the build: configuration set through `@spfn/notification/config`
 * is what `@spfn/notification/server` reads when it sends.
 */

import { configureNotification } from '@spfn/notification/config';
import { configureNotification as serverConfigure, getNotificationConfig } from '@spfn/notification/server';

const failures = [];

if (configureNotification !== serverConfigure)
{
    failures.push('configureNotification from /config is not the one /server exports');
}

configureNotification({ defaults: { appName: 'bundle-identity-probe' } });

if (getNotificationConfig().defaults?.appName !== 'bundle-identity-probe')
{
    failures.push('configuration set through /config is not what /server\'s getNotificationConfig() reads');
}

if (failures.length > 0)
{
    console.error(`Identity probe failed:\n${failures.map(failure => `  - ${failure}`).join('\n')}`);
    process.exit(1);
}

console.log('Identity probe passed: /config and /server share one notification configuration.');
