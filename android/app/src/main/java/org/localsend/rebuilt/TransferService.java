package org.localsend.rebuilt;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** User-started foreground lifetime for discovery, approvals and streaming transfers. */
public final class TransferService extends Service {
    public static final String STOP = "org.localsend.rebuilt.STOP";
    public interface Observer { void onState(JSONObject state); }
    public interface Operation { void run(TransferEngine engine) throws Exception; }
    public interface Completion { void done(String error); }
    public final class LocalBinder extends Binder { public TransferService service() { return TransferService.this; } }
    private final IBinder binder = new LocalBinder();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService commands = Executors.newSingleThreadExecutor();
    private final CopyOnWriteArrayList<Observer> observers = new CopyOnWriteArrayList<>();
    private volatile JSONObject snapshot = new JSONObject();
    private volatile TransferEngine engine;
    private volatile boolean starting, destroyed;
    private WifiManager.MulticastLock multicast;
    private PowerManager.WakeLock wake;
    private AndroidStorage storage;
    private SharedPreferences preferences;
    private String savedHistory = "[]";
    private String notificationText = "";

    @Override public void onCreate() {
        super.onCreate();
        storage = new AndroidStorage(this);
        preferences = getSharedPreferences("localsend", MODE_PRIVATE);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("local-sharing", "Local file sharing", NotificationManager.IMPORTANCE_LOW));
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LocalSendRebuilt:transfer");
        wake.setReferenceCounted(false);
        startForeground(53317, notification("Starting local sharing…"));
        initialize();
    }
    private Notification notification(String message) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TransferService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "local-sharing").setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Super Send").setContentText(message).setContentIntent(open)
                .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build()).build();
    }
    private synchronized void initialize() {
        if (engine != null || starting || destroyed) return;
        starting = true;
        startForeground(53317, notification("Starting local sharing…"));
        commands.execute(() -> {
            try {
                AndroidIdentity identity = new AndroidIdentity();
                String alias = preferences.getString("alias", Build.MODEL == null ? "Android phone" : Build.MODEL);
                TransferEngine next = new TransferEngine(identity.context, identity.fingerprint, alias, storage.fallbackDirectory(), this::publish, storage);
                next.setDeviceModel(Build.MANUFACTURER + " " + Build.MODEL);
                try { next.restoreHistory(new JSONArray(preferences.getString("history", "[]"))); } catch (Exception ignored) { }
                next.updateSettings(alias, preferences.getBoolean("autoAccept", false));
                engine = next;
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) { multicast = wifi.createMulticastLock("LocalSendRebuilt:discovery"); multicast.setReferenceCounted(false); multicast.acquire(); }
                next.start(53317, true);
                publish(next.state());
            } catch (Exception error) {
                TransferEngine current = engine; engine = null;
                if (current != null) current.dispose();
                releaseLocks();
                JSONObject state = new JSONObject();
                try { state.put("network", new JSONObject().put("ready", false).put("error", readable(error))); } catch (Exception ignored) { }
                publish(state);
            } finally { starting = false; }
        });
    }
    public JSONObject state() { return snapshot; }
    public AndroidStorage storage() { return storage; }
    public boolean running() { return engine != null || starting; }
    public void observe(Observer observer) { observers.add(observer); observer.onState(snapshot); }
    public void unobserve(Observer observer) { observers.remove(observer); }
    public void execute(Operation operation, Completion completion) {
        if (destroyed) { if (completion != null) completion.done("Sharing has stopped. Start it again."); return; }
        commands.execute(() -> {
            String error = null;
            try {
                TransferEngine current = engine;
                if (current == null) throw new IllegalStateException("Sharing is starting or stopped. Try Start sharing.");
                operation.run(current);
            } catch (Exception e) { error = readable(e); }
            if (completion != null) { final String result = error; main.post(() -> completion.done(result)); }
        });
    }
    public void updateSettings(String alias, boolean accept, Completion completion) {
        execute(e -> {
            e.updateSettings(alias, accept);
            preferences.edit().putString("alias", alias).putBoolean("autoAccept", accept).apply();
        }, completion);
    }
    private void publish(JSONObject state) {
        snapshot = state;
        JSONArray history = state.optJSONArray("history");
        if (history != null) {
            String serialized = history.toString();
            if (!serialized.equals(savedHistory)) { savedHistory = serialized; preferences.edit().putString("history", serialized).apply(); }
        }
        JSONArray transfers = state.optJSONArray("transfers");
        boolean active = false;
        if (transfers != null) for (int i = 0; i < transfers.length(); i++) {
            JSONObject t = transfers.optJSONObject(i);
            if (t != null && ("waiting".equals(t.optString("status")) || "transferring".equals(t.optString("status")))) active = true;
        }
        final boolean transferring = active;
        JSONArray requests = state.optJSONArray("requests");
        JSONObject device = state.optJSONObject("device");
        JSONObject network = state.optJSONObject("network");
        final String notice = requests != null && requests.length() > 0 ? "Incoming transfer · Tap to accept or decline"
                : transferring ? "Transferring files · Tap to view progress"
                : network != null && network.optBoolean("ready") ? "Ready to receive · " + (device == null ? "Android" : device.optString("alias", "Android"))
                : network != null && !network.optString("error").isEmpty() ? network.optString("error") : "Local sharing is stopped";
        main.post(() -> {
            if (destroyed) return;
            if (transferring && engine != null && !wake.isHeld()) wake.acquire(30 * 60 * 1000L);
            else if ((!transferring || engine == null) && wake.isHeld()) wake.release();
            if ((engine != null || (network != null && !network.optString("error").isEmpty())) && !notice.equals(notificationText)) {
                notificationText = notice;
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(53317, notification(notice));
            }
            for (Observer o : observers) o.onState(snapshot);
        });
    }
    public void stopSharing() {
        commands.execute(() -> {
            TransferEngine current = engine; engine = null;
            if (current != null) current.dispose();
            releaseLocks();
            JSONObject state = current == null ? new JSONObject() : current.state();
            try {
                state.put("network", new JSONObject().put("ready", false).put("notice", "Sharing is stopped."));
                if (!state.has("history")) state.put("history", new JSONArray(preferences.getString("history", "[]")));
            } catch (Exception ignored) { }
            publish(state);
            main.post(() -> { if (engine == null && !starting) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); } });
        });
    }
    private void releaseLocks() {
        if (multicast != null && multicast.isHeld()) multicast.release();
        if (wake != null && wake.isHeld()) wake.release();
    }
    public static String readable(Throwable error) { String text = error.getMessage(); return text == null || text.trim().isEmpty() ? error.getClass().getSimpleName() : text; }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && STOP.equals(intent.getAction())) stopSharing();
        else initialize();
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public void onDestroy() {
        destroyed = true;
        observers.clear();
        commands.execute(() -> { if (engine != null) { engine.dispose(); publish(engine.state()); } engine = null; releaseLocks(); });
        commands.shutdown();
        super.onDestroy();
    }
}
