/**
 * Terminal-safe rendering of app-supplied text
 *
 * Its own module because both the manifest client and the usage renderer need
 * it, and the client must not import the renderer to get it.
 */

/**
 * Strip what a terminal would act on rather than show.
 *
 * Every string rendered here — a field's description, its pattern, a command's
 * name — is the app's, and it is written straight to the operator's terminal.
 * Escape sequences left in it can clear the screen or redraw the lines above,
 * so what the operator reads is no longer what the CLI wrote. Control
 * characters are replaced rather than dropped, so text that contained them
 * still reads as suspicious instead of quietly shrinking.
 */
export function plain(value: string): string
{
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}
