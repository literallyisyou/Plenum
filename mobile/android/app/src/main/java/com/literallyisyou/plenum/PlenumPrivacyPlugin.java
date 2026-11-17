package com.literallyisyou.plenum;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Hide content in the app switcher" (MOBILE-UI 6.17 and 15.6). While the setting is on, the window is FLAG_SECURE: the
 * app switcher shows no content and screenshots are refused. While it is off, screenshots work. The setting is kept
 * natively, so the flag applies from the first frame (MainActivity), before the shell has loaded.
 *
 * JavaScript: PlenumPrivacy.getHideInSwitcher() -> { enabled }, PlenumPrivacy.setHideInSwitcher({ enabled }) -> { enabled }.
 * The default is on, as the Settings row shows it.
 *
 * Wave 4 (k1) adds, for the shell:
 *   openNotificationSettings()   -> { opened }  Android's notification settings page for Plenum.
 *   markUnlocked()               -> {}          the shell was just unlocked (biometric or PIN): remember when, in memory only.
 *   unlockFresh({ maxAgeMs })    -> { fresh }   true only when that unlock is younger than maxAgeMs, the screen has not turned
 *                                               off since, and the app was not in the background longer than maxAgeMs since.
 *   clearUnlocked()              -> {}          forget it (the shell locked again).
 * The unlock stamp is SystemClock.elapsedRealtime() in a static field: never on disk, gone when the process ends, and not moved
 * by a change of the phone's clock.
 */
@CapacitorPlugin(name = "PlenumPrivacy")
public class PlenumPrivacyPlugin extends Plugin {
    private static final String PREFS = "plenum-privacy";
    private static final String KEY_HIDE = "hideInSwitcher";

    // The unlock stamp and what happened since (elapsedRealtime milliseconds; 0 means none). Guarded by LOCK.
    private static final Object LOCK = new Object();
    private static long unlockedAt = 0L;
    private static long pausedAt = 0L;
    private static long longestAwayMs = 0L;
    private static boolean screenReceiverRegistered = false;

    // The screen turning off ends the unlock, whatever its age. A protected system broadcast, so no export flag is needed.
    private static final BroadcastReceiver SCREEN_OFF = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                forgetUnlock();
            }
        }
    };

    static boolean hideInSwitcher(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_HIDE, true);
    }

    static void applyTo(Window window, boolean hide) {
        if (hide) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    private static void forgetUnlock() {
        synchronized (LOCK) {
            unlockedAt = 0L;
            longestAwayMs = 0L;
        }
    }

    @Override
    public void load() {
        // Registered once per process on the application context, so a recreated activity neither leaks nor doubles it.
        synchronized (LOCK) {
            if (screenReceiverRegistered) return;
            try {
                getContext().getApplicationContext().registerReceiver(SCREEN_OFF, new IntentFilter(Intent.ACTION_SCREEN_OFF));
                screenReceiverRegistered = true;
            } catch (RuntimeException ignored) {
                // Without the receiver no unlock can be trusted: unlockFresh then always answers false.
            }
        }
    }

    @Override
    protected void handleOnPause() {
        synchronized (LOCK) {
            pausedAt = SystemClock.elapsedRealtime();
        }
    }

    @Override
    protected void handleOnResume() {
        synchronized (LOCK) {
            if (pausedAt > 0L) {
                long away = SystemClock.elapsedRealtime() - pausedAt;
                if (unlockedAt > 0L && away > longestAwayMs) longestAwayMs = away;
                pausedAt = 0L;
            }
        }
    }

    @PluginMethod
    public void getHideInSwitcher(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", hideInSwitcher(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void setHideInSwitcher(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled must be true or false.", "bad-value");
            return;
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_HIDE, enabled).apply();
        Activity activity = getActivity();
        if (activity != null) {
            final boolean hide = enabled;
            activity.runOnUiThread(() -> applyTo(activity.getWindow(), hide));
        }
        JSObject out = new JSObject();
        out.put("enabled", enabled);
        call.resolve(out);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context context = getContext();
        Activity activity = getActivity();
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        try {
            start(activity, context, intent);
        } catch (ActivityNotFoundException first) {
            // A phone without that page: the app's own settings page, where Notifications is one tap away.
            Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.getPackageName(), null));
            try {
                start(activity, context, details);
            } catch (ActivityNotFoundException second) {
                call.reject("This phone has no settings page for notifications. Open Settings, then Apps, then Plenum.", "unavailable");
                return;
            }
        }
        JSObject out = new JSObject();
        out.put("opened", true);
        call.resolve(out);
    }

    private static void start(Activity activity, Context context, Intent intent) {
        if (activity != null) {
            activity.startActivity(intent);
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        }
    }

    @PluginMethod
    public void markUnlocked(PluginCall call) {
        synchronized (LOCK) {
            unlockedAt = SystemClock.elapsedRealtime();
            longestAwayMs = 0L;
            // A pause that began before this unlock counts in full when it ends: stricter, never looser.
        }
        call.resolve();
    }

    @PluginMethod
    public void unlockFresh(PluginCall call) {
        Object raw = call.getData().opt("maxAgeMs");
        if (!(raw instanceof Number)) {
            call.reject("maxAgeMs must be a number of milliseconds.", "bad-value");
            return;
        }
        double maxAge = ((Number) raw).doubleValue();
        boolean fresh = false;
        if (maxAge > 0 && !Double.isNaN(maxAge)) {
            synchronized (LOCK) {
                long now = SystemClock.elapsedRealtime();
                long away = longestAwayMs;
                if (pausedAt > 0L && now - pausedAt > away) away = now - pausedAt;
                fresh = screenReceiverRegistered && unlockedAt > 0L && (now - unlockedAt) < maxAge && away <= maxAge;
            }
        }
        JSObject out = new JSObject();
        out.put("fresh", fresh);
        call.resolve(out);
    }

    @PluginMethod
    public void clearUnlocked(PluginCall call) {
        forgetUnlock();
        call.resolve();
    }
}
