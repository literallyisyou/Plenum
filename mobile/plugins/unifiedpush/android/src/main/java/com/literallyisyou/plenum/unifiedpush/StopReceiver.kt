package com.literallyisyou.plenum.unifiedpush

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.util.Collections
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocketFactory

/**
 * Stop from a notification with no unlock and no app screen (wave 6, k3). The Stop button of a Plenum notification is a broadcast to
 * this receiver, not an activity: Android asks for the phone's unlock before it opens an activity from a notification button, but not
 * before it delivers a broadcast. The receiver sends the Stop-only message itself (StopSender: one signed STOP_ONLY, the same message the
 * shell's lock screen sends), to the computer that sent the notification, with the Stop card the shell handed over (StopCards).
 *
 * The notification (the same tag, so still one notification) says "Stopping…", then "Stopped" with what was stopped, or "Could not reach
 * <computer>. Open Plenum to stop it." with a Try again button; a tap on it opens Plenum at #stop for that computer, the old path.
 * The work runs on its own thread inside goAsync(), within StopSender.BUDGET_MS, so nothing long runs on the main thread.
 *
 * Declared in the plugin's manifest, not exported and with no intent filter: only Plenum's own PendingIntents (pendingFor) reach it.
 * Nothing here logs, and no key is in the intent (it names the notification's tag and the computer's id, both in the push itself).
 */
class StopReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STOP) return
        val app = context.applicationContext
        val tag = intent.getStringExtra(EXTRA_TAG)?.takeIf { PlenumNotifier.isCancelTag(it) } ?: PlenumNotifier.FALLBACK_TAG
        val computer = intent.getStringExtra(EXTRA_COMPUTER)?.takeIf { COMPUTER.matches(it) } ?: return
        // A second press while the first is on its way does nothing more: the notification already says Stopping….
        if (!running.add(computer)) return
        val pending = goAsync()
        val where = try {
            PlenumNotifier.placeOf(app, tag)
        } catch (e: RuntimeException) {
            PlenumNotifier.Place(PlenumNotifier.CHANNEL_APPROVALS, tag)
        }
        try {
            PlenumNotifier.showStop(app, tag, computer, where, PlenumNotifier.StopState.STOPPING, "", null)
        } catch (e: RuntimeException) {
            // The notification could not be updated; the Stop still goes out.
        }
        worker.execute {
            var name = ""
            var state = PlenumNotifier.StopState.FAILED
            var counts: LongArray? = null
            try {
                val card = StopCards.get(app, computer)
                if (card != null) {
                    name = card.name
                    val ways = StopSender.dialOrder(card.ways, card.lastCarrier, card.lastUrl, onMobileData(app))
                    val out = StopSender.send(
                        ways,
                        card.stopKey,
                        card.deviceId,
                        { atLeast -> StopCards.raise(app, card, atLeast) },
                        StopSender.BUDGET_MS,
                        SSLSocketFactory.getDefault() as SSLSocketFactory,
                        { host, session -> HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session) },
                    )
                    card.stopKey.fill(0)
                    state = when (out.status) {
                        "stopped" -> PlenumNotifier.StopState.STOPPED
                        "unknown" -> PlenumNotifier.StopState.NOT_ACCEPTED
                        else -> PlenumNotifier.StopState.FAILED
                    }
                    counts = out.counts
                }
            } catch (e: Exception) {
                state = PlenumNotifier.StopState.FAILED
            } finally {
                try {
                    PlenumNotifier.showStop(app, tag, computer, where, state, name, counts)
                } catch (e: RuntimeException) {
                    // Nothing more can be said.
                }
                running.remove(computer)
                pending.finish()
            }
        }
    }

    // On mobile data a plain ws:// address on a private range cannot answer: it is dialled last (carriers.js dialOrder).
    private fun onMobileData(context: Context): Boolean =
        try {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val caps = manager?.getNetworkCapabilities(manager.activeNetwork)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (e: RuntimeException) {
            false
        }

    companion object {
        const val ACTION_STOP = "com.literallyisyou.plenum.unifiedpush.STOP"
        const val EXTRA_TAG = "tag"
        const val EXTRA_COMPUTER = "computer"
        private val COMPUTER = Regex("^[0-9a-f]{64}$")
        private val running: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())
        private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "plenum-stop").apply { isDaemon = true } }

        /** The Stop button's PendingIntent for one notification and computer: a broadcast to this receiver, immutable, explicit. */
        fun pendingFor(context: Context, tag: String, computer: String): PendingIntent {
            val intent = Intent(ACTION_STOP)
                .setClass(context, StopReceiver::class.java)
                .setPackage(context.packageName)
                .putExtra(EXTRA_TAG, tag)
                .putExtra(EXTRA_COMPUTER, computer)
            return PendingIntent.getBroadcast(
                context,
                ("stop|$tag|$computer").hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
