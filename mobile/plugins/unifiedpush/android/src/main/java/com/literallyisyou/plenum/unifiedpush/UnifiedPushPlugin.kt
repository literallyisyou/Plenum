package com.literallyisyou.plenum.unifiedpush

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import java.lang.ref.WeakReference

/**
 * The shell's view of UnifiedPush: choose a distributor, register and unregister registration names, read the state
 * and receive events (endpoint, message, registrationFailed, unregistered, tempUnavailable). Events are sent from
 * UnifiedPushService and only while the bridge is alive; the state is kept in UnifiedPushStore for the next start.
 *
 * Methods take and return the shapes in mobile/plugins/unifiedpush/src/index.d.ts.
 */
@CapacitorPlugin(
    name = "UnifiedPush",
    permissions = [Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications")],
)
class UnifiedPushPlugin : Plugin() {

    override fun load() {
        live = WeakReference(this)
        // The four channels exist from the first start, so the person can tune them before the first push arrives.
        PlenumNotifier.ensureChannels(context)
    }

    override fun handleOnStart() {
        UnifiedPushStore.visible = true
    }

    override fun handleOnStop() {
        UnifiedPushStore.visible = false
    }

    override fun handleOnDestroy() {
        if (live?.get() === this) live = null
    }

    /** Sends one event to the shell. Called on the UI thread. */
    fun emit(event: String, data: JSObject, retain: Boolean) {
        notifyListeners(event, data, retain)
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val ctx = context
        val out = JSObject()
        out.put("supported", true)
        out.put("distributor", UnifiedPush.getSavedDistributor(ctx) ?: JSONObject.NULL)
        out.put("endpoints", UnifiedPushStore.endpoints(ctx))
        out.put("failures", UnifiedPushStore.failures(ctx))
        out.put("registrations", JSONArray(UnifiedPushStore.registrations(ctx)))
        out.put("visible", UnifiedPushStore.visible)
        out.put("endpointChanged", UnifiedPushStore.endpointChanged(ctx))
        call.resolve(out)
    }

    /** Takes down the notification of one tag (the shell does this after it acted on a notification's action). */
    @PluginMethod
    fun cancel(call: PluginCall) {
        val tag = call.getString("tag")
        if (tag == null || !PlenumNotifier.isCancelTag(tag)) {
            call.reject("That is not a Plenum notification tag.", "bad-tag")
            return
        }
        val count = PlenumNotifier.cancelTag(context, tag)
        val out = JSObject()
        out.put("cancelled", count)
        call.resolve(out)
    }

    /** Takes down the notifications on Plenum's channels that are showing, or only those on one channel. */
    @PluginMethod
    fun cancelAll(call: PluginCall) {
        val channel = call.getString("channel")?.takeIf { it.isNotEmpty() }
        if (channel != null && channel !in PlenumNotifier.CHANNELS) {
            call.reject("That is not one of Plenum's notification channels.", "bad-channel")
            return
        }
        val tags = PlenumNotifier.cancelAll(context, channel)
        val out = JSObject()
        out.put("cancelled", tags.size)
        call.resolve(out)
    }

    /**
     * Wave 6 (k3): the Stop cards (mobile/shell/native.js hands them over each time the shell writes its computers). Replaces them all;
     * a computer that is not in the list is forgotten. Each card holds only what a Stop-only message needs (StopCards).
     */
    @PluginMethod
    fun setStopCards(call: PluginCall) {
        val list = call.getArray("cards")
        if (list == null) {
            call.reject("Give the Stop cards as a list.", "bad-cards")
            return
        }
        val cards = (0 until list.length()).mapNotNull { StopCards.fromJson(list.optJSONObject(it)) }
        val kept = StopCards.replace(context, cards)
        val out = JSObject()
        out.put("count", maxOf(kept, 0))
        out.put("stored", kept >= 0)
        call.resolve(out)
    }

    /** Wave 6 (k3): the shell raised its handshake counter for one computer; the native Stop goes above it. */
    @PluginMethod
    fun noteStopCounter(call: PluginCall) {
        val computer = call.getString("computer")
        val counter = call.getData().optLong("counter", -1L)
        if (computer == null || !STOP_COMPUTER_PATTERN.matches(computer) || counter < 0) {
            call.reject("Name the computer and its counter.", "bad-counter")
            return
        }
        StopCards.note(context, computer, counter)
        call.resolve()
    }

    /** Wave 6 (k3): the counter each computer with a card is at (a native Stop may have raised it); the shell starts above it. No key. */
    @PluginMethod
    fun stopCounters(call: PluginCall) {
        val counters = JSObject()
        for ((id, value) in StopCards.counters(context)) counters.put(id, value)
        val out = JSObject()
        out.put("counters", counters)
        call.resolve(out)
    }

    /**
     * Wave 6 (k3): shows a push message as the plugin's own notification while Plenum is in front (the shell calls it for an approval,
     * a handover or a test), so it has the same channels and grouping as one shown with Plenum closed, and a Stop that needs no unlock.
     */
    @PluginMethod
    fun showNotification(call: PluginCall) {
        val content = call.getString("content")
        val bytes = try {
            if (content == null || content.length > MAX_CONTENT) null else android.util.Base64.decode(content, android.util.Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
        val payload = bytes?.let { PlenumNotifier.parse(it) }
        val out = JSObject()
        out.put("shown", payload != null && PlenumNotifier.show(context, payload))
        call.resolve(out)
    }

    @PluginMethod
    fun getDistributors(call: PluginCall) {
        val ctx = context
        val out = JSObject()
        out.put("distributors", JSONArray(UnifiedPush.getDistributors(ctx).filter { it != ctx.packageName }))
        out.put("saved", UnifiedPush.getSavedDistributor(ctx) ?: JSONObject.NULL)
        call.resolve(out)
    }

    @PluginMethod
    fun chooseDistributor(call: PluginCall) {
        val packageName = call.getString("packageName")
        if (packageName == null || !PACKAGE_PATTERN.matches(packageName) || packageName == context.packageName) {
            call.reject("Name the push app by its package name, for example io.heckel.ntfy.", "bad-package")
            return
        }
        UnifiedPush.saveDistributor(context, packageName)
        val out = JSObject()
        out.put("saved", packageName)
        call.resolve(out)
    }

    @PluginMethod
    fun pickDistributor(call: PluginCall) {
        val current = activity
        if (current == null) {
            call.reject("There is no screen to show the list of push apps.", "no-activity")
            return
        }
        UnifiedPush.tryPickDistributor(current) { ok ->
            val out = JSObject()
            out.put("ok", ok)
            call.resolve(out)
        }
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val ctx = context
        if (UnifiedPush.getSavedDistributor(ctx) == null) {
            call.reject("Install a push app such as ntfy, then choose it.", "no-distributor")
            return
        }
        val instance = call.getString("instance")?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTANCE
        if (!INSTANCE_PATTERN.matches(instance)) {
            call.reject("A registration name is 1 to 64 letters, digits, dots, dashes or underscores.", "bad-instance")
            return
        }
        val label = (call.getString("messageForDistributor") ?: "")
            .replace(CONTROL, " ").trim().take(120).ifEmpty { DEFAULT_LABEL }
        val vapid = call.getString("vapid")?.takeIf { it.isNotEmpty() }
        if (vapid != null && !VAPID_PATTERN.matches(vapid)) {
            call.reject("The VAPID key is the 87-character base64url public key.", "bad-vapid")
            return
        }
        try {
            UnifiedPush.register(ctx, instance, label, vapid)
        } catch (e: UnifiedPush.VapidNotValidException) {
            call.reject("The VAPID key is the 87-character base64url public key.", "bad-vapid")
            return
        }
        UnifiedPushStore.addRegistration(ctx, instance)
        call.resolve()
    }

    @PluginMethod
    fun unregister(call: PluginCall) {
        val ctx = context
        val instance = call.getString("instance")?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTANCE
        if (!INSTANCE_PATTERN.matches(instance)) {
            call.reject("A registration name is 1 to 64 letters, digits, dots, dashes or underscores.", "bad-instance")
            return
        }
        UnifiedPush.unregister(ctx, instance)
        UnifiedPushStore.removeRegistration(ctx, instance)
        UnifiedPushStore.removeEndpoint(ctx, instance)
        call.resolve()
    }

    @PluginMethod
    fun getNotificationPermission(call: PluginCall) {
        resolveGranted(call)
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (notificationsGranted()) {
            resolveGranted(call)
            return
        }
        requestPermissionForAlias(NOTIFICATIONS_ALIAS, call, "notificationPermissionCallback")
    }

    @PermissionCallback
    fun notificationPermissionCallback(call: PluginCall) {
        resolveGranted(call)
    }

    // Before Android 13 there is no runtime permission for notifications.
    private fun notificationsGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState(NOTIFICATIONS_ALIAS) == PermissionState.GRANTED

    private fun resolveGranted(call: PluginCall) {
        val out = JSObject()
        out.put("granted", notificationsGranted())
        call.resolve(out)
    }

    companion object {
        private const val NOTIFICATIONS_ALIAS = "notifications"
        private const val DEFAULT_INSTANCE = "default"
        private const val DEFAULT_LABEL = "Plenum"
        private val INSTANCE_PATTERN = Regex("^[A-Za-z0-9._-]{1,64}$")
        private val VAPID_PATTERN = Regex("^[A-Za-z0-9_-]{87}$")
        private val PACKAGE_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
        private val STOP_COMPUTER_PATTERN = Regex("^[0-9a-f]{64}$")
        private const val MAX_CONTENT = 16384

        @Volatile
        private var live: WeakReference<UnifiedPushPlugin>? = null

        /**
         * Delivers an event from the push service. Does nothing when the bridge is not alive and returns false then; the
         * endpoint, the failures and the endpointChanged flag are also kept in UnifiedPushStore, so the shell reads them with
         * getState() on its next start.
         */
        internal fun deliver(event: String, data: JSObject, retain: Boolean): Boolean {
            val plugin = live?.get() ?: return false
            val screen = plugin.activity ?: return false
            screen.runOnUiThread { plugin.emit(event, data, retain) }
            return true
        }
    }
}
