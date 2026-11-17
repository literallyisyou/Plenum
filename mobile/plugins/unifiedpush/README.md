# plenum-unifiedpush (Android)

UnifiedPush for the Plenum Android app (MOBILE.json push.phase2_android; MOBILE-UI section 10). The person chooses a push
app such as ntfy; the connector (org.unifiedpush.android:connector 3.3.5, Apache-2.0) registers with it, and the desktop's
encrypted Web Push messages reach the phone through it.

- `UnifiedPush.getDistributors()`, `chooseDistributor({ packageName })`, `pickDistributor()`
- `UnifiedPush.register({ instance?, messageForDistributor?, vapid? })`, `unregister({ instance? })`
- `getState()`: distributor, endpoints (url and temporary only), failures, registrations, visible, endpointChanged
- `cancel({ tag })`, `cancelAll({ channel? })`: take shown notifications down (wave 4)
- `setStopCards({ cards })`, `noteStopCounter({ computer, counter })`, `stopCounters()`: the native Stop (wave 6, below)
- `showNotification({ content })`: shows a message as this plugin's own notification while Plenum is in front (wave 6)
- Events: `endpoint` (url, temporary, pubKeySet once), `message` (base64 content, decrypted, shown, clear), `registrationFailed`,
  `unregistered`, `tempUnavailable`
- `requestNotificationPermission()` (Android 13 and later; asked after a tap)

Closed-app notifications: when Plenum is not in front, `UnifiedPushService` shows the desktop's notification itself
(channels plenum-approvals, plenum-finished, plenum-problems, plenum-limits, created when the plugin loads; Deny, Stop all and
an opt-in Approve; only Approve asks for the device unlock). The shell does not show a second notification for a message the
service showed (`shown: true`).

Stop with no unlock (wave 6): Android asks for the phone's unlock before it opens an app screen from a notification button, so
a Stop that opened Plenum waited for the PIN. Now, when the phone holds the computer's Stop card, Stop all is a broadcast to
`StopReceiver`, which sends the computer one signed Stop-only message itself (`StopSender.java`, the same message the shell's
lock screen sends, lib/remote/stop-only.mjs) and changes the notification to "Stopping…", then "Stopped" or "Could not reach
<computer>. Open Plenum to stop it." with Try again. The 'clear' the computer sends for that notification when the Stop takes
its cards (and the shell's own clear) leaves the Stop's notification up in every state: "Stopped" goes by itself after 5
minutes, and "Could not reach" stays through a later clear (the card still waits on the computer) until a tap, a swipe, a new
notification for it or 1 hour. The shell hands the cards over each time it saves its computers
(mobile/shell/native.js), and a forgotten computer's card goes with it. A card holds only the computer's id and name, this
phone's id there, the Stop key and the addresses: never the phone's private key or the push key. The cards are kept in the
app's private storage, encrypted with an Android Keystore key that needs no unlock. Without a card, Stop opens Plenum as before.

Keys: the endpoint's key set is handed to the shell once and never stored or logged by this plugin.
