package tn.samurai.pos;

import android.util.Base64;

import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Base de caisse : SQLite récent embarqué dans l'APK (identique quelle que soit la version d'Android),
 * fichier dans le stockage privé de l'application. API synchrone appelée par le pont JavaScript,
 * avec la même sémantique que node:sqlite utilisé par la version Windows.
 */
final class PosDatabase {
    private final File file;
    private final File restoreDir;
    private SQLiteConnection conn;
    private boolean restoring;
    private final LinkedHashMap<String, SQLiteStatement> cache = new LinkedHashMap<String, SQLiteStatement>(96, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, SQLiteStatement> eldest) {
            if (size() > 96) {
                try { eldest.getValue().close(); } catch (Throwable ignored) { }
                return true;
            }
            return false;
        }
    };

    PosDatabase(File file, File restoreDir) {
        this.file = file;
        this.restoreDir = restoreDir;
    }

    // ---------------------------------------------------------------- API JavaScript

    synchronized String open() {
        try {
            ensureOpen();
            return "{\"v\":{\"path\":" + JSONObject.quote(file.getAbsolutePath()) + "}}";
        } catch (Throwable e) { return error(e); }
    }

    synchronized String query(String sql, String params, int limit) {
        SQLiteStatement st = null;
        try {
            st = statement(sql);
            bind(st, params);
            StringBuilder sb = new StringBuilder(256).append("{\"v\":[");
            String[] names = null;
            int rows = 0;
            while (st.step()) {
                if (names == null) {
                    names = new String[st.getColumnCount()];
                    for (int i = 0; i < names.length; i++) names[i] = JSONObject.quote(st.getColumnName(i));
                }
                if (rows > 0) sb.append(',');
                sb.append('{');
                for (int i = 0; i < names.length; i++) {
                    if (i > 0) sb.append(',');
                    sb.append(names[i]).append(':');
                    appendValue(sb, st, i);
                }
                sb.append('}');
                rows++;
                if (limit > 0 && rows >= limit) break;
            }
            return sb.append("]}").toString();
        } catch (Throwable e) {
            return error(e);
        } finally {
            reset(st);
        }
    }

    synchronized String run(String sql, String params) {
        SQLiteStatement st = null;
        try {
            st = statement(sql);
            bind(st, params);
            while (st.step()) { /* consommer les lignes éventuelles */ }
            reset(st);
            st = null;
            SQLiteStatement info = statement("SELECT changes(), last_insert_rowid()");
            try {
                info.step();
                return "{\"v\":{\"changes\":" + info.getLong(0) + ",\"lastInsertRowid\":" + info.getLong(1) + "}}";
            } finally { reset(info); }
        } catch (Throwable e) {
            return error(e);
        } finally {
            reset(st);
        }
    }

    synchronized String exec(String sql) {
        try {
            List<String> parts = split(sql);
            if (parts.size() == 1) {
                SQLiteStatement st = statement(parts.get(0));
                try { while (st.step()) { /* PRAGMA renvoyant une ligne */ } } finally { reset(st); }
            } else {
                ensureOpen();
                for (String part : parts) {
                    SQLiteStatement st = conn.prepare(part);
                    try { while (st.step()) { /* idem */ } } finally { st.close(); }
                }
            }
            return "{\"v\":null}";
        } catch (Throwable e) { return error(e); }
    }

    synchronized String closeFromJs() {
        try { close(); return "{\"v\":null}"; } catch (Throwable e) { return error(e); }
    }

    // ---------------------------------------------------------------- Sauvegarde / restauration

    /** Copie cohérente de la base (même procédé que la version Windows : VACUUM INTO). */
    synchronized void vacuumInto(File target) throws Exception {
        if (target.exists() && !target.delete()) throw new IllegalStateException("Fichier temporaire bloqué.");
        SQLiteStatement st = statement("VACUUM INTO ?");
        try { st.bindText(1, target.getAbsolutePath()); while (st.step()) { } } finally { reset(st); }
    }

    /** Remplace la base par une sauvegarde vérifiée ; l'ancienne base est conservée à part. */
    void restoreFrom(File candidate) throws Exception {
        validate(candidate);
        synchronized (this) {
            if (conn != null) {
                exec("PRAGMA wal_checkpoint(TRUNCATE)");
                close();
            }
            restoring = true;
            try {
                if (!restoreDir.exists() && !restoreDir.mkdirs()) throw new IllegalStateException("Dossier de sécurité indisponible.");
                File[] old = restoreDir.listFiles();
                if (old != null && old.length >= 3) {
                    java.util.Arrays.sort(old, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
                    for (int i = 0; i <= old.length - 3; i++) //noinspection ResultOfMethodCallIgnored
                        old[i].delete();
                }
                String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date());
                if (file.exists()) IoUtil.copy(file, new File(restoreDir, "avant-restauration-" + stamp + ".sqlite"));
                for (String suffix : new String[]{"-wal", "-shm", "-journal"}) //noinspection ResultOfMethodCallIgnored
                    new File(file.getPath() + suffix).delete();
                IoUtil.copy(candidate, file);
            } finally {
                restoring = false;
            }
        }
    }

    private static void validate(File candidate) throws Exception {
        SQLiteConnection c = new BundledSQLiteDriver().open(candidate.getAbsolutePath());
        try {
            SQLiteStatement check = c.prepare("PRAGMA quick_check");
            try {
                if (!check.step() || !"ok".equalsIgnoreCase(check.getText(0))) throw new IllegalArgumentException("Fichier de sauvegarde endommagé.");
            } finally { check.close(); }
            SQLiteStatement tables = c.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('meta','users','sales','entities')");
            try {
                if (!tables.step() || tables.getLong(0) != 4) throw new IllegalArgumentException("Ce fichier n’est pas une sauvegarde Samurai POS.");
            } finally { tables.close(); }
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Throwable e) {
            throw new IllegalArgumentException("Ce fichier n’est pas une base SQLite valide.");
        } finally {
            c.close();
        }
    }

    // ---------------------------------------------------------------- Interne

    private void ensureOpen() {
        if (restoring) throw new IllegalStateException("Restauration en cours, patientez.");
        if (conn == null) {
            File dir = file.getParentFile();
            if (dir != null && !dir.exists()) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            conn = new BundledSQLiteDriver().open(file.getAbsolutePath());
        }
    }

    private SQLiteStatement statement(String sql) {
        ensureOpen();
        SQLiteStatement st = cache.get(sql);
        if (st == null) {
            st = conn.prepare(sql);
            cache.put(sql, st);
        }
        return st;
    }

    synchronized void close() {
        Iterator<SQLiteStatement> it = cache.values().iterator();
        while (it.hasNext()) {
            try { it.next().close(); } catch (Throwable ignored) { }
            it.remove();
        }
        if (conn != null) {
            try { conn.close(); } catch (Throwable ignored) { }
            conn = null;
        }
    }

    private static void reset(SQLiteStatement st) {
        if (st == null) return;
        try { st.reset(); } catch (Throwable ignored) { }
        try { st.clearBindings(); } catch (Throwable ignored) { }
    }

    /** Liaison identique à node:sqlite : nombres en REAL, texte, NULL. */
    private static void bind(SQLiteStatement st, String params) throws Exception {
        st.reset();
        st.clearBindings();
        if (params == null || params.isEmpty() || "[]".equals(params)) return;
        JSONArray values = new JSONArray(params);
        for (int i = 0; i < values.length(); i++) {
            Object v = values.get(i);
            int index = i + 1;
            if (v == JSONObject.NULL) st.bindNull(index);
            else if (v instanceof Number) st.bindDouble(index, ((Number) v).doubleValue());
            else st.bindText(index, v.toString());
        }
    }

    private static void appendValue(StringBuilder sb, SQLiteStatement st, int i) {
        switch (st.getColumnType(i)) {
            case 1: // INTEGER
                sb.append(st.getLong(i));
                break;
            case 2: { // FLOAT
                double d = st.getDouble(i);
                if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
                else if (d == Math.rint(d) && Math.abs(d) < 9.0e15) sb.append((long) d);
                else sb.append(d);
                break;
            }
            case 3: // TEXT
                sb.append(JSONObject.quote(st.getText(i)));
                break;
            case 4: // BLOB
                sb.append(JSONObject.quote(Base64.encodeToString(st.getBlob(i), Base64.NO_WRAP)));
                break;
            default:
                sb.append("null");
        }
    }

    /** Découpe un script en instructions (guillemets, crochets et commentaires respectés). */
    static List<String> split(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        char quote = 0;
        int n = sql.length();
        for (int i = 0; i < n; i++) {
            char c = sql.charAt(i);
            if (quote != 0) {
                cur.append(c);
                if (c == quote) {
                    if (quote != ']' && i + 1 < n && sql.charAt(i + 1) == quote) { cur.append(sql.charAt(++i)); }
                    else quote = 0;
                }
                continue;
            }
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                while (i < n && sql.charAt(i) != '\n') i++;
                cur.append('\n');
                continue;
            }
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2);
                i = end < 0 ? n : end + 1;
                cur.append(' ');
                continue;
            }
            if (c == '\'' || c == '"' || c == '`') quote = c;
            else if (c == '[') quote = ']';
            if (c == ';') {
                String part = cur.toString().trim();
                if (!part.isEmpty()) out.add(part);
                cur.setLength(0);
                continue;
            }
            cur.append(c);
        }
        String last = cur.toString().trim();
        if (!last.isEmpty()) out.add(last);
        return out;
    }

    private static String error(Throwable e) {
        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        // « Error code: 19, message: UNIQUE constraint failed: … » → même texte que node:sqlite.
        int idx = message.indexOf("message: ");
        if (message.startsWith("Error code") && idx >= 0) message = message.substring(idx + 9);
        return "{\"e\":" + JSONObject.quote(message) + "}";
    }
}
