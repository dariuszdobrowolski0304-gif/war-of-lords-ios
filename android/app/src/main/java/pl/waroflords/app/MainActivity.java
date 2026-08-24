package pl.waroflords.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Capacitor's default WebView leaves pinch-to-zoom off, which made the desktop-sized
        // login form unusable on a phone screen (nothing to zoom in on to reach the fields).
        // setDisplayZoomControls(false) keeps the on-screen +/- buttons hidden — only the pinch
        // gesture itself is enabled, not a visible zoom UI overlay.
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);
    }
}
