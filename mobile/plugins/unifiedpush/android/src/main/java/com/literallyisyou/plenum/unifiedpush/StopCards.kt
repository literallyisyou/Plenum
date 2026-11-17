package com.literallyisyou.plenum.unifiedpush

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone's native copy of what Stop without unlocking needs, one card per computer (wave 6, k3): the computer's id and name, this
 * phone's id there, the Stop key, and the ways (carrier addresses). The shell hands the cards over each time it writes its computers
 * (pairing, a new Stop key, new ways, Forget), through UnifiedPushPlugin.setStopCards, so a computer that is forgotten loses its card.
 * No other key is ever here: not the phone's private key, not the push key. The Stop key can only stop runs on that computer and deny
 * the cards they wait on (lib/remote/stop-only.mjs), the same thing the lock screen's Stop does.
 *
 * Kept in the app's private storage, encrypted with an AES-256-GCM key from the Android Keystore (the shell's own keys are in the
 * Keystore too, through the secure-storage plugin). The Keystore key needs no unlock, so a Stop works on a locked phone (after the first
 * unlock since the phone started). If the Keystore cannot be used, nothing is stored and Stop opens Plenum as before.
 * The counter (the handshake counter this phone last used with that computer) is not secret and is kept in the clear beside the cards:
 * it only rises, and the shell reads it back before its next handshake (mobile/shell/native.js). Nothing in this file logs.
 */
internal object StopCards {
    private const val PREFS = "plenum-stop-cards"
    private const val KEY_CARDS = "cards"
    private const val KEY_IDS = "ids"
    private const val COUNTER_PREFIX = "ctr:"
    private const val KEY_ALIAS = "plenum-stop-cards"
    private const val MAX_CARDS = 16
    private const val MAX_SAFE = 9007199254740991L
    private val ID = Regex("^[0-9a-f]{64}$")
    private val KINDS = setOf("lan", "tailscale", "relay")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
    private val lock = Any()

    class Card(
        val id: String,
        val name: String,
        val deviceId: String,
        val stopKey: ByteArray,
        val ways: List<StopSender.Way>,
        val lastCarrier: String?,
        val lastUrl: String?,
        val counter: Long,
    )

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** One card from the shell's JSON (core.js stopCardFromRecord), or null when anything in it is not as it must be. */
    fun fromJson(json: JSONObject?): Card? {
        if (json == null) return null
        val id = json.optString("id")
        val deviceId = json.optString("deviceId")
        if (!ID.matches(id) || !ID.matches(deviceId)) return null
        val key = StopSender.fromB64u(json.optString("stopKey")) ?: return null
        if (key.size != 32) return null
        val ways = mutableListOf<StopSender.Way>()
        val list = json.optJSONArray("ways") ?: JSONArray()
        for (i in 0 until list.length()) {
            val one = list.optJSONObject(i) ?: continue
            val kind = one.optString("kind")
            val url = one.optString("url")
            if (kind in KINDS && StopSender.carrierUrlOk(kind, url) && ways.size < StopSender.MAX_WAYS) ways.add(StopSender.Way(kind, url))
        }
        if (ways.isEmpty()) return null
        val lastCarrier = json.optString("lastCarrier").takeIf { it in KINDS }
        val lastUrl = json.optString("lastUrl").takeIf { url -> ways.any { it.url == url } }
        val counter = json.optLong("counter", 0L).coerceIn(0L, MAX_SAFE)
        val name = json.optString("name").replace(CONTROL, " ").trim().take(60)
        return Card(id, name, deviceId, key, ways, lastCarrier, lastUrl, counter)
    }

    private fun toJson(card: Card): JSONObject {
        val ways = JSONArray()
        for (w in card.ways) ways.put(JSONObject().put("kind", w.kind).put("url", w.url))
        val out = JSONObject()
            .put("id", card.id)
            .put("name", card.name)
            .put("deviceId", card.deviceId)
            .put("stopKey", Base64.encodeToString(card.stopKey, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
            .put("ways", ways)
            .put("counter", card.counter)
        card.lastCarrier?.let { out.put("lastCarrier", it) }
        card.lastUrl?.let { out.put("lastUrl", it) }
        return out
    }

    /**
     * Replaces every card with these (the shell's computers that hold a Stop key). A computer that is not in the list is forgotten:
     * its card and its counter go. Returns how many cards are kept, or -1 when they could not be stored (nothing is kept then).
     */
    fun replace(context: Context, cards: List<Card>): Int = synchronized(lock) {
        val keep = cards.distinctBy { it.id }.take(MAX_CARDS)
        val editor = prefs(context).edit()
        val gone = ids(context) - keep.map { it.id }.toSet()
        for (id in gone) editor.remove(COUNTER_PREFIX + id)
        if (keep.isEmpty()) {
            editor.remove(KEY_CARDS).remove(KEY_IDS).commit()
            return 0
        }
        val blob = try {
            val list = JSONArray()
            for (card in keep) list.put(toJson(card))
            seal(list.toString().toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            null
        }
        if (blob == null) {
            editor.remove(KEY_CARDS).remove(KEY_IDS).commit()
            return -1
        }
        editor.putString(KEY_CARDS, blob).putStringSet(KEY_IDS, keep.map { it.id }.toSet())
        // A card's counter never falls: the higher of what is kept and what the shell says.
        val p = prefs(context)
        for (card in keep) {
            if (card.counter > p.getLong(COUNTER_PREFIX + card.id, 0L)) editor.putLong(COUNTER_PREFIX + card.id, card.counter)
        }
        editor.commit()
        keep.size
    }

    /** The ids of the computers with a card (no decryption: the ids are in every push the computer sends anyway). */
    fun ids(context: Context): Set<String> = prefs(context).getStringSet(KEY_IDS, emptySet()).orEmpty().toSet()

    fun has(context: Context, id: String?): Boolean = id != null && id in ids(context)

    /** Every card, decrypted, or an empty list when there are none or they cannot be read. */
    fun all(context: Context): List<Card> = synchronized(lock) {
        val blob = prefs(context).getString(KEY_CARDS, null) ?: return emptyList()
        return try {
            val list = JSONArray(String(open(blob), Charsets.UTF_8))
            (0 until list.length()).mapNotNull { fromJson(list.optJSONObject(it)) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun get(context: Context, id: String): Card? = all(context).firstOrNull { it.id == id }

    /** The counter of each computer with a card: the highest this phone used or heard of (never a key). */
    fun counters(context: Context): Map<String, Long> {
        val p = prefs(context)
        return ids(context).associateWith { p.getLong(COUNTER_PREFIX + it, 0L) }
    }

    /** The shell raised its handshake counter for this computer: keep the higher one. */
    fun note(context: Context, id: String, counter: Long) {
        synchronized(lock) {
            if (!has(context, id) || counter < 0 || counter > MAX_SAFE) return
            val p = prefs(context)
            if (counter > p.getLong(COUNTER_PREFIX + id, 0L)) p.edit().putLong(COUNTER_PREFIX + id, counter).commit()
        }
    }

    /**
     * The counter for the next Stop: above every one used before (the stored one and the card's) and at least `atLeast`. It is written
     * to disk (commit) before it is answered, so it is never sent twice, as the shell's store does before a handshake.
     */
    fun raise(context: Context, card: Card, atLeast: Long): Long = synchronized(lock) {
        val p = prefs(context)
        val current = maxOf(p.getLong(COUNTER_PREFIX + card.id, 0L), card.counter)
        val next = maxOf(current + 1, atLeast)
        if (next > MAX_SAFE) throw IllegalStateException("counter out of range")
        if (!p.edit().putLong(COUNTER_PREFIX + card.id, next).commit()) throw IllegalStateException("counter not saved")
        next
    }

    // ----- the Keystore key -----

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No user authentication: the Stop must work while the phone is locked.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val sealed = cipher.doFinal(plain)
        plain.fill(0)
        return Base64.encodeToString(iv + sealed, Base64.NO_WRAP)
    }

    private fun open(blob: String): ByteArray {
        val bytes = Base64.decode(blob, Base64.NO_WRAP)
        if (bytes.size < 12 + 16) throw IllegalStateException("short")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        return cipher.doFinal(bytes, 12, bytes.size - 12)
    }
}
