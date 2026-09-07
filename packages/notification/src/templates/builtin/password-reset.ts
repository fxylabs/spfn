/**
 * @spfn/notification - Password Reset Link Template
 *
 * Sent when someone asks to reset the password on an account that can be reset —
 * an active account that has proved its email address. Opening the link takes
 * them to the page where they choose a new password; the old one keeps working
 * until they do.
 *
 * No mail goes to an address with no matching account, so this template is never
 * the answer to "does this address have an account here".
 *
 * Email only: the reset flow is a web flow, and there is no SMS equivalent.
 */

import type { TemplateDefinition } from '../types';

export const passwordResetTemplate: TemplateDefinition = {
    name: 'password-reset',
    channels: ['email'],

    email: {
        subject: '[{{appName}}] Choose a new password',
        html: `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">{{appName}}</h1>
    </div>
    <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
        <p style="margin-bottom: 20px; font-size: 16px;">
            Choose a new password for your account. Everything else signed in right now will be signed out.
        </p>
        <p style="text-align: center; margin: 32px 0;">
            <a href="{{confirmUrl}}" style="display: inline-block; background: #667eea; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 16px; font-weight: 600;">Choose a new password</a>
        </p>
        <p style="margin-bottom: 20px; font-size: 14px; color: #666;">
            The link works once and expires in {{expiresInMinutes}} minutes. If the button does not work, paste this into your browser:
        </p>
        <p style="margin-bottom: 20px; font-size: 13px; color: #666; word-break: break-all;">
            {{confirmUrl}}
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        <p style="color: #666; font-size: 14px; margin: 0;">
            If you did not ask for this, ignore it — your password has not changed.
        </p>
    </div>
</body>
</html>`,
        text: `[{{appName}}] Choose a new password

Choose a new password for your account. Everything else signed in right now will be signed out.

{{confirmUrl}}

The link works once and expires in {{expiresInMinutes}} minutes.

If you did not ask for this, ignore it — your password has not changed.`,
    },
};
