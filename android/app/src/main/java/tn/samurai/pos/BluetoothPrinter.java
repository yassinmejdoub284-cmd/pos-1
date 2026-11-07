package tn.samurai.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Imprimantes thermiques ESC/POS en Bluetooth classique (profil série SPP) :
 * appareils appairés, recherche, appairage, envoi des tickets avec reconnexion automatique.
 */
@SuppressLint("MissingPermission")
final class BluetoothPrinter {
    interface Result { void done(JSONObject value, String error); }

    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final long REUSE_MS = 60_000;   // au-delà, on reconnecte : une liaison ancienne peut être morte sans erreur
    private static final int CHUNK = 1024;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor();
    private BluetoothSocket socket;
    private String socketAddress;
    private long lastUse;
    private ScheduledFuture<?> idleClose;

    BluetoothPrinter(Context context) { this.context = context.getApplicationContext(); }

    BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager != null ? manager.getAdapter() : null;
    }

    boolean hasConnectPermission() {
        return Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= 31) return context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
        return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean isPrinter(BluetoothDevice device) {
        try {
            BluetoothClass c = device.getBluetoothClass();
            if (c == null) return false;
            // Classe majeure « Imagerie » (0x0600), bit 0x80 = imprimante ; certaines déclarent seulement « Imagerie ».
            return c.getMajorDeviceClass() == BluetoothClass.Device.Major.IMAGING;
        } catch (Throwable e) { return false; }
    }

    private JSONObject describe(BluetoothDevice d) throws Exception {
        JSONObject o = new JSONObject();
        String name = null;
        try { name = d.getName(); } catch (SecurityException ignored) { }
        o.put("name", name == null ? "" : name);
        o.put("address", d.getAddress());
        o.put("printer", isPrinter(d));
        o.put("connected", socket != null && d.getAddress().equals(socketAddress) && socket.isConnected());
        return o;
    }

    JSONObject list() throws Exception {
        JSONObject out = new JSONObject();
        BluetoothAdapter a = adapter();
        JSONArray devices = new JSONArray();
        out.put("available", a != null);
        out.put("permission", hasConnectPermission());
        out.put("enabled", a != null && a.isEnabled());
        if (a != null && a.isEnabled() && hasConnectPermission()) {
            Set<BluetoothDevice> bonded = a.getBondedDevices();
            if (bonded != null) for (BluetoothDevice d : bonded) devices.put(describe(d));
        }
        out.put("devices", devices);
        return out;
    }

    // ------------------------------------------------------------------ Impression

    void print(String address, byte[] data, Result result) {
        io.execute(() -> {
            try {
                write(address, data);
                JSONObject ok = new JSONObject();
                ok.put("ok", true);
                ok.put("bytes", data.length);
                result.done(ok, null);
            } catch (Throwable e) {
                result.done(null, message(e));
            }
        });
    }

    void warmup(String address, Result result) {
        io.execute(() -> {
            try {
                connect(address);
                JSONObject ok = new JSONObject();
                ok.put("ok", true);
                result.done(ok, null);
            } catch (Throwable e) {
                result.done(null, message(e));
            }
        });
    }

    private void write(String address, byte[] data) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                OutputStream out = connect(address).getOutputStream();
                for (int off = 0; off < data.length; off += CHUNK) {
                    out.write(data, off, Math.min(CHUNK, data.length - off));
                    out.flush();
                    // Petites pauses sur les gros tickets graphiques : les imprimantes bon marché ont peu de mémoire.
                    if (data.length > 8 * CHUNK) SystemClock.sleep(8);
                }
                out.flush();
                lastUse = SystemClock.elapsedRealtime();
                scheduleIdleClose();
                return;
            } catch (IOException e) {
                last = e;
                closeSocket();
                SystemClock.sleep(400);
            }
        }
        throw last != null ? last : new IOException("Impression impossible.");
    }

    private BluetoothSocket connect(String address) throws IOException {
        if (socket != null && address.equals(socketAddress) && socket.isConnected() && SystemClock.elapsedRealtime() - lastUse < REUSE_MS) return socket;
        closeSocket();
        if (!hasConnectPermission()) throw new IOException("Autorisez l’accès Bluetooth (« Appareils à proximité ») pour imprimer.");
        BluetoothAdapter a = adapter();
        if (a == null) throw new IOException("Cette tablette n’a pas de Bluetooth.");
        if (!a.isEnabled()) throw new IOException("Bluetooth désactivé : activez-le pour imprimer.");
        BluetoothDevice device;
        try { device = a.getRemoteDevice(address); } catch (IllegalArgumentException e) { throw new IOException("Adresse d’imprimante invalide."); }
        try { if (a.isDiscovering()) a.cancelDiscovery(); } catch (SecurityException ignored) { }
        for (int method = 0; method < 3; method++) {
            BluetoothSocket s = null;
            try {
                if (method == 0) s = device.createRfcommSocketToServiceRecord(SPP);
                else if (method == 1) s = device.createInsecureRfcommSocketToServiceRecord(SPP);
                else {
                    Method m = device.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(device, 1);
                }
                if (s == null) continue;
                s.connect();
                socket = s;
                socketAddress = address;
                lastUse = SystemClock.elapsedRealtime();
                scheduleIdleClose();
                return s;
            } catch (Throwable e) {
                try { if (s != null) s.close(); } catch (IOException ignored) { }
            }
        }
        throw new IOException("Imprimante injoignable : allumez-la, rapprochez-la et vérifiez qu’elle n’est pas connectée à un autre appareil.");
    }

    private void scheduleIdleClose() {
        if (idleClose != null) idleClose.cancel(false);
        idleClose = io.schedule(() -> {
            if (SystemClock.elapsedRealtime() - lastUse >= REUSE_MS) closeSocket();
        }, REUSE_MS + 1000, TimeUnit.MILLISECONDS);
    }

    private void closeSocket() {
        if (socket != null) {
            try { socket.close(); } catch (IOException ignored) { }
        }
        socket = null;
        socketAddress = null;
    }

    void shutdown() {
        io.execute(this::closeSocket);
        io.shutdown();
    }

    // ------------------------------------------------------------------ Recherche et appairage

    /** Recherche les appareils Bluetooth proches pendant quelques secondes (thread principal). */
    void discover(int seconds, Result result) {
        main.post(() -> {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { result.done(null, "Bluetooth désactivé : activez-le puis réessayez."); return; }
            if (!hasScanPermission()) { result.done(null, "Autorisez la recherche d’appareils à proximité."); return; }
            final Map<String, JSONObject> found = new LinkedHashMap<>();
            final boolean[] finished = {false};
            final BroadcastReceiver[] holder = new BroadcastReceiver[1];
            final Runnable finish = () -> {
                if (finished[0]) return;
                finished[0] = true;
                try { context.unregisterReceiver(holder[0]); } catch (Throwable ignored) { }
                try { a.cancelDiscovery(); } catch (Throwable ignored) { }
                try {
                    JSONObject out = new JSONObject();
                    JSONArray list = new JSONArray();
                    for (JSONObject o : found.values()) list.put(o);
                    out.put("devices", list);
                    result.done(out, null);
                } catch (Throwable e) { result.done(null, message(e)); }
            };
            holder[0] = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent intent) {
                    if (BluetoothDevice.ACTION_FOUND.equals(intent.getAction())) {
                        BluetoothDevice d = device(intent);
                        if (d == null) return;
                        try { found.put(d.getAddress(), describe(d)); } catch (Throwable ignored) { }
                    } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(intent.getAction())) {
                        main.post(finish);
                    }
                }
            };
            IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_FOUND);
            filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
            register(holder[0], filter);
            try {
                if (a.isDiscovering()) a.cancelDiscovery();
                if (!a.startDiscovery()) {
                    finished[0] = true;
                    try { context.unregisterReceiver(holder[0]); } catch (Throwable ignored) { }
                    result.done(null, Build.VERSION.SDK_INT < 31
                            ? "Recherche impossible : activez la localisation de la tablette puis réessayez."
                            : "Recherche Bluetooth impossible pour le moment.");
                    return;
                }
            } catch (SecurityException e) {
                finished[0] = true;
                try { context.unregisterReceiver(holder[0]); } catch (Throwable ignored) { }
                result.done(null, "Autorisez la recherche d’appareils à proximité.");
                return;
            }
            main.postDelayed(finish, Math.max(4, Math.min(seconds, 20)) * 1000L);
        });
    }

    /** Lance l'appairage (Android affiche la demande de code) et attend le résultat. */
    void pair(String address, Result result) {
        main.post(() -> {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { result.done(null, "Bluetooth désactivé."); return; }
            final BluetoothDevice device;
            try { device = a.getRemoteDevice(address); } catch (Throwable e) { result.done(null, "Adresse invalide."); return; }
            try {
                if (device.getBondState() == BluetoothDevice.BOND_BONDED) { result.done(new JSONObject().put("bonded", true), null); return; }
            } catch (Throwable ignored) { }
            final boolean[] finished = {false};
            final BroadcastReceiver[] holder = new BroadcastReceiver[1];
            final Runnable timeout = () -> {
                if (finished[0]) return;
                finished[0] = true;
                try { context.unregisterReceiver(holder[0]); } catch (Throwable ignored) { }
                result.done(null, "Appairage non confirmé. Saisissez le code de l’imprimante (souvent 0000 ou 1234).");
            };
            holder[0] = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent intent) {
                    BluetoothDevice d = device(intent);
                    if (d == null || !address.equals(d.getAddress()) || finished[0]) return;
                    int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR);
                    int previous = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR);
                    if (state == BluetoothDevice.BOND_BONDED || (state == BluetoothDevice.BOND_NONE && previous == BluetoothDevice.BOND_BONDING)) {
                        finished[0] = true;
                        main.removeCallbacks(timeout);
                        try { context.unregisterReceiver(this); } catch (Throwable ignored) { }
                        if (state == BluetoothDevice.BOND_BONDED) {
                            try { result.done(new JSONObject().put("bonded", true), null); } catch (Throwable e) { result.done(null, message(e)); }
                        } else result.done(null, "Appairage refusé ou code incorrect.");
                    }
                }
            };
            register(holder[0], new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED));
            try {
                try { if (a.isDiscovering()) a.cancelDiscovery(); } catch (Throwable ignored) { }
                if (!device.createBond()) { timeout.run(); return; }
            } catch (SecurityException e) {
                finished[0] = true;
                try { context.unregisterReceiver(holder[0]); } catch (Throwable ignored) { }
                result.done(null, "Autorisez l’accès Bluetooth pour appairer l’imprimante.");
                return;
            }
            main.postDelayed(timeout, 60_000);
        });
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    void register(BroadcastReceiver receiver, IntentFilter filter) {
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        else context.registerReceiver(receiver, filter);
    }

    @SuppressWarnings("deprecation")
    static BluetoothDevice device(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
        return intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
    }

    static String message(Throwable e) {
        if (e instanceof SecurityException) return "Autorisez l’accès Bluetooth pour imprimer.";
        String m = e.getMessage();
        return m == null || m.isEmpty() ? "Erreur Bluetooth." : m;
    }
}
