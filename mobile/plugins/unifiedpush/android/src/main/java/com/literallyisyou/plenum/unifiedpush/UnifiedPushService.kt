package com.literallyisyou.plenum.unifiedpush

import android.util.Base64
import com.getcapacitor.JSObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Receives the distributor's events: the endpoint, messages, failures and unregistrations. Declared in the plugin's
 * manifest with the connector's PUSH_EVENT action and not exported. It runs only when a distributor delivers, so there
 * is no socket and no foreground service.
 *
 * A message reaches the shell as an event whenever the bridge is alive. When Plenum is not in front, the service also
 * shows the closed-app notification itself and says so on the event (shown: true), so the shell does not add a second one,
 * including when the event is kept and handed to the shell later. There is no guard that skips a message because an earlier one
 * had the same words: the computer's tags and words repeat, and a later one must still be shown. A 'clear' takes down the notification of its tag whether or
 * not Plenum is in front; it is passed on with clear: true and is never shown.
 */
class UnifiedPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        UnifiedPushStore.saveEndpoint(this, instance, endpoint.url, endpoint.temporary)
        val data = JSObject()
        data.put("instance", instance)
        data.put("url", endpoint.url)
        data.put("temporary", endpoint.temporary)
        endpoint.pubKeySet?.let { keys ->
            val pair = JSObject()
            pair.put("pubKey", keys.pubKey)
            pair.put("auth", keys.auth)
            data.put("pubKeySet", pair)
        }
        // With Plenum closed nobody hears the event, and the computer would keep pushing to the old address: the flag tells the shell,
        // at its next start (getState), to register again so the new address and its keys reach the computer.
        val delivered = UnifiedPushPlugin.deliver("endpoint", data, retain = true)
        UnifiedPushStore.setEndpointChanged(this, !delivered)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val payload = if (message.decrypted) PlenumNotifier.parse(message.content) else null
        val data = JSObject()
        data.put("instance", instance)
        data.put("content", Base64.encodeToString(message.content, Base64.NO_WRAP))
        data.put("decrypted", message.decrypted)
        if (payload != null && payload.kind == PlenumNotifier.KIND_CLEAR) {
            // Before any check of what is in front: the notification goes whether or not Plenum is open, and nothing is shown.
            PlenumNotifier.cancelTag(this, payload.tag)
            data.put("clear", true)
            data.put("shown", false)
            UnifiedPushPlugin.deliver("message", data, retain = false)
            return
        }
        // Every message is shown when Plenum is not in front, even one with the same words as an earlier one: the computer's tags and
        // words repeat (a second test, two finished runs of one project), and a second one must still arrive. A true re-delivery only
        // replaces the notification of its tag, and setOnlyAlertOnce keeps that quiet while the first is still showing.
        val shown = payload != null && !UnifiedPushStore.visible && PlenumNotifier.show(this, payload)
        data.put("shown", shown)
        UnifiedPushPlugin.deliver("message", data, retain = true)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        UnifiedPushStore.saveFailure(this, instance, reason.name)
        val data = JSObject()
        data.put("instance", instance)
        data.put("reason", reason.name)
        UnifiedPushPlugin.deliver("registrationFailed", data, retain = true)
    }

    override fun onUnregistered(instance: String) {
        UnifiedPushStore.removeEndpoint(this, instance)
        UnifiedPushStore.setEndpointChanged(this, false)
        val data = JSObject()
        data.put("instance", instance)
        UnifiedPushPlugin.deliver("unregistered", data, retain = true)
    }

    override fun onTempUnavailable(instance: String) {
        val data = JSObject()
        data.put("instance", instance)
        UnifiedPushPlugin.deliver("tempUnavailable", data, retain = false)
    }
}
