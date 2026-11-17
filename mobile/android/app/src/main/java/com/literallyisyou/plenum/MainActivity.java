package com.literallyisyou.plenum;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

// No "show over the lock screen" here, for any route (wave 5, f2). Android's lock screen asks for the phone's unlock before it opens an
// activity from a notification's action button, whatever the activity's own lock-screen settings are, so a lock-screen switch in this
// activity is never reached from a notification. A Stop with no unlock does not come here at all (wave 6, k3): when the phone holds that
// computer's Stop card, the notification's Stop is a broadcast to the UnifiedPush plugin's StopReceiver, which sends the signed Stop-only
// message itself. Without a card, Stop opens this activity at #stop, after the unlock, as before.
public class MainActivity extends BridgeActivity {
    // The page's own backgrounds (shell tokens; res/values/colors.xml and res/values-night/colors.xml plenum_background).
    static final int BACKGROUND_LIGHT = Color.rgb(0xf6, 0xf6, 0xfb);
    static final int BACKGROUND_DARK = Color.rgb(0x0a, 0x0a, 0x11);

    // The plenum:// link this launch came with, handed to the plugins once by BridgeActivity.load (see onNewIntent below).
    private Intent launchLink = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins are registered before the bridge starts (Capacitor's BridgeActivity contract).
        registerPlugin(PlenumPrivacyPlugin.class);
        // A link runs once (wave 4, k1 review). Capacitor's Bridge keeps the launch intent's data as getLaunchUrl() for the
        // activity's whole life, and the shell asks for it on every page load: each switch between the shell page and the UI page
        // would run a "Stop" shortcut or a notification's Stop again. So the Bridge is started with the link taken off the
        // intent (getLaunchUrl() then has nothing), and the link goes to the plugins once, as the appUrlOpen event that
        // BridgeActivity.load sends for the launch intent; the App plugin keeps that event until the first page listens, then
        // drops it. A reopen from recents (Android hands back the old intent, even after the process died) or a re-created
        // activity is not a new tap, so its old link is dropped and runs nowhere.
        Intent launch = getIntent();
        Uri link = launch != null ? launch.getData() : null;
        if (link != null) {
            boolean stale = savedInstanceState != null || (launch.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
            boolean view = Intent.ACTION_VIEW.equals(launch.getAction());
            if (stale || view) {
                setIntent(new Intent(launch).setData(null));
            }
            if (view && !stale) {
                launchLink = launch;
            }
        }
        super.onCreate(savedInstanceState);
        launchLink = null;
        // "Hide content in the app switcher" applies from the first frame, before the shell has loaded (MOBILE-UI 15.6).
        PlenumPrivacyPlugin.applyTo(getWindow(), PlenumPrivacyPlugin.hideInSwitcher(this));
        // The WebView and the window behind it take the page's background before the first page draws, so a dark start and a
        // page switch do not flash white (wave 4, k1).
        applyBackground(getResources().getConfiguration());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // BridgeActivity.load calls this with getIntent() (the link taken off) once the Bridge exists: the plugins get the launch
        // intent with its link instead, exactly once. Later calls are links that arrive while the app is open, passed on as they are.
        Intent pending = launchLink;
        launchLink = null;
        super.onNewIntent(pending != null ? pending : intent);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // uiMode is in the manifest's configChanges, so a switch to or from dark mode does not restart the activity: follow it here.
        applyBackground(newConfig);
    }

    private void applyBackground(Configuration config) {
        boolean night = config != null && (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int color = night ? BACKGROUND_DARK : BACKGROUND_LIGHT;
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.setBackgroundColor(color);
        }
    }
}
