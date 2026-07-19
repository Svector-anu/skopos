// Shared between app/api/notifications/challenge/route.ts (issues the
// challenge) and app/api/notifications/subscribe/route.ts (verifies it) —
// both need the exact same message string, so it's defined once here rather
// than duplicated across two route.ts files (which should only export
// handlers, not arbitrary helpers).
export function buildChallengeMessage(identity: string, nonce: string): string {
  return `Sign this message to enable push notifications for Skopos.\n\nAddress: ${identity}\nNonce: ${nonce}`;
}
