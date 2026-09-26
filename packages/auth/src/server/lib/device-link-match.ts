/**
 * @spfn/auth - Device-link match numbers
 *
 * The redeeming device shows one two-digit number; the issuer is shown three and
 * picks the one on that device's screen. The number is what ties the device the
 * issuer is looking at to the device that redeemed the code: whoever read the
 * code off the issuer's screen from elsewhere redeems it on a device the issuer
 * cannot see, so the issuer has no number to pick.
 *
 * Three choices, not one to type, is a trade the design makes openly: an issuer
 * who taps without looking at the new device picks the attacker's number one
 * time in three. One wrong pick ends the link, so that is the whole of the odds.
 */

import { randomInt } from 'node:crypto';

/** Two digits, never a leading zero, so every number reads the same on both screens. */
const MATCH_MIN = 10;
const MATCH_MAX_EXCLUSIVE = 100;

/** The match and two decoys. */
export const DEVICE_LINK_CHOICE_COUNT = 3;

export function generateMatchNumber(): number
{
    return randomInt(MATCH_MIN, MATCH_MAX_EXCLUSIVE);
}

/**
 * The match among decoys that differ from it and from each other, in an order
 * drawn once. Stored with the record, so every status answer shows the same
 * three in the same place — a list that reshuffled on each poll would make the
 * issuer hunt for the number again at every refresh.
 */
export function generateChoices(matchNumber: number): number[]
{
    const choices = new Set<number>([matchNumber]);

    while (choices.size < DEVICE_LINK_CHOICE_COUNT)
    {
        choices.add(generateMatchNumber());
    }

    return shuffle([...choices]);
}

/** Fisher–Yates with a cryptographic source, so the match's position gives nothing away. */
function shuffle(values: number[]): number[]
{
    for (let index = values.length - 1; index > 0; index--)
    {
        const other = randomInt(index + 1);

        [values[index], values[other]] = [values[other], values[index]];
    }

    return values;
}
