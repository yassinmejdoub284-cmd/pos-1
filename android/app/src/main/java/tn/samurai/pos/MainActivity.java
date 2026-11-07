package tn.samurai.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Caisse Samurai POS hors ligne : une WebView plein écran qui charge l'interface embarquée
 * (assets/www) et lui donne accès à la base SQLite, au Bluetooth et aux fichiers.
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";
    private static final int REQ_FILE = 10, REQ_BACKUP = 11, REQ_RESTORE = 12, REQ_ENABLE_BT = 13, REQ_PERMISSIONS = 20;

    private FrameLayout root;
    private WebView web;
    private PosDatabase db;
    private BluetoothPrinter printer;
    private NativeBridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> fileCallback;
    private int pendingBackupId = -1, pendingRestoreId = -1;
    private String pendingBackupName;
    private final List<Runnable> afterPermission = new ArrayList<>();
    private boolean wantScan;
    private long lastBack;
    private BroadcastReceiver bluetoothReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        db = new PosDatabase(getDatabasePath("samurai-pos.sqlite"), new File(getFilesDir(), "restauration"));
        printer = new BluetoothPrinter(this);
        bridge = new NativeBridge(this, db, printer);

        root = new FrameLayout(this);
        setContentView(root);
        // Clavier et barres système : la WebView se redimensionne au lieu d'être masquée.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        createWebView();
        immersive();
        requestStartupPermissions();
        listenBluetooth();
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void createWebView() {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF3F6F4);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);              // la taille de police système ne casse pas la mise en page
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setGeolocationEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false); // tout est local : pas d'appel réseau

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith(ORIGIN); // aucune navigation hors de la caisse
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Mémoire saturée : on recrée l'affichage au lieu de fermer l'application. Les ventes sont déjà en base.
                root.removeView(web);
                web.destroy();
                web = null;
                main.post(() -> { createWebView(); immersive(); });
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(bridge, "SamuraiNative");
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(START_URL);
    }

    void onWebReady() { /* l'interface est affichée */ }

    void evaluate(String script) {
        main.post(() -> { if (web != null) web.evaluateJavascript(script, null); });
    }

    private void immersive() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        immersive();
        bridge.event("resume", null);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (bluetoothReceiver != null) try { unregisterReceiver(bluetoothReceiver); } catch (Exception ignored) { }
        if (web != null) { root.removeView(web); web.destroy(); }
        printer.shutdown();
        bridge.shutdown();
        files.shutdown();
        db.close();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.__androidBack?String(window.__androidBack()):'false'", value -> {
            if ("\"true\"".equals(value)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) finish();
            else {
                lastBack = now;
                Toast.makeText(this, "Appuyez encore sur Retour pour quitter la caisse", Toast.LENGTH_SHORT).show();
            }
        });
    }

    // ------------------------------------------------------------------ Bluetooth : autorisations et activation

    private String[] bluetoothPermissions(boolean scan) {
        if (Build.VERSION.SDK_INT >= 31) return scan
                ? new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN}
                : new String[]{Manifest.permission.BLUETOOTH_CONNECT};
        return scan ? new String[]{Manifest.permission.ACCESS_FINE_LOCATION} : new String[0];
    }

    private boolean granted(String[] permissions) {
        for (String p : permissions) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    private void requestStartupPermissions() {
        String[] needed = bluetoothPermissions(false);
        if (needed.length > 0 && !granted(needed)) requestPermissions(needed, REQ_PERMISSIONS);
    }

    /** Demande les autorisations puis l'activation du Bluetooth si nécessaire, puis exécute next. */
    void ensureBluetooth(boolean scan, Runnable next) {
        String[] needed = bluetoothPermissions(scan);
        if (needed.length > 0 && !granted(needed)) {
            wantScan = scan;
            afterPermission.add(next);
            if (afterPermission.size() == 1) requestPermissions(needed, REQ_PERMISSIONS);
            return;
        }
        BluetoothAdapter adapter = printer.adapter();
        if (adapter != null && !adapter.isEnabled() && printer.hasConnectPermission()) {
            afterPermission.add(next);
            try {
                startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE_BT);
            } catch (Exception e) {
                runPending();
            }
            return;
        }
        next.run();
    }

    private void runPending() {
        List<Runnable> copy = new ArrayList<>(afterPermission);
        afterPermission.clear();
        for (Runnable r : copy) files.execute(r);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_PERMISSIONS) return;
        bridge.event("bluetooth", null);
        if (afterPermission.isEmpty()) return;
        BluetoothAdapter adapter = printer.adapter();
        if (granted(bluetoothPermissions(wantScan)) && adapter != null && !adapter.isEnabled()) {
            try {
                startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE_BT);
                return;
            } catch (Exception ignored) { }
        }
        runPending();
    }

    void openBluetoothSettings() {
        try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); }
        catch (Exception e) { Toast.makeText(this, "Réglages Bluetooth indisponibles", Toast.LENGTH_SHORT).show(); }
    }

    private void listenBluetooth() {
        bluetoothReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                try {
                    JSONObject data = new JSONObject();
                    data.put("action", intent.getAction());
                    bridge.event("bluetooth", data);
                } catch (Exception ignored) { }
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        filter.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        printer.register(bluetoothReceiver, filter);
    }

    // ------------------------------------------------------------------ Sauvegarde et restauration

    void chooseBackupTarget(String name, int id) {
        if (pendingBackupId >= 0) { bridge.reply(id, null, "Une sauvegarde est déjà en cours."); return; }
        pendingBackupId = id;
        pendingBackupName = name;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(intent, REQ_BACKUP); }
        catch (Exception e) { pendingBackupId = -1; bridge.reply(id, null, "Aucun gestionnaire de fichiers disponible."); }
    }

    void chooseRestoreSource(int id) {
        if (pendingRestoreId >= 0) { bridge.reply(id, null, "Une restauration est déjà en cours."); return; }
        pendingRestoreId = id;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        try { startActivityForResult(intent, REQ_RESTORE); }
        catch (Exception e) { pendingRestoreId = -1; bridge.reply(id, null, "Aucun gestionnaire de fichiers disponible."); }
    }

    private void doBackup(int id, Uri target, String name) {
        files.execute(() -> {
            File tmp = new File(getCacheDir(), "sauvegarde.sqlite");
            try {
                db.vacuumInto(tmp);
                try (InputStream in = new java.io.FileInputStream(tmp); OutputStream out = getContentResolver().openOutputStream(target, "w")) {
                    if (out == null) throw new IllegalStateException("Emplacement inaccessible.");
                    IoUtil.pipe(in, out);
                }
                JSONObject ok = new JSONObject();
                ok.put("path", name);
                bridge.reply(id, ok, null);
            } catch (Throwable e) {
                bridge.reply(id, null, "Sauvegarde impossible : " + e.getMessage());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        });
    }

    private void doRestore(int id, Uri source) {
        files.execute(() -> {
            File tmp = new File(getCacheDir(), "restauration.sqlite");
            try {
                try (InputStream in = getContentResolver().openInputStream(source); FileOutputStream out = new FileOutputStream(tmp)) {
                    if (in == null) throw new IllegalStateException("Fichier illisible.");
                    IoUtil.pipe(in, out);
                }
                db.restoreFrom(tmp);
                JSONObject ok = new JSONObject();
                ok.put("ok", true);
                bridge.reply(id, ok, null);
            } catch (Throwable e) {
                bridge.reply(id, null, e.getMessage() == null ? "Restauration impossible." : e.getMessage());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        } else if (requestCode == REQ_BACKUP) {
            int id = pendingBackupId;
            pendingBackupId = -1;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) doBackup(id, data.getData(), pendingBackupName);
            else cancelled(id);
        } else if (requestCode == REQ_RESTORE) {
            int id = pendingRestoreId;
            pendingRestoreId = -1;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) doRestore(id, data.getData());
            else cancelled(id);
        } else if (requestCode == REQ_ENABLE_BT) {
            bridge.event("bluetooth", null);
            runPending();
        }
    }

    private void cancelled(int id) {
        try {
            JSONObject c = new JSONObject();
            c.put("cancelled", true);
            bridge.reply(id, c, null);
        } catch (Exception ignored) { }
    }
}
