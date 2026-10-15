/**
 * The one way an account provider puts the account's e-mail address in a snapshot.
 *
 * Whatever a provider publishes reaches every widget subscribed to its channel — a third-party
 * widget from the marketplace with network access included, whose consent dialog said "reads
 * channel X", not "reads your e-mail" — and whatever a widget shows is on a screen on a desk. So
 * the address is left out unless the user turned `privacy.showAccountEmail` on, and the check is
 * made here, on the server, not by the widget that would display it.
 *
 * Spread the result into the snapshot: `{ plan, authMode, ...withAccountEmail(email, show()) }`.
 * Pass `show` as `() => store.get().privacy.showAccountEmail` and call it on every poll rather
 * than capturing it, so the admin's toggle takes effect without a restart. The plan and the
 * sign-in method are not covered by the setting and are published either way.
 */
export function withAccountEmail(email: string | null | undefined, show: boolean): { email?: string } {
  return show && email ? { email } : {}
}
