package tn.samurai.pos;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pont exposé à la WebView sous le nom « SamuraiNative ».
 * Méthodes synchrones : base de données, PBKDF2/SHA-256, secrets.
 * Méthodes asynchrones (id, json) : réponse via window.__nativeReply(id, json).
 */
final class NativeBridge {
    private final MainActivity activity;
    private final PosDatabase db;
    private final BluetoothPrinter printer;
    private final SharedPreferences secrets;
    private final ExecutorService background = Executors.newSingleThreadExecutor();

    NativeBridge(MainActivity activity, PosDatabase db, BluetoothPrinter printer) {
        this.activity = activity;
        this.db = db;
        this.printer = printer;
        this.secrets = activity.getSharedPreferences("samurai-secrets", Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------------ Base SQLite (synchrone)

    @JavascriptInterface public String dbOpen() { return db.open(); }
    @JavascriptInterface public String dbQuery(String sql, String params, int limit) { return db.query(sql, params, limit); }
    @JavascriptInterface public String dbRun(String sql, String params) { return db.run(sql, params); }
    @JavascriptInterface public String dbExec(String sql) { return db.exec(sql); }
    @JavascriptInterface public String dbClose() { return db.closeFromJs(); }

    // ------------------------------------------------------------------ Cryptographie (synchrone, natif = rapide)

    /** PBKDF2-HMAC-SHA256, identique à crypto.pbkdf2Sync de Node (mot de passe et sel en UTF-8). */
    @JavascriptInterface
    public String pbkdf2(String password, String salt, int iterations, int length) {
        try {
            byte[] key = password.getBytes(StandardCharsets.UTF_8);
            // HMAC avec clé vide ≡ clé 0x00 (remplissage par zéros) ; SecretKeySpec refuse une clé vide.
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.length == 0 ? new byte[]{0} : key, "HmacSHA256"));
            byte[] saltBytes = salt.getBytes(StandardCharsets.UTF_8);
            int hLen = mac.getMacLength();
            int blocks = (length + hLen - 1) / hLen;
            byte[] out = new byte[length];
            for (int b = 1; b <= blocks; b++) {
                mac.update(saltBytes);
                mac.update(new byte[]{(byte) (b >>> 24), (byte) (b >>> 16), (byte) (b >>> 8), (byte) b});
                byte[] u = mac.doFinal();
                byte[] t = u.clone();
                for (int i = 1; i < iterations; i++) {
                    u = mac.doFinal(u);
                    for (int j = 0; j < t.length; j++) t[j] ^= u[j];
                }
                int offset = (b - 1) * hLen;
                System.arraycopy(t, 0, out, offset, Math.min(hLen, length - offset));
            }
            return hex(out);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @JavascriptInterface
    public String sha256(String text) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------ Secrets (clé de synchronisation)

    @JavascriptInterface public String secretGet(String key) { return secrets.getString(key, ""); }
    @JavascriptInterface public void secretPut(String key, String value) { secrets.edit().putString(key, value).apply(); }
    @JavascriptInterface public void ready() { activity.runOnUiThread(activity::onWebReady); }

    // ------------------------------------------------------------------ Bluetooth (asynchrone)

    @JavascriptInterface
    public void btList(int id, String json) {
        boolean ask = parse(json).optBoolean("ask", false);
        Runnable list = () -> {
            try { reply(id, printer.list(), null); } catch (Throwable e) { reply(id, null, BluetoothPrinter.message(e)); }
        };
        if (ask) activity.runOnUiThread(() -> activity.ensureBluetooth(false, list));
        else list.run();
    }

    @JavascriptInterface
    public void btWarmup(int id, String json) {
        printer.warmup(parse(json).optString("address"), (value, error) -> reply(id, value, error));
    }

    @JavascriptInterface
    public void btPrint(int id, String json) {
        JSONObject args = parse(json);
        byte[] data;
        try { data = Base64.decode(args.optString("data"), Base64.DEFAULT); }
        catch (IllegalArgumentException e) { reply(id, null, "Ticket invalide."); return; }
        printer.print(args.optString("address"), data, (value, error) -> reply(id, value, error));
    }

    @JavascriptInterface
    public void btDiscover(int id, String json) {
        int seconds = parse(json).optInt("seconds", 10);
        activity.runOnUiThread(() -> activity.ensureBluetooth(true, () -> printer.discover(seconds, (value, error) -> reply(id, value, error))));
    }

    @JavascriptInterface
    public void btPair(int id, String json) {
        printer.pair(parse(json).optString("address"), (value, error) -> reply(id, value, error));
    }

    @JavascriptInterface
    public void openBluetoothSettings(int id, String json) {
        activity.runOnUiThread(() -> {
            activity.openBluetoothSettings();
            reply(id, new JSONObject(), null);
        });
    }

    // ------------------------------------------------------------------ Sauvegarde / restauration

    @JavascriptInterface
    public void backupDb(int id, String json) {
        String name = parse(json).optString("name", "Samurai-POS.sqlite");
        activity.runOnUiThread(() -> activity.chooseBackupTarget(name, id));
    }

    @JavascriptInterface
    public void restoreDb(int id, String json) {
        activity.runOnUiThread(() -> activity.chooseRestoreSource(id));
    }

    // ------------------------------------------------------------------ HTTP (synchronisation en ligne)

    @JavascriptInterface
    public void http(int id, String json) {
        JSONObject args = parse(json);
        background.execute(() -> {
            HttpURLConnection c = null;
            try {
                URL url = new URL(args.getString("url"));
                if (!"https".equalsIgnoreCase(url.getProtocol()) && !"http".equalsIgnoreCase(url.getProtocol())) throw new IllegalArgumentException("Adresse invalide.");
                c = (HttpURLConnection) url.openConnection();
                int timeout = args.optInt("timeoutMs", 30000);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setRequestMethod(args.optString("method", "GET"));
                c.setUseCaches(false);
                JSONObject headers = args.optJSONObject("headers");
                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) { String k = keys.next(); c.setRequestProperty(k, headers.optString(k)); }
                }
                String body = args.isNull("body") ? null : args.optString("body", null);
                if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                }
                int status = c.getResponseCode();
                String text = IoUtil.readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
                JSONObject result = new JSONObject();
                result.put("status", status);
                result.put("body", text);
                reply(id, result, null);
            } catch (Throwable e) {
                reply(id, null, "Réseau indisponible : " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    // ------------------------------------------------------------------ Réponses vers JavaScript

    void reply(int id, JSONObject value, String error) {
        String payload;
        try {
            JSONObject wrapper = new JSONObject();
            if (error != null) wrapper.put("error", error);
            else wrapper.put("value", value == null ? new JSONObject() : value);
            payload = wrapper.toString();
        } catch (Exception e) {
            payload = "{\"error\":\"Réponse invalide.\"}";
        }
        activity.evaluate("window.__nativeReply&&window.__nativeReply(" + id + "," + JSONObject.quote(payload) + ")");
    }

    void event(String name, JSONObject data) {
        activity.evaluate("window.__nativeEvent&&window.__nativeEvent(" + JSONObject.quote(name) + "," + JSONObject.quote(data == null ? "{}" : data.toString()) + ")");
    }

    void shutdown() { background.shutdown(); }

    private static JSONObject parse(String json) {
        try { return new JSONObject(json == null || json.isEmpty() ? "{}" : json); } catch (Exception e) { return new JSONObject(); }
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = digits[(bytes[i] >> 4) & 0xf];
            out[i * 2 + 1] = digits[bytes[i] & 0xf];
        }
        return new String(out);
    }
}
