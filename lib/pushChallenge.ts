// Shared between app/api/notifications/challenge/route.ts (issues the
// challenge) and app/api/notifications/subscribe/route.ts (verifies it) —
// both need the exact same message string, so it's defined once here rather
// than duplicated across two route.ts files (which should only export
// handlers, not arbitrary helpers).
//
// Binds the signature to the SPECIFIC push endpoint being registered, not
// just the identity — otherwise a signature obtained under any pretext
// (e.g. a phishing site presenting this same "sign to enable push
// notifications" text out of context) could be replayed against a
// different subscription object entirely, letting an attacker hijack the
// identity's alert channel without ever needing the original request.
export function buildChallengeMessage(identity: string, nonce: string, endpoint: string): string {
  return `Sign this message to enable push notifications for Skopos.\n\nAddress: ${identity}\nEndpoint: ${endpoint}\nNonce: ${nonce}`;
}
