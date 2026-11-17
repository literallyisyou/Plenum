package com.literallyisyou.plenum.unifiedpush

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONException
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Closed-app notifications for the desktop's events (MOBILE-UI section 10). The payload is the desktop's own JSON,
 * built by lib/remote/push.mjs: { v, kind, title, body, tag, tap, actions: [{ action, title, route }], ids, firstLine?, group?,
 * silent? }, or { v, kind: "clear", tag } to take one down. Only the generic title and body are shown. A tap, Deny or Approve opens
 * Plenum at the route, and the shell does the action. Only Approve has setAuthenticationRequired(true), so the device asks for
 * its unlock first; Deny does not ask for it itself (it passes the shell's own lock rules), but it opens Plenum's activity, so
 * Android asks for the unlock before it opens Plenum from the lock screen.
 * Wave 6 (k3): Stop all is a broadcast to StopReceiver when the phone holds that computer's Stop card (StopCards): it is sent from
 * here, with no unlock and no app screen, and this notification then says Stopping…, Stopped or Could not reach (showStop). Without a
 * card (a computer that never gave this phone a Stop key, or an app whose shell has not handed the cards over yet) Stop opens Plenum
 * at #stop as before.
 *
 * The rules here mirror mobile/plugins/unifiedpush/src/core.js (parsePushPayload, routeForAction, tapRouteFor, channelForKind,
 * NOTIFICATION_CHANNEL_LIST); mobile/test/plugins.test.mjs pins the two to each other.
 */
internal object PlenumNotifier {
    const val CHANNEL_APPROVALS = "plenum-approvals"
    const val CHANNEL_FINISHED = "plenum-finished"
    const val CHANNEL_PROBLEMS = "plenum-problems"
    const val CHANNEL_LIMITS = "plenum-limits"
    val CHANNELS = setOf(CHANNEL_APPROVALS, CHANNEL_FINISHED, CHANNEL_PROBLEMS, CHANNEL_LIMITS)

    const val KIND_CLEAR = "clear"
    const val FALLBACK_TAG = "plenum"

    private const val NOTIFICATION_ID = 1
    private const val SUMMARY_ID = 2
    private const val SUMMARY_TAG_PREFIX = "plenum-summary:"
    private const val MAX_ACTIONS = 3
    private const val GROUP_MAX = 64

    // The push lifetime (lib/remote/push.mjs PUSH_TTL_S; core.js APPROVAL_TIMEOUT_MS): an approval takes itself down after it,
    // a backstop for a 'clear' that never arrived.
    private const val APPROVAL_TIMEOUT_MS = 3600L * 1000L
    private val KINDS = setOf("approval", "handover", "finished", "failed", "limit", "needs", "test", "clear")
    private val ACTIONS = setOf("deny", "stop", "approve")
    private val TAG_PATTERN = Regex("^plenum-[0-9a-f]{32}$")
    private val CANCEL_TAG_PATTERN = Regex("^plenum(-[0-9a-f]{32})?$")
    private val COMPUTER_PATTERN = Regex("^[0-9a-f]{64}$")

    // The routes the computer names, as core.js ROUTE_RE: the same expression, character for character.
    private val ROUTE_PATTERN = Regex(
        "^/#(?:home|stop|waiting|chat|today|accounts|services|night-shift|settings=limit|(?:waiting|handover|chat|today|deny|approve)=[A-Za-z0-9_.-]{1,80})(?:&nt=plenum-[0-9a-f]{32})?(?:&computer=[0-9a-f]{64})?$",
    )
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

    internal class RouteAction(val action: String, val title: String, val route: String)

    internal class Payload(
        val kind: String,
        val title: String,
        val body: String,
        val tag: String,
        val tap: String,
        val actions: List<RouteAction>,
        val firstLine: String?,
        val group: String?,
        val silent: Boolean,
        val computer: String?,
    )

    /**
     * Creates the four channels, with their descriptions and lock-screen visibility PRIVATE (the lock screen shows that Plenum has a
     * notification, not its words). Called when the plugin loads, so a fresh install lists them in Android's settings before the
     * first push, and again before each notification. Safe to call often: Android keeps the person's own choices for a channel.
     */
    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = listOf(
            channel(context, CHANNEL_APPROVALS, R.string.plenum_channel_approvals, R.string.plenum_channel_approvals_desc, NotificationManager.IMPORTANCE_HIGH),
            channel(context, CHANNEL_FINISHED, R.string.plenum_channel_finished, R.string.plenum_channel_finished_desc, NotificationManager.IMPORTANCE_DEFAULT),
            channel(context, CHANNEL_PROBLEMS, R.string.plenum_channel_problems, R.string.plenum_channel_problems_desc, NotificationManager.IMPORTANCE_DEFAULT),
            channel(context, CHANNEL_LIMITS, R.string.plenum_channel_limits, R.string.plenum_channel_limits_desc, NotificationManager.IMPORTANCE_DEFAULT),
        )
        for (one in channels) manager.createNotificationChannel(one)
    }

    private fun channel(context: Context, id: String, name: Int, description: Int, importance: Int): NotificationChannel {
        val made = NotificationChannel(id, context.getString(name), importance)
        made.description = context.getString(description)
        made.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        return made
    }

    fun channelFor(kind: String): String =
        when (kind) {
            "approval", "handover", "needs" -> CHANNEL_APPROVALS
            "failed" -> CHANNEL_PROBLEMS
            "limit" -> CHANNEL_LIMITS
            else -> CHANNEL_FINISHED
        }

    /** A tag cancel({ tag }) takes: a computer's tag, or the fallback tag "plenum". */
    fun isCancelTag(tag: String): Boolean = CANCEL_TAG_PATTERN.matches(tag)

    /** Parses a decrypted payload. Returns null for anything that is not a version 1 Plenum payload, and for a clear without a valid tag. */
    fun parse(content: ByteArray): Payload? {
        val text = String(content, Charsets.UTF_8)
        val json = try {
            JSONObject(text)
        } catch (e: JSONException) {
            return null
        }
        if (json.optInt("v", 0) != 1) return null
        val kind = json.optString("kind")
        if (kind !in KINDS) return null
        val ids = json.optJSONObject("ids")
        val computer = (ids?.opt("computer") as? String)?.takeIf { COMPUTER_PATTERN.matches(it) }
        val tag = json.optString("tag")
        if (kind == KIND_CLEAR) {
            // A clear names the notification to take down and nothing else; without a valid tag it is ignored.
            if (!TAG_PATTERN.matches(tag)) return null
            return Payload(KIND_CLEAR, "", "", tag, "/#home", emptyList(), null, null, true, computer)
        }
        val actions = mutableListOf<RouteAction>()
        val list = json.optJSONArray("actions")
        if (list != null) {
            // The first three valid actions count, as in core.js parsePushPayload.
            for (i in 0 until list.length()) {
                if (actions.size >= MAX_ACTIONS) break
                val entry = list.optJSONObject(i) ?: continue
                val name = entry.optString("action")
                val route = entry.optString("route")
                if (name in ACTIONS && ROUTE_PATTERN.matches(route)) {
                    actions.add(RouteAction(name, clean(entry.optString("title"), 40).ifEmpty { name }, route))
                }
            }
        }
        val tap = json.optString("tap")
        // group: text of at most 64 characters (core.js GROUP_MAX); longer, empty or not text means no group.
        val group = (json.opt("group") as? String)?.takeIf { it.length <= GROUP_MAX }?.let { clean(it, GROUP_MAX) }?.ifEmpty { null }
        return Payload(
            kind = kind,
            title = clean(json.optString("title"), 120).ifEmpty { "Plenum" },
            body = clean(json.optString("body"), 240).ifEmpty { "Plenum has an update." },
            tag = if (TAG_PATTERN.matches(tag)) tag else FALLBACK_TAG,
            tap = if (ROUTE_PATTERN.matches(tap)) tap else "/#home",
            actions = actions,
            firstLine = clean(json.optString("firstLine"), 200).ifEmpty { null },
            group = group,
            silent = (json.opt("silent") as? Boolean) == true,
            computer = computer,
        )
    }

    /**
     * Shows the closed-app notification for one payload. Returns false when nothing was shown: a clear, or notifications are not
     * allowed at this moment.
     */
    fun show(context: Context, payload: Payload): Boolean {
        if (payload.kind == KIND_CLEAR) return false
        ensureChannels(context)
        val urgent = payload.kind == "approval" || payload.kind == "handover"
        val channelId = channelFor(payload.kind)
        // No group from the computer: the tag is the group, so each notification stands alone as before.
        val group = payload.group ?: payload.tag
        val active = activeNotifications(context)
        // A Stop's notification under this tag (any state) is not an earlier version of this one: a new approval after a Stop still alerts.
        val updating = active.any { it.id == NOTIFICATION_ID && it.tag == payload.tag && !isStopShowing(it) }
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_plenum)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setGroup(group)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setContentIntent(intentFor(context, tapFor(payload)))
        // A newer version of a notification that is showing (the same tag) replaces it without a second sound.
        if (updating) builder.setOnlyAlertOnce(true)
        if (payload.silent) builder.setSilent(true)
        if (payload.kind == "approval") builder.setTimeoutAfter(APPROVAL_TIMEOUT_MS)
        for (action in payload.actions) {
            val route = routeFor(action, payload.firstLine, payload.tag, payload.computer)
            // Wave 6 (k3): Stop is sent natively (a broadcast to StopReceiver) when this phone holds the computer's Stop card. On a locked
            // phone Android asks for the unlock before it opens an activity from an action button, whatever the activity's lock-screen
            // settings, but not before it delivers a broadcast, so this Stop needs no unlock. Without a card it opens Plenum at the
            // route (intentFor), and then Stop from the lock screen still needs the phone's unlock (then no Plenum PIN).
            val stopFor = if (action.action == "stop") stopComputer(context, payload.computer) else null
            val actionIntent = if (stopFor != null) StopReceiver.pendingFor(context, payload.tag, stopFor) else intentFor(context, route)
            builder.addAction(
                NotificationCompat.Action.Builder(null, action.title, actionIntent)
                    // Only Approve asks for the device's unlock itself. Stop and Deny do not (Deny passes the shell's own lock rules).
                    .setAuthenticationRequired(action.action == "approve")
                    .build(),
            )
        }
        val manager = NotificationManagerCompat.from(context)
        // Blocked in Android's settings: Android would drop it without a word, so it does not count as shown.
        if (!manager.areNotificationsEnabled()) return false
        try {
            manager.notify(payload.tag, NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            // Notifications were refused at this moment. The shell asks for them again after a tap.
            return false
        }
        // The others of this group that are showing, and this one (the list was read before it was posted).
        val others = active.count { isChild(it) && it.notification.group == group && it.tag != payload.tag }
        refreshSummary(context, group, channelId, payload.title, others + 1)
        return true
    }

    /**
     * Takes down the notification of one tag, and its group's summary when fewer than two are left. Returns how many were taken down.
     * A Stop's own notification (Stopping…, Stopped, Could not reach, not accepted: all marked EXTRA_STOP_SHOWING) stays: a Stop
     * denies the waiting cards, so the computer sends a 'clear' for that very tag (the service's and the shell's clear both come here)
     * a moment later, and the confirmation must not go with it. A Stop that did not get through stays too: the card is still waiting
     * on the computer, and its later 'clear' (it expired, or was answered at the desk) must not take away the only sign that the run
     * goes on. Stopping… is replaced by the outcome; Stopped goes after STOPPED_TIMEOUT_MS, Could not reach and not accepted after
     * STOP_FAILED_TIMEOUT_MS, and each on a tap, a swipe, or a new notification for the tag (show replaces it, and it alerts).
     */
    fun cancelTag(context: Context, tag: String): Int {
        val active = activeNotifications(context)
        val gone = active.filter { isChild(it) && it.tag == tag }
        if (gone.any { isStopShowing(it) }) return 0
        NotificationManagerCompat.from(context).cancel(tag, NOTIFICATION_ID)
        val removed = setOf(tag)
        for (group in gone.mapNotNull { it.notification.group }.toSet()) settleGroup(context, active, group, removed)
        return gone.size
    }

    /**
     * Takes down every notification that is showing on Plenum's push channels (the service's and the shell's local ones), or only
     * those on one channel. Returns the tags of the service's notifications that went.
     */
    fun cancelAll(context: Context, channel: String?): List<String> {
        val active = activeNotifications(context)
        val manager = NotificationManagerCompat.from(context)
        val tags = mutableListOf<String>()
        val groups = mutableSetOf<String>()
        for (one in active) {
            val on = one.notification.channelId ?: continue
            if (on !in CHANNELS) continue
            if (channel != null && on != channel) continue
            manager.cancel(one.tag, one.id)
            if (isChild(one)) {
                one.tag?.let { tags.add(it) }
                one.notification.group?.let { groups.add(it) }
            }
        }
        for (group in groups) settleGroup(context, active, group, tags.toSet())
        return tags
    }

    // After children of a group were taken down: the summary goes when fewer than two are left, else it shows the new count.
    private fun settleGroup(context: Context, active: List<StatusBarNotification>, group: String, removed: Set<String>) {
        val left = active.filter { isChild(it) && it.notification.group == group && it.tag !in removed }
        val summary = active.firstOrNull { !isChild(it) && it.id == SUMMARY_ID && it.tag == SUMMARY_TAG_PREFIX + group }
        if (left.size >= 2 && summary == null) return
        val title = summary?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val channelId = left.firstOrNull()?.notification?.channelId ?: CHANNEL_FINISHED
        refreshSummary(context, group, channelId, title, left.size)
    }

    // A group of two or more gets one summary line (Android stacks the group under it); a group of one or none has no summary.
    // The summary never sounds: the newest child alerts, as its channel says.
    private fun refreshSummary(context: Context, group: String, channelId: String, title: String?, count: Int) {
        val manager = NotificationManagerCompat.from(context)
        val tag = SUMMARY_TAG_PREFIX + group
        if (count < 2) {
            manager.cancel(tag, SUMMARY_ID)
            return
        }
        val text = context.getString(R.string.plenum_group_summary, count)
        val summary = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_plenum)
            .setContentTitle(title ?: context.getString(R.string.plenum_group_title))
            .setContentText(text)
            .setStyle(NotificationCompat.InboxStyle().setSummaryText(text))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(group)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(intentFor(context, "/#home"))
        try {
            manager.notify(tag, SUMMARY_ID, summary.build())
        } catch (e: SecurityException) {
            // Notifications were refused at this moment; the children were not shown either.
        }
    }

    // ----- Stop sent from the notification (wave 6, k3) -----

    enum class StopState { STOPPING, STOPPED, FAILED, NOT_ACCEPTED }

    /** Where a notification sits: its channel and its group, so the Stop's updates replace it in place. */
    class Place(val channelId: String, val group: String)

    // "Stopping…" stays at most this long if the Stop never reports back (the process was ended); "Stopped" clears itself after this.
    private const val STOPPING_TIMEOUT_MS = 60L * 1000L
    private const val STOPPED_TIMEOUT_MS = 5L * 60L * 1000L
    // "Could not reach" and not accepted stay this long at most (a 'clear' does not take them down): the push lifetime, as an approval.
    private const val STOP_FAILED_TIMEOUT_MS = APPROVAL_TIMEOUT_MS

    // The extra (true) on every notification showStop posts: cancelTag leaves them up (see there).
    private const val EXTRA_STOP_SHOWING = "com.literallyisyou.plenum.unifiedpush.STOP_SHOWING"

    /**
     * The computer a notification's Stop goes to natively: the computer that sent it, when this phone holds its Stop card, or, for a
     * notification that does not name its computer (an older computer), the only computer with a card. Null: Stop opens Plenum.
     */
    fun stopComputer(context: Context, computer: String?): String? {
        val ids = try {
            StopCards.ids(context)
        } catch (e: RuntimeException) {
            emptySet()
        }
        if (computer != null) return computer.takeIf { it in ids }
        return ids.singleOrNull()
    }

    /** The channel and group of the notification with this tag, or the approvals channel and the tag itself when it is not showing. */
    fun placeOf(context: Context, tag: String): Place {
        val one = activeNotifications(context).firstOrNull { isChild(it) && it.tag == tag }
        val channelId = one?.notification?.channelId?.takeIf { it in CHANNELS } ?: CHANNEL_APPROVALS
        return Place(channelId, one?.notification?.group ?: tag)
    }

    /**
     * Replaces the notification of this tag with where its Stop is: Stopping…, Stopped (with what was stopped), Could not reach (with
     * Try again, and a tap that opens Plenum at #stop for that computer), or not accepted. One notification, the same tag and group.
     * The lock screen shows the plain public version (the channel hides the words there), without the computer's name.
     */
    fun showStop(context: Context, tag: String, computer: String, where: Place, state: StopState, computerName: String, counts: LongArray?) {
        ensureChannels(context)
        val name = computerName.ifEmpty { context.getString(R.string.plenum_stop_your_computer) }
        val title: String
        val text: String
        val publicText: String
        when (state) {
            StopState.STOPPING -> {
                title = context.getString(R.string.plenum_stop_stopping)
                text = context.getString(R.string.plenum_stop_stopping_text, name)
                publicText = context.getString(R.string.plenum_stop_stopping_public)
            }
            StopState.STOPPED -> {
                title = context.getString(R.string.plenum_stop_stopped)
                text = StopSender.resultText(counts, name)
                publicText = context.getString(R.string.plenum_stop_stopped_public)
            }
            StopState.FAILED -> {
                title = context.getString(R.string.plenum_stop_failed)
                text = context.getString(R.string.plenum_stop_failed_text, name)
                publicText = context.getString(R.string.plenum_stop_failed_public)
            }
            StopState.NOT_ACCEPTED -> {
                title = context.getString(R.string.plenum_stop_failed)
                text = context.getString(R.string.plenum_stop_not_accepted_text, name)
                publicText = context.getString(R.string.plenum_stop_failed_public)
            }
        }
        val public = NotificationCompat.Builder(context, where.channelId)
            .setSmallIcon(R.drawable.ic_stat_plenum)
            .setContentTitle(title)
            .setContentText(publicText)
            .build()
        val builder = NotificationCompat.Builder(context, where.channelId)
            .setSmallIcon(R.drawable.ic_stat_plenum)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setGroup(where.group)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
        val nt = if (TAG_PATTERN.matches(tag)) "&nt=$tag" else ""
        // A 'clear' for this tag leaves every state up (cancelTag): the one the Stop itself causes, and, after a Stop that did not get
        // through, the one that comes when the still-waiting card expires or is answered at the desk.
        builder.addExtras(Bundle().apply { putBoolean(EXTRA_STOP_SHOWING, true) })
        when (state) {
            StopState.STOPPING -> builder
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setProgress(0, 0, true)
                .setTimeoutAfter(STOPPING_TIMEOUT_MS)
            StopState.STOPPED -> builder
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setTimeoutAfter(STOPPED_TIMEOUT_MS)
                .setContentIntent(intentFor(context, "/#home&computer=$computer"))
            // A Stop that did not get through alerts once: the person may have put the phone down.
            StopState.FAILED -> builder
                .setAutoCancel(true)
                .setTimeoutAfter(STOP_FAILED_TIMEOUT_MS)
                .setContentIntent(intentFor(context, "/#stop$nt&computer=$computer"))
                .addAction(NotificationCompat.Action.Builder(null, context.getString(R.string.plenum_stop_again), StopReceiver.pendingFor(context, tag, computer)).build())
            StopState.NOT_ACCEPTED -> builder
                .setAutoCancel(true)
                .setTimeoutAfter(STOP_FAILED_TIMEOUT_MS)
                .setContentIntent(intentFor(context, "/#stop$nt&computer=$computer"))
        }
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(tag, NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            // Notifications were refused at this moment; the Stop itself is not affected.
        }
    }

    // Plenum's own notifications that are showing now (an empty list when Android does not say).
    private fun activeNotifications(context: Context): List<StatusBarNotification> {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return emptyList()
        return try {
            manager.activeNotifications?.toList() ?: emptyList()
        } catch (e: RuntimeException) {
            emptyList()
        }
    }

    // A notification of one payload (id NOTIFICATION_ID), not a group summary and not another plugin's notification.
    private fun isChild(one: StatusBarNotification): Boolean =
        one.id == NOTIFICATION_ID && (one.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0

    // A Stop's own notification, in any of its states (showStop marks them all).
    private fun isStopShowing(one: StatusBarNotification): Boolean =
        one.notification.extras?.getBoolean(EXTRA_STOP_SHOWING, false) == true

    // An approve route carries the first line the notification showed (core.js routeForAction). Every action route then ends in
    // '&nt=<tag>' (the shell takes this notification down after acting) and '&computer=<64 hex>' (the computer that sent it).
    private fun routeFor(action: RouteAction, firstLine: String?, tag: String, computer: String?): String {
        var route = if (action.action == "approve" && firstLine != null) {
            action.route + "&line=" + URLEncoder.encode(firstLine, "UTF-8").replace("+", "%20")
        } else {
            action.route
        }
        if (TAG_PATTERN.matches(tag)) route += "&nt=" + tag
        if (computer != null) route += "&computer=" + computer
        return route
    }

    // The tap route plus '&computer=<64 hex>' when the payload named its computer (core.js tapRouteFor).
    private fun tapFor(payload: Payload): String =
        if (payload.computer != null) payload.tap + "&computer=" + payload.computer else payload.tap

    // plenum://app plus the route, for example plenum://app/#deny=<id>. The app's manifest filter for the plenum scheme
    // receives it; Capacitor's App plugin passes it to the shell as appUrlOpen. The route names the notification's tag and computer,
    // so each notification has its own PendingIntent.
    private fun intentFor(context: Context, route: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("plenum://app$route"))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context,
            route.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun clean(value: String, max: Int): String = value.replace(CONTROL, " ").trim().take(max)
}
