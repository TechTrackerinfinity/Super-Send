package org.localsend.rebuilt;

import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** LocalSend v2 transport. Deliberately independent of the Android framework. */
public final class TransferEngine {
    public interface Listener { void onState(JSONObject state); }
    public interface Opener { InputStream open() throws Exception; }
    public interface Storage { Destination create(String relativeName) throws Exception; }
    public interface Destination {
        OutputStream output() throws Exception;
        String location();
        void commit() throws Exception;
        void abort();
    }
    public static final class Source {
        public final String id, name, mime, preview;
        public final long size;
        public final Opener opener;
        public Source(String name, long size, String mime, String preview, Opener opener) {
            this.id = UUID.randomUUID().toString(); this.name = name; this.size = size;
            this.mime = mime == null ? "application/octet-stream" : mime;
            this.preview = preview; this.opener = opener;
        }
    }
    private static final String API = "/api/localsend/v2", GROUP = "224.0.0.167", REVERSE = API + "/rebuilt/reverse";
    private static final int MAX_JSON = 2 * 1024 * 1024;
    // Coalesce TLS records and document-provider writes without holding a file in memory.
    private static final int TRANSFER_BUFFER_SIZE = 256 * 1024;
    private static final int MAX_PARALLEL_FILES = 3;
    private static final long PROGRESS_INTERVAL_NANOS = TimeUnit.MILLISECONDS.toNanos(100);
    private static final long REVERSE_QUEUE_LIFETIME = 180000, REVERSE_SESSION_LIFETIME = 1800000;
    private static final ThreadFactory THREADS = runnable -> { Thread t = new Thread(runnable, "LocalSend-transport"); t.setDaemon(true); return t; };
    private final Object lock = new Object();
    private final SSLContext tls;
    private final String fingerprint;
    private final File receiveDir;
    private final Storage storage;
    private final Listener listener;
    private final ExecutorService work = new ThreadPoolExecutor(0, 32, 30, TimeUnit.SECONDS, new SynchronousQueue<Runnable>(), THREADS);
    private final ScheduledExecutorService events = Executors.newSingleThreadScheduledExecutor(THREADS);
    private final Map<String, JSONObject> peers = new LinkedHashMap<>();
    private final List<Source> selection = new ArrayList<>();
    private final List<Transfer> transfers = new ArrayList<>();
    private final List<JSONObject> history = new ArrayList<>();
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final Map<String, Session> sessions = new LinkedHashMap<>();
    private final Map<String, ReverseOffer> reverseOffers = new LinkedHashMap<>();
    private final Map<String, ReverseTerminal> reverseTerminals = new LinkedHashMap<>();
    private final Map<String, NetworkInterface> discoveryNetworks = new LinkedHashMap<>();
    private final Set<Socket> accepted = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private final AtomicBoolean eventQueued = new AtomicBoolean();
    private volatile SSLServerSocket server;
    private volatile MulticastSocket multicast;
    private volatile List<String> localAddresses = Collections.emptyList();
    private volatile boolean running, discovery;
    private volatile boolean defaultMulticastMembership;
    private volatile int port = 53317;
    private volatile String alias, deviceModel = "Android", error;
    private volatile boolean autoAccept;
    private ScheduledFuture<?> announcement;
    private ScheduledFuture<?> reverseCleanup;

    public TransferEngine(SSLContext tls, String fingerprint, String alias, File fallbackReceiveDir, Listener listener, Storage storage) {
        if (tls == null || fingerprint == null || fallbackReceiveDir == null) throw new IllegalArgumentException("TLS identity and receive directory are required");
        this.tls = tls; this.fingerprint = normalizeFingerprint(fingerprint); this.alias = validAlias(alias);
        this.receiveDir = fallbackReceiveDir; this.listener = listener; this.storage = storage;
    }
    public void start(int requestedPort, boolean useDiscovery) throws Exception {
        if (events.isShutdown()) throw new IllegalStateException("This transport instance has been disposed");
        synchronized (lock) { if (running) return; }
        SSLServerSocket next = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket();
        try {
            next.setReuseAddress(true); next.setNeedClientAuth(true);
            try { next.bind(new InetSocketAddress(requestedPort)); }
            catch (BindException busy) { if (requestedPort != 53317) throw busy; next.bind(new InetSocketAddress(0)); }
            synchronized (lock) { server = next; port = next.getLocalPort(); running = true; error = null; }
            Thread acceptor = THREADS.newThread(() -> acceptLoop(next)); acceptor.start();
            if (useDiscovery) startDiscovery();
            // Re-check adapters quickly. Android can move between Wi-Fi and a
            // phone hotspot while this foreground service stays alive.
            announcement = events.scheduleAtFixedRate(() -> discover(), 10, 10, TimeUnit.SECONDS);
            reverseCleanup = events.scheduleAtFixedRate(this::expireReverseOffers, 5, 5, TimeUnit.SECONDS);
            changed();
        } catch (Exception e) { close(next); setError(e); throw e; }
    }
    public void stop() {
        running = false; discovery = false; close(server); server = null;
        MulticastSocket udp = multicast; multicast = null; if (udp != null) udp.close();
        synchronized (discoveryNetworks) { discoveryNetworks.clear(); defaultMulticastMembership = false; }
        if (announcement != null) announcement.cancel(false);
        if (reverseCleanup != null) reverseCleanup.cancel(false);
        for (Socket socket : accepted) close(socket);
        List<Transfer> abort = new ArrayList<>();
        synchronized (lock) {
            for (Pending p : pending.values()) { p.accept = false; p.ready.countDown(); }
            pending.clear();
            for (Transfer t : new ArrayList<>(transfers)) if (!t.saved) { t.cancelled = true; abort.add(t); finishLocked(t, "cancelled", null); }
            reverseOffers.clear(); reverseTerminals.clear(); lock.notifyAll();
        }
        for (Transfer t : abort) disconnect(t);
        changed();
    }
    /** Terminal release for a discarded service instance; stop() alone remains restartable. */
    public void dispose() {
        stop();
        events.shutdownNow();
        work.shutdownNow();
    }
    public JSONObject state() {
        synchronized (lock) {
            JSONArray ps = new JSONArray(); List<JSONObject> sorted = new ArrayList<>(peers.values());
            Collections.sort(sorted, (a, b) -> a.optString("alias").compareToIgnoreCase(b.optString("alias")));
            for (JSONObject p : sorted) ps.put(copy(p));
            JSONArray sources = new JSONArray();
            for (Source s : selection) sources.put(obj("id", s.id, "name", s.name, "size", s.size, "type", s.preview == null ? "file" : "text", "mime", s.mime));
            JSONArray ts = new JSONArray(); for (Transfer t : transfers) ts.put(copy(t.json));
            JSONArray rs = new JSONArray(); for (Pending p : pending.values()) rs.put(copy(p.json));
            JSONArray hs = new JSONArray(); for (JSONObject h : history) hs.put(copy(h));
            JSONObject device = info(); put(device, "addresses", new JSONArray(localAddresses));
            JSONObject network = obj("ready", running, "discovery", discovery); if (error != null) put(network, "error", error);
            return obj("device", device, "peers", ps, "selection", sources, "transfers", ts, "requests", rs, "history", hs,
                "network", network, "settings", obj("alias", alias, "autoAccept", autoAccept), "version", "1.6.0");
        }
    }
    public JSONObject addSource(Source source) {
        if (source == null || source.opener == null || source.size < 0 || source.size > 9007199254740991L) throw new IllegalArgumentException("Invalid file");
        safeRelative(source.name);
        synchronized (lock) { if (selection.size() >= 1000) throw new IllegalArgumentException("Select up to 1000 files"); selection.add(source); }
        changed(); return state();
    }
    public JSONObject addText(String text) {
        final String message = text == null ? "" : text.trim();
        final byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        if (message.isEmpty() || bytes.length > 1048576) throw new IllegalArgumentException("Enter a message up to 1 MB");
        return addSource(new Source("Message.txt", bytes.length, "text/plain", message, () -> new ByteArrayInputStream(bytes)));
    }
    public JSONObject clearSelection() { synchronized (lock) { selection.clear(); } changed(); return state(); }
    public JSONObject removeSelection(String id) { synchronized (lock) { for (Iterator<Source> it = selection.iterator(); it.hasNext();) if (it.next().id.equals(id)) it.remove(); } changed(); return state(); }
    public JSONObject updateSettings(String name, boolean accept) { alias = validAlias(name); autoAccept = accept; discover(); changed(); return state(); }
    public void setDeviceModel(String model) { if (model != null && !model.trim().isEmpty()) deviceModel = model.substring(0, Math.min(120, model.length())); changed(); }
    public void restoreHistory(JSONArray saved) { synchronized (lock) { history.clear(); if (saved != null) for (int i = 0; i < Math.min(30, saved.length()); i++) { JSONObject item = saved.optJSONObject(i); if (item != null) history.add(copy(item)); } } changed(); }
    public JSONObject discover() {
        execute(() -> {
            // Adapter enumeration can be slow. Never do it in state() under the
            // transfer lock, which is used by every progress update and file close.
            localAddresses = addresses();
            MulticastSocket udp = multicast;
            if (udp != null && discovery) {
                try {
                    JSONObject packet = info(); put(packet, "announce", true);
                    byte[] data = packet.toString().getBytes(StandardCharsets.UTF_8);
                    List<NetworkInterface> networks = refreshDiscoveryNetworks(udp);
                    boolean sent = false;
                    for (NetworkInterface network : networks) {
                        try { udp.setNetworkInterface(network); udp.send(new DatagramPacket(data, data.length, InetAddress.getByName(GROUP), 53317)); sent = true; }
                        catch (Exception ignored) { }
                    }
                    if (!sent) udp.send(new DatagramPacket(data, data.length, InetAddress.getByName(GROUP), 53317));
                }
                catch (Exception e) { if (running) setError(e); }
            }
            long now = System.currentTimeMillis();
            synchronized (lock) {
                for (Iterator<JSONObject> it = peers.values().iterator(); it.hasNext();) if (now - it.next().optLong("lastSeen") > 150000) it.remove();
                for (Iterator<Session> it = sessions.values().iterator(); it.hasNext();) {
                    Session s = it.next();
                    if (now - s.createdAt > 1800000 && !"transferring".equals(s.transfer.json.optString("status"))) {
                        if (!s.transfer.saved) finishLocked(s.transfer, "failed", "Transfer session expired");
                        it.remove();
                    }
                }
            }
            changed();
        }); return state();
    }
    public JSONObject addPeer(String host, int peerPort, String protocol) {
        final String address = host == null ? "" : host.trim();
        if (address.isEmpty() || address.length() > 253 || address.matches(".*[\\s/?#@].*") || peerPort < 1 || peerPort > 65535 || !("https".equals(protocol) || "http".equals(protocol))) throw new IllegalArgumentException("Enter a valid device IP address and port");
        final JSONObject peer = obj("host", address, "port", peerPort, "protocol", protocol);
        execute(() -> { try { register(peer); } catch (Exception e) { setError(e); } }); return state();
    }
    public JSONObject send(String peerId) {
        final JSONObject peer; final List<Source> sources; final Transfer transfer;
        synchronized (lock) {
            if (!running) throw new IllegalStateException("Start the service first");
            if (!peers.containsKey(peerId)) throw new IllegalArgumentException("Device is no longer available. Discover it again");
            if (selection.isEmpty()) throw new IllegalArgumentException("Select files or add a message first");
            peer = copy(peers.get(peerId)); sources = new ArrayList<>(selection);
            JSONArray files = new JSONArray(); long total = 0;
            for (Source s : sources) { JSONObject f = fileState(s.id, s.name, s.size); if (s.preview != null) put(f, "text", s.preview); files.put(f); total = addSize(total, s.size); }
            transfer = new Transfer(uuid(), "send", peer.optString("alias"), files, total); transfer.peer = peer; transfers.add(0, transfer);
        }
        changed();
        JSONObject capabilities = peer.optJSONObject("capabilities");
        if (capabilities != null && capabilities.opt("reverseReceive") instanceof Number && ((Number)capabilities.opt("reverseReceive")).doubleValue() == 1.0 && "https".equals(peer.optString("protocol"))) {
            try { enqueueReverse(peer, sources, transfer); }
            catch (Exception e) { finish(transfer, "failed", e.getMessage()); }
        } else if (!execute(() -> performSend(peer, sources, transfer))) finish(transfer, "failed", "Too many simultaneous connections. Try again");
        return state();
    }
    public JSONObject respond(String requestId, boolean accept) {
        synchronized (lock) { Pending p = pending.get(requestId); if (p != null) { p.accept = accept; p.ready.countDown(); } }
        changed(); return state();
    }
    public JSONObject cancelTransfer(String transferId) {
        Transfer transfer = null;
        synchronized (lock) { for (Transfer t : transfers) if (t.json.optString("id").equals(transferId) && !t.saved) { transfer = t; t.cancelled = true; finishLocked(t, "cancelled", null); break; } }
        final Transfer target = transfer;
        if (target != null) {
            // Interrupt reverse response writes even if every transport worker is occupied.
            for (Socket socket : target.sockets) close(socket);
            execute(() -> { disconnect(target); if (target.peer != null && target.remoteSession != null) cancelRemote(target); });
        }
        changed(); return state();
    }

    private JSONObject info() { return obj("alias", alias, "version", "2.2", "deviceModel", deviceModel, "deviceType", "mobile", "fingerprint", fingerprint, "port", port, "protocol", "https", "download", false, "capabilities", obj("reversePull", 1, "parallelFiles", MAX_PARALLEL_FILES)); }
    private void changed() {
        if (listener != null && !events.isShutdown() && eventQueued.compareAndSet(false, true)) {
            try { events.schedule(() -> {
                eventQueued.set(false); try { listener.onState(state()); } catch (Exception ignored) { }
            }, 80, TimeUnit.MILLISECONDS); }
            catch (RejectedExecutionException disposed) { eventQueued.set(false); }
        }
    }
    private boolean execute(Runnable task) { try { work.execute(task); return true; } catch (RejectedExecutionException busy) { setError(new IOException("Too many simultaneous connections. Try again")); return false; } }
    private void setError(Throwable e) { error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); changed(); }
    private static String validAlias(String name) { String n = name == null ? "Android phone" : name.trim(); if (n.isEmpty() || n.length() > 80) throw new IllegalArgumentException("Device name must be 1–80 characters"); return n; }
    private static JSONObject obj(Object... values) { JSONObject o = new JSONObject(); for (int i = 0; i < values.length; i += 2) put(o, (String) values[i], values[i+1]); return o; }
    private static void put(JSONObject o, String k, Object v) { try { o.put(k, v == null ? JSONObject.NULL : v); } catch (Exception e) { throw new IllegalArgumentException(e); } }
    private static JSONObject copy(JSONObject o) { try { return new JSONObject(o.toString()); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static String uuid() { return UUID.randomUUID().toString(); }
    private static String normalizeFingerprint(String f) { return f.replace(":", "").toUpperCase(Locale.ROOT); }
    private static String hex(byte[] data) { StringBuilder b = new StringBuilder(); for (byte v : data) b.append(String.format(Locale.ROOT, "%02X", v & 255)); return b.toString(); }
    private static String certFingerprint(Certificate cert) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded())); }
    private static List<String> addresses() {
        List<String> out = new ArrayList<>();
        try { Enumeration<NetworkInterface> ns = NetworkInterface.getNetworkInterfaces(); while (ns != null && ns.hasMoreElements()) { NetworkInterface ni = ns.nextElement(); if (!ni.isUp() || ni.isLoopback()) continue; Enumeration<InetAddress> a = ni.getInetAddresses(); while (a.hasMoreElements()) { InetAddress ip = a.nextElement(); if (ip instanceof Inet4Address && !ip.isLoopbackAddress()) out.add(ip.getHostAddress()); } } } catch (Exception ignored) { }
        return out;
    }
    private static JSONObject fileState(String id, String name, long size) { return obj("id", id, "name", name, "size", size, "transferred", 0L, "status", "waiting"); }
    private static long addSize(long a, long b) { if (b < 0 || a > 9007199254740991L - b) throw new IllegalArgumentException("Transfer is too large"); return a + b; }
    private static void close(Closeable c) { if (c != null) try { c.close(); } catch (Exception ignored) { } }
    private static final class HttpError extends IOException { final int status; HttpError(int status, String message) { super(message); this.status = status; } }
    private static final class Transfer {
        final JSONObject json; final JSONArray files; boolean saved; volatile boolean cancelled, aborting;
        final Set<Socket> sockets = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
        final Set<Closeable> sources = Collections.newSetFromMap(new ConcurrentHashMap<Closeable, Boolean>());
        final Semaphore sourceSlots = new Semaphore(MAX_PARALLEL_FILES);
        final Set<HttpURLConnection> connections = Collections.newSetFromMap(new ConcurrentHashMap<HttpURLConnection, Boolean>());
        JSONObject peer; volatile String remoteSession;
        Transfer(String id, String direction, String alias, JSONArray files, long total) { this.files = files; json = obj("id", id, "direction", direction, "peer", alias, "files", files, "status", "waiting", "total", total, "transferred", 0L, "progress", 0.0, "createdAt", System.currentTimeMillis()); }
    }
    private static final class Pending { final JSONObject json; final CountDownLatch ready = new CountDownLatch(1); volatile boolean accept; Pending(JSONObject json) { this.json = json; } }
    private static final class Session {
        final String remote; final JSONObject metadata, tokens; final Transfer transfer; final long createdAt = System.currentTimeMillis();
        Session(String remote, JSONObject metadata, JSONObject tokens, Transfer transfer) { this.remote = remote; this.metadata = metadata; this.tokens = tokens; this.transfer = transfer; }
    }
    private static final class ReverseOffer {
        final String id, recipient; final Transfer transfer; final JSONObject metadata, tokens = new JSONObject();
        final Map<String, Source> sources = new LinkedHashMap<>();
        long expiresAt = System.currentTimeMillis() + REVERSE_QUEUE_LIFETIME; boolean accepted;
        ReverseOffer(String recipient, Transfer transfer, List<Source> files, JSONObject metadata) {
            this.id = transfer.json.optString("id"); this.recipient = recipient; this.transfer = transfer; this.metadata = metadata;
            for (Source source : files) sources.put(source.id, source);
        }
    }
    private static final class ReverseTerminal {
        final String recipient, status;
        ReverseTerminal(String recipient, String status) { this.recipient = recipient; this.status = status; }
    }
    private void progress(Transfer t) { synchronized (lock) { progressLocked(t); } changed(); }
    private static void progressLocked(Transfer t) { long bytes = 0; for (int i = 0; i < t.files.length(); i++) bytes += t.files.optJSONObject(i).optLong("transferred"); put(t.json, "transferred", bytes); long total = t.json.optLong("total"); put(t.json, "progress", total > 0 ? Math.min(1.0, (double) bytes / total) : ("completed".equals(t.json.optString("status")) ? 1.0 : 0.0)); }
    private void finish(Transfer t, String status, String message) { synchronized (lock) { finishLocked(t, status, message); } changed(); }
    private void finishLocked(Transfer t, String status, String message) {
        if (t.saved) return; t.saved = true; if ("failed".equals(status) || "cancelled".equals(status)) t.cancelled = true;
        put(t.json, "status", status); if (message != null) put(t.json, "error", message);
        ReverseOffer offer = reverseOffers.remove(t.json.optString("id"));
        if (offer != null) {
            reverseTerminals.put(offer.id, new ReverseTerminal(offer.recipient, status));
            while (reverseTerminals.size() > 64) reverseTerminals.remove(reverseTerminals.keySet().iterator().next());
            lock.notifyAll();
        }
        progressLocked(t); if ("completed".equals(status)) put(t.json, "progress", 1.0);
        history.add(0, copy(t.json)); while (history.size() > 30) history.remove(history.size() - 1);
        while (transfers.size() > 100) { Transfer oldest = transfers.get(transfers.size()-1); if (!oldest.saved) break; transfers.remove(transfers.size()-1); }
    }
    private static void disconnect(Transfer t) { for (HttpURLConnection c : t.connections) c.disconnect(); for (Socket socket : t.sockets) close(socket); for (Closeable source : t.sources) close(source); }

    private void startDiscovery() {
        MulticastSocket candidate = null;
        try {
            final MulticastSocket udp = new MulticastSocket(null); candidate = udp;
            udp.setReuseAddress(true); udp.bind(new InetSocketAddress(53317)); udp.setTimeToLive(1);
            refreshDiscoveryNetworks(udp);
            multicast = udp; discovery = true;
            Thread receiver = THREADS.newThread(() -> {
                byte[] buffer = new byte[65507];
                while (running && multicast == udp) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buffer, buffer.length); udp.receive(packet);
                        JSONObject data = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                        if (!validPeer(data) || fingerprint.equals(normalizeFingerprint(data.optString("fingerprint")))) continue;
                        String host = packet.getAddress().getHostAddress(); remember(data, host);
                        if (data.optBoolean("announce")) {
                            JSONObject target = copy(data); put(target, "host", host);
                            execute(() -> { try { register(target); } catch (Exception ignored) { } });
                        }
                    } catch (SocketException closed) { break; }
                    catch (Exception ignored) { }
                }
            }); receiver.start();
            discover();
        } catch (Exception e) { if (candidate != null) candidate.close(); discovery = false; error = "Discovery: " + e.getMessage() + ". Add the PC by IP address."; changed(); }
    }
    private static List<NetworkInterface> multicastNetworks() throws SocketException {
        List<NetworkInterface> networks = new ArrayList<>();
        Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
        while (all != null && all.hasMoreElements()) {
            NetworkInterface network = all.nextElement();
            if (!network.isUp() || network.isLoopback()) continue;
            boolean ipv4 = false; Enumeration<InetAddress> addresses = network.getInetAddresses();
            while (addresses.hasMoreElements()) if (addresses.nextElement() instanceof Inet4Address) { ipv4 = true; break; }
            // Some Android hotspot adapters report multicast support incorrectly.
            // Attempting the socket operation is more reliable than excluding them.
            if (ipv4) networks.add(network);
        }
        return networks;
    }
    private static String networkKey(NetworkInterface network) throws SocketException {
        List<String> addresses = new ArrayList<>(); Enumeration<InetAddress> values = network.getInetAddresses();
        while (values.hasMoreElements()) { InetAddress address = values.nextElement(); if (address instanceof Inet4Address) addresses.add(address.getHostAddress()); }
        Collections.sort(addresses); return network.getName() + "|" + String.join(",", addresses);
    }
    private List<NetworkInterface> refreshDiscoveryNetworks(MulticastSocket udp) throws Exception {
        List<NetworkInterface> current = multicastNetworks(); Map<String, NetworkInterface> next = new LinkedHashMap<>();
        for (NetworkInterface network : current) next.put(networkKey(network), network);
        InetSocketAddress group = new InetSocketAddress(GROUP, 53317);
        synchronized (discoveryNetworks) {
            for (Iterator<Map.Entry<String, NetworkInterface>> it = discoveryNetworks.entrySet().iterator(); it.hasNext();) {
                Map.Entry<String, NetworkInterface> entry = it.next(); if (next.containsKey(entry.getKey())) continue;
                try { udp.leaveGroup(group, entry.getValue()); } catch (Exception ignored) { } it.remove();
            }
            for (Map.Entry<String, NetworkInterface> entry : next.entrySet()) {
                if (discoveryNetworks.containsKey(entry.getKey())) continue;
                try { udp.joinGroup(group, entry.getValue()); discoveryNetworks.put(entry.getKey(), entry.getValue()); } catch (Exception ignored) { }
            }
            if (!discoveryNetworks.isEmpty() && defaultMulticastMembership) {
                try { udp.leaveGroup(InetAddress.getByName(GROUP)); } catch (Exception ignored) { }
                defaultMulticastMembership = false;
            } else if (discoveryNetworks.isEmpty() && !defaultMulticastMembership) {
                udp.joinGroup(InetAddress.getByName(GROUP)); defaultMulticastMembership = true;
            }
        }
        return current;
    }
    private static boolean validPeer(JSONObject p) {
        return p != null && p.opt("alias") instanceof String && !p.optString("alias").isEmpty() && p.optString("alias").length() <= 120
            && normalizeFingerprint(p.optString("fingerprint")).matches("[A-F0-9]{64}")
            && ("https".equals(p.optString("protocol")) || "http".equals(p.optString("protocol")))
            && p.opt("port") instanceof Number && ((Number)p.opt("port")).doubleValue() == p.optInt("port") && p.optInt("port") > 0 && p.optInt("port") <= 65535;
    }
    private JSONObject remember(JSONObject data, String host) {
        if (!validPeer(data)) return null;
        String fp = normalizeFingerprint(data.optString("fingerprint")); if (fingerprint.equals(fp)) return null;
        JSONObject peer = obj("id", fp, "alias", data.optString("alias"), "deviceModel", data.optString("deviceModel", "Device"), "deviceType", data.optString("deviceType", "desktop"),
            "host", host, "port", data.optInt("port"), "protocol", data.optString("protocol"), "fingerprint", fp, "lastSeen", System.currentTimeMillis());
        JSONObject capabilities = data.optJSONObject("capabilities");
        if (capabilities != null) put(peer, "capabilities", copy(capabilities));
        synchronized (lock) { peers.put(fp, peer); }
        changed(); return peer;
    }
    private JSONObject register(JSONObject peer) throws Exception {
        Result response = request(peer, "/register", info(), null, null, 5000);
        if (!validPeer(response.data)) throw new IOException("Device returned invalid information");
        if (response.fingerprint != null && !response.fingerprint.equals(normalizeFingerprint(response.data.optString("fingerprint")))) throw new IOException("Device certificate does not match its identity");
        JSONObject data = copy(response.data); put(data, "port", peer.optInt("port")); put(data, "protocol", peer.optString("protocol"));
        JSONObject result = remember(data, peer.optString("host"));
        if (result == null) throw new IOException("This is this device. Enter another device's address");
        error = null; return result;
    }

    private void acceptLoop(SSLServerSocket listenerSocket) {
        while (running && server == listenerSocket) {
            Socket socket = null;
            try {
                socket = listenerSocket.accept(); socket.setSoTimeout(30000); socket.setTcpNoDelay(true); accepted.add(socket);
                final SSLSocket client = (SSLSocket) socket;
                try { work.execute(() -> serve(client)); }
                catch (RejectedExecutionException overloaded) { accepted.remove(client); close(client); }
            } catch (Exception e) { close(socket); if (running && server == listenerSocket) setError(e); }
        }
    }
    private static final class Request {
        String method, path, remote; long length; InputStream input; OutputStream output; SSLSocket socket; boolean responseStarted;
        final Map<String, String> query = new HashMap<>();
    }
    private static String line(InputStream input, int[] remaining) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int previous = -1;
        while (true) {
            int c = input.read(); if (c < 0) throw new EOFException("Incomplete HTTP headers");
            if (--remaining[0] < 0) throw new HttpError(431, "HTTP headers are too large");
            if (previous == '\r' && c == '\n') { byte[] raw = bytes.toByteArray(); return new String(raw, 0, raw.length-1, StandardCharsets.US_ASCII); }
            if (c == '\n' || previous == '\r') throw new HttpError(400, "Malformed HTTP headers");
            bytes.write(c); previous = c;
        }
    }
    private Request readRequest(SSLSocket socket) throws Exception {
        Request r = new Request(); r.socket = socket; r.input = new BufferedInputStream(socket.getInputStream(), TRANSFER_BUFFER_SIZE); r.output = new BufferedOutputStream(socket.getOutputStream(), TRANSFER_BUFFER_SIZE); r.remote = socket.getInetAddress().getHostAddress();
        int[] remaining = {32768}; String[] first = line(r.input, remaining).split(" ");
        if (first.length != 3 || !first[1].startsWith("/") || !("HTTP/1.1".equals(first[2]) || "HTTP/1.0".equals(first[2]))) throw new HttpError(400, "Invalid HTTP request");
        r.method = first[0]; URI uri = new URI(first[1]); r.path = uri.getPath();
        if (uri.getRawQuery() != null) for (String part : uri.getRawQuery().split("&")) { String[] kv = part.split("=", 2); String key = URLDecoder.decode(kv[0], "UTF-8"); if (r.query.containsKey(key)) throw new HttpError(400, "Duplicate query parameter"); r.query.put(key, kv.length > 1 ? URLDecoder.decode(kv[1], "UTF-8") : ""); }
        Map<String, String> headers = new HashMap<>(); String header;
        while (!(header = line(r.input, remaining)).isEmpty()) {
            int colon = header.indexOf(':'); if (colon < 1) throw new HttpError(400, "Invalid HTTP header");
            String key = header.substring(0, colon).toLowerCase(Locale.ROOT).trim();
            if (headers.containsKey(key) && ("content-length".equals(key) || "transfer-encoding".equals(key))) throw new HttpError(400, "Duplicate body framing header");
            headers.put(key, header.substring(colon+1).trim());
        }
        if (headers.containsKey("transfer-encoding")) throw new HttpError(400, "Content-Length is required; chunked uploads are unsupported");
        String length = headers.get("content-length");
        if (length != null && !length.matches("[0-9]{1,16}")) throw new HttpError(400, "Invalid Content-Length");
        try { r.length = length == null ? 0 : Long.parseLong(length); } catch (NumberFormatException e) { throw new HttpError(400, "Invalid Content-Length"); }
        if (r.length > 9007199254740991L) throw new HttpError(413, "Request is too large");
        if (headers.containsKey("expect")) { r.output.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); r.output.flush(); }
        return r;
    }
    private void serve(SSLSocket socket) {
        Request req = null;
        try { socket.startHandshake(); req = readRequest(socket); handle(req); }
        catch (Exception e) {
            try { if (req != null && !req.responseStarted) reply(req, e instanceof HttpError ? ((HttpError)e).status : 500, obj("message", e.getMessage() == null ? "Transfer failed" : e.getMessage())); } catch (Exception ignored) { }
        } finally { accepted.remove(socket); close(socket); }
    }
    private static JSONObject readJson(Request r) throws Exception {
        if (r.length <= 0 || r.length > MAX_JSON) throw new HttpError(r.length > MAX_JSON ? 413 : 400, "Invalid JSON request size");
        byte[] bytes = new byte[(int)r.length]; int offset = 0;
        while (offset < bytes.length) { int n = r.input.read(bytes, offset, bytes.length-offset); if (n < 0) throw new HttpError(400, "Incomplete request body"); offset += n; }
        try { return new JSONObject(new String(bytes, StandardCharsets.UTF_8)); } catch (Exception e) { throw new HttpError(400, "Invalid JSON"); }
    }
    private static void reply(Request r, int status, JSONObject body) throws Exception {
        byte[] bytes = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
        String phrase = status >= 200 && status < 300 ? "OK" : "Error";
        String header = "HTTP/1.1 " + status + " " + phrase + "\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n";
        r.responseStarted = true; r.output.write(header.getBytes(StandardCharsets.US_ASCII)); r.output.write(bytes); r.output.flush();
    }
    private void checkIdentity(Request r, JSONObject data) throws Exception {
        if (!validPeer(data)) throw new HttpError(400, "Invalid device information");
        Certificate[] certificates = r.socket.getSession().getPeerCertificates();
        if (certificates.length == 0 || !certFingerprint(certificates[0]).equals(normalizeFingerprint(data.optString("fingerprint")))) throw new HttpError(403, "Certificate fingerprint does not match device identity");
    }
    private void handle(Request r) throws Exception {
        if ("GET".equals(r.method) && (API+"/info").equals(r.path)) { reply(r, 200, info()); return; }
        if ("POST".equals(r.method) && (API+"/register").equals(r.path)) { JSONObject data = readJson(r); checkIdentity(r, data); remember(data, r.remote); reply(r, 200, info()); return; }
        if ("POST".equals(r.method) && (REVERSE+"/poll").equals(r.path)) { pollReverse(r); return; }
        if ("POST".equals(r.method) && (REVERSE+"/decision").equals(r.path)) { decideReverse(r); return; }
        if ("POST".equals(r.method) && (REVERSE+"/file").equals(r.path)) { serveReverseFile(r); return; }
        if ("POST".equals(r.method) && (API+"/prepare-upload").equals(r.path)) { prepare(r); return; }
        if ("POST".equals(r.method) && (API+"/upload").equals(r.path)) { upload(r); return; }
        if ("POST".equals(r.method) && (API+"/cancel").equals(r.path)) {
            Session session; synchronized (lock) { session = sessions.get(r.query.get("sessionId")); }
            if (session == null || !session.remote.equals(r.remote)) throw new HttpError(403, "Invalid session");
            session.transfer.cancelled = true; disconnect(session.transfer); finish(session.transfer, "cancelled", null); reply(r, 200, null); return;
        }
        reply(r, 404, obj("message", "Unknown endpoint"));
    }
    private static JSONObject sourceMetadata(List<Source> sources) {
        JSONObject files = new JSONObject(); long metadataBytes = 2;
        for (Source source : sources) {
            JSONObject metadata = obj("id", source.id, "fileName", source.name, "size", source.size, "fileType", source.mime, "preview", source.preview);
            metadataBytes += metadata.toString().getBytes(StandardCharsets.UTF_8).length + source.id.length() + 4L;
            if (metadataBytes > MAX_JSON - 1024) throw new IllegalArgumentException("Transfer metadata is too large. Send fewer messages at once");
            put(files, source.id, metadata);
        }
        return files;
    }
    private void enqueueReverse(JSONObject peer, List<Source> sources, Transfer transfer) throws Exception {
        JSONObject metadata = sourceMetadata(sources);
        if (obj("info", info(), "files", metadata).toString().getBytes(StandardCharsets.UTF_8).length > MAX_JSON - 1024) throw new IOException("Transfer metadata is too large. Send fewer messages at once");
        expireReverseOffers();
        synchronized (lock) {
            if (!running || transfer.cancelled || transfer.saved) throw new IOException("Transfer cancelled");
            if (reverseOffers.size() >= 32) throw new IOException("Too many waiting transfers. Cancel an earlier transfer and try again");
            ReverseOffer offer = new ReverseOffer(normalizeFingerprint(peer.optString("fingerprint")), transfer, sources, metadata);
            reverseOffers.put(offer.id, offer);
            put(transfer.json, "connectionMode", "reverse");
            put(transfer.json, "statusDetail", "Waiting for the PC. Keep Super Send open on your PC");
            lock.notifyAll();
        }
        changed();
    }
    private void expireReverseOffers() {
        List<Transfer> expired = new ArrayList<>();
        synchronized (lock) {
            long now = System.currentTimeMillis();
            for (ReverseOffer offer : new ArrayList<>(reverseOffers.values())) if (now >= offer.expiresAt) {
                finishLocked(offer.transfer, "failed", offer.accepted ? "Transfer session expired" : "The PC did not pick up the transfer. Open Super Send on your PC and try again");
                expired.add(offer.transfer);
            }
        }
        if (!expired.isEmpty() && !execute(() -> { for (Transfer transfer : expired) disconnect(transfer); })) {
            // Even an overloaded receiver must interrupt network writes without blocking the event scheduler on source I/O.
            for (Transfer transfer : expired) for (Socket socket : transfer.sockets) close(socket);
        }
        if (!expired.isEmpty()) changed();
    }
    private void pollReverse(Request r) throws Exception {
        JSONObject data = readJson(r), identity = data.optJSONObject("info"); checkIdentity(r, identity);
        String recipient = normalizeFingerprint(identity.optString("fingerprint")); remember(identity, r.remote);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2); JSONObject response = null;
        synchronized (lock) {
            while (running) {
                long now = System.currentTimeMillis();
                for (ReverseOffer offer : reverseOffers.values()) if (offer.recipient.equals(recipient) && !offer.transfer.saved && !offer.transfer.cancelled && now < offer.expiresAt) {
                    if (!offer.accepted) put(offer.transfer.json, "statusDetail", "Waiting for approval on the PC");
                    response = obj("offer", obj("id", offer.id, "info", info(), "files", copy(offer.metadata), "expiresAt", offer.expiresAt));
                    break;
                }
                if (response != null) break;
                long remaining = deadline - System.nanoTime(); if (remaining <= 0) break;
                TimeUnit.NANOSECONDS.timedWait(lock, remaining);
            }
        }
        if (response != null) changed();
        reply(r, response == null ? 204 : 200, response);
    }
    private ReverseOffer requireReverseOffer(JSONObject data, String recipient) throws HttpError {
        String id = data.optString("offerId", "");
        if (id.isEmpty() || id.length() > 200) throw new HttpError(400, "Invalid transfer offer");
        ReverseOffer offer = reverseOffers.get(id);
        if (offer == null) throw new HttpError(404, "Transfer offer is no longer available");
        if (!offer.recipient.equals(recipient)) throw new HttpError(403, "Transfer belongs to a different device");
        if (offer.transfer.saved || offer.transfer.cancelled || System.currentTimeMillis() >= offer.expiresAt) throw new HttpError(409, "Transfer offer is no longer available");
        return offer;
    }
    private static boolean allReverseFilesServed(ReverseOffer offer) {
        for (int i = 0; i < offer.transfer.files.length(); i++) if (!"completed".equals(offer.transfer.files.optJSONObject(i).optString("status"))) return false;
        return true;
    }
    private void decideReverse(Request r) throws Exception {
        JSONObject data = readJson(r), identity = data.optJSONObject("info"); checkIdentity(r, identity);
        String recipient = normalizeFingerprint(identity.optString("fingerprint")), action = data.optString("action", "");
        if (!("accept".equals(action) || "decline".equals(action) || "cancel".equals(action) || "complete".equals(action) || "fail".equals(action))) throw new HttpError(400, "Invalid transfer decision");
        JSONObject response = null; Transfer disconnected = null;
        synchronized (lock) {
            String id = data.optString("offerId", ""); ReverseTerminal terminal = reverseTerminals.get(id);
            if (terminal != null) {
                if (!terminal.recipient.equals(recipient)) throw new HttpError(403, "Transfer belongs to a different device");
                if (!("complete".equals(action) && "completed".equals(terminal.status))) throw new HttpError(409, "Transfer is already " + terminal.status);
            } else {
            ReverseOffer offer = requireReverseOffer(data, recipient); Transfer transfer = offer.transfer;
            if ("accept".equals(action)) {
                if (!offer.accepted) {
                    for (String fileId : offer.sources.keySet()) put(offer.tokens, fileId, uuid());
                    offer.accepted = true; offer.expiresAt = System.currentTimeMillis() + REVERSE_SESSION_LIFETIME;
                    put(transfer.json, "status", "transferring"); put(transfer.json, "statusDetail", "The PC is receiving your files");
                }
                response = obj("sessionId", offer.id, "files", copy(offer.tokens), "capabilities", obj("parallelFiles", MAX_PARALLEL_FILES));
            } else if ("complete".equals(action)) {
                if (!offer.accepted) throw new HttpError(409, "The PC has not accepted the transfer");
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                while (!transfer.saved && !transfer.cancelled && !allReverseFilesServed(offer)) {
                    long remaining = deadline - System.nanoTime(); if (remaining <= 0) break;
                    TimeUnit.NANOSECONDS.timedWait(lock, remaining);
                }
                if (transfer.saved || transfer.cancelled || !allReverseFilesServed(offer)) throw new HttpError(409, "Files have not finished transferring");
                put(transfer.json, "statusDetail", "Saved on the PC"); finishLocked(transfer, "completed", null);
            } else {
                String status = "decline".equals(action) ? "rejected" : "cancel".equals(action) ? "cancelled" : "failed";
                String message = data.optString("message", ""); if (message.length() > 512) message = message.substring(0, 512);
                if (message.isEmpty()) message = "decline".equals(action) ? "The PC declined the transfer" : "fail".equals(action) ? "The PC could not save the transfer" : null;
                transfer.cancelled = true;
                finishLocked(transfer, status, message); disconnected = transfer;
            }
            }
        }
        if (disconnected != null) disconnect(disconnected);
        changed(); reply(r, 200, response);
    }
    private void serveReverseFile(Request r) throws Exception {
        JSONObject data = readJson(r), identity = data.optJSONObject("info"); checkIdentity(r, identity);
        final ReverseOffer offer; final Transfer transfer; final Source source; final JSONObject file;
        synchronized (lock) {
            offer = requireReverseOffer(data, normalizeFingerprint(identity.optString("fingerprint")));
            String fileId = data.optString("fileId", ""), token = data.optString("token", "");
            if (!offer.accepted || token.isEmpty() || !token.equals(offer.tokens.optString(fileId, ""))) throw new HttpError(403, "Invalid transfer token");
            source = offer.sources.get(fileId); transfer = offer.transfer; file = findFile(transfer, fileId);
            if (source == null || file == null || !"waiting".equals(file.optString("status"))) throw new HttpError(409, "File has already been requested");
            put(file, "status", "transferring"); transfer.sockets.add(r.socket); offer.expiresAt = System.currentTimeMillis() + REVERSE_SESSION_LIFETIME;
            put(transfer.json, "statusDetail", "The PC is receiving your files");
        }
        changed(); InputStream input = null;boolean sourceSlot = false;
        try {
            sourceSlot = transfer.sourceSlots.tryAcquire(30, TimeUnit.SECONDS);
            if (!sourceSlot) throw new IOException("Too many open source files");
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            input = source.opener.open(); if (input == null) throw new IOException("Unable to open " + source.name);
            transfer.sources.add(input);
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            String header = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + source.size + "\r\n\r\n";
            r.responseStarted = true; r.output.write(header.getBytes(StandardCharsets.US_ASCII));
            final long[] lastEvent = {System.nanoTime()};
            long count = copyFile(input, r.output, source.size, true, transfer, (buffer, n, transferred) -> {
                long now = System.nanoTime();
                if (now-lastEvent[0] >= PROGRESS_INTERVAL_NANOS) {
                    synchronized (lock) { put(file, "transferred", transferred); progressLocked(transfer); offer.expiresAt = System.currentTimeMillis() + REVERSE_SESSION_LIFETIME; }
                    changed(); lastEvent[0] = now;
                }
            });
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            r.output.flush();
            synchronized (lock) {
                if (transfer.cancelled || transfer.saved) throw new IOException("Transfer cancelled");
                put(file, "transferred", count); put(file, "status", "completed"); progressLocked(transfer);
                if (allReverseFilesServed(offer)) put(transfer.json, "statusDetail", "Waiting for the PC to confirm the files were saved");
                lock.notifyAll();
            }
            changed();
        } catch (Exception e) {
            synchronized (lock) { put(file, "status", transfer.cancelled ? "cancelled" : "failed"); finishLocked(transfer, transfer.cancelled ? "cancelled" : "failed", e.getMessage()); lock.notifyAll(); }
            for (Socket socket : transfer.sockets) if (socket != r.socket) close(socket);
            changed(); throw e;
        } finally { transfer.sockets.remove(r.socket); if (input != null) { transfer.sources.remove(input); close(input); } if (sourceSlot) transfer.sourceSlots.release(); }
    }
    private void prepare(Request r) throws Exception {
        JSONObject data = readJson(r), identity = data.optJSONObject("info"); checkIdentity(r, identity);
        JSONObject metadata = data.optJSONObject("files");
        if (metadata == null || metadata.length() == 0 || metadata.length() > 1000) throw new HttpError(400, "Select between 1 and 1000 files");
        JSONArray publicFiles = new JSONArray(), transferFiles = new JSONArray(); long total = 0;
        List<String> ids = new ArrayList<>(); Iterator<String> keys = metadata.keys();
        while (keys.hasNext()) {
            String id = keys.next(); JSONObject file = metadata.optJSONObject(id);
            if (id.isEmpty() || id.length() > 200 || file == null || !(file.opt("size") instanceof Number) || !(file.opt("fileType") instanceof String) || !(file.opt("fileName") instanceof String)) throw new HttpError(400, "Invalid file metadata");
            Number rawSize = (Number)file.opt("size"); long size = rawSize.longValue();
            if (size < 0 || size > 9007199254740991L || rawSize.doubleValue() != (double)size) throw new HttpError(400, "Invalid file size");
            try { safeRelative(file.optString("fileName")); total = addSize(total, size); } catch (IllegalArgumentException e) { throw new HttpError(400, e.getMessage()); }
            if (file.has("sha256") && !file.isNull("sha256") && !file.optString("sha256").matches("(?i)[a-f0-9]{64}")) throw new HttpError(400, "Invalid checksum");
            JSONObject view = copy(file); put(view, "id", id); publicFiles.put(view); ids.add(id);
            transferFiles.put(fileState(id, file.optString("fileName"), size));
        }
        String requestId = uuid(); Pending request = new Pending(obj("id", requestId, "alias", identity.optString("alias"), "host", r.remote, "files", publicFiles));
        synchronized (lock) {
            if (!pending.isEmpty()) throw new HttpError(409, "Another transfer is in progress");
            for (Session s : sessions.values()) if (!s.transfer.saved) throw new HttpError(409, "Another transfer is in progress");
            pending.put(requestId, request);
        }
        remember(identity, r.remote); changed();
        boolean accepted; String sessionId = uuid(); JSONObject tokens = new JSONObject(); for (String id : ids) put(tokens, id, uuid());
        Transfer transfer = new Transfer(sessionId, "receive", identity.optString("alias"), transferFiles, total);
        try {
            if (autoAccept) { request.accept = true; request.ready.countDown(); }
            request.ready.await(120, TimeUnit.SECONDS);
            synchronized (lock) {
                accepted = request.accept && running;
                if (accepted) { transfers.add(0, transfer); sessions.put(sessionId, new Session(r.remote, metadata, tokens, transfer)); }
                pending.remove(requestId);
            }
        } finally { synchronized (lock) { pending.remove(requestId); } changed(); }
        if (!accepted) { reply(r, 403, obj("message", "Transfer declined")); return; }
        changed(); reply(r, 200, obj("sessionId", sessionId, "files", tokens, "capabilities", obj("parallelFiles", MAX_PARALLEL_FILES)));
    }
    private void upload(Request r) throws Exception {
        final Session session; final JSONObject file, metadata; final Transfer transfer;
        String id = r.query.get("fileId"), token = r.query.get("token");
        synchronized (lock) {
            session = sessions.get(r.query.get("sessionId"));
            if (session == null || !session.remote.equals(r.remote) || token == null || !token.equals(session.tokens.optString(id == null ? "" : id, ""))) throw new HttpError(403, "Invalid session or token");
            transfer = session.transfer; file = findFile(transfer, id); metadata = session.metadata.optJSONObject(id);
            if (file == null || metadata == null || transfer.saved || transfer.cancelled || !"waiting".equals(file.optString("status"))) throw new HttpError(409, "File is not available for upload");
            if (r.length != file.optLong("size")) throw new HttpError(400, "File size does not match");
            put(file, "status", "transferring"); put(transfer.json, "status", "transferring"); transfer.sockets.add(r.socket);
        }
        changed(); Destination destination = null; OutputStream output = null;
        try {
            String name = safeRelative(metadata.optString("fileName"));
            destination = storage == null ? reserveFile(name) : storage.create(name);
            if (destination == null) throw new IOException("Unable to create the destination file");
            output = destination.output(); if (output == null) throw new IOException("Unable to open the destination file");
            output = new BufferedOutputStream(output, TRANSFER_BUFFER_SIZE);
            // TLS already authenticates every byte. Hash only when a sender supplies a
            // checksum to compare; previously the normal path computed and discarded it.
            String expected = metadata.optString("sha256", "");
            MessageDigest digest = expected.isEmpty() || "null".equals(expected) ? null : MessageDigest.getInstance("SHA-256");
            ByteArrayOutputStream text = "text/plain".equals(metadata.optString("fileType")) && r.length <= 1048576 ? new ByteArrayOutputStream() : null;
            final long[] lastEvent = {System.nanoTime()};
            long count = copyFile(r.input, output, r.length, false, transfer, (buffer, n, transferred) -> {
                if (digest != null) digest.update(buffer, 0, n); if (text != null) text.write(buffer, 0, n);
                long now = System.nanoTime();
                if (now-lastEvent[0] >= PROGRESS_INTERVAL_NANOS) {
                    synchronized (lock) { put(file, "transferred", transferred); progressLocked(transfer); }
                    changed(); lastEvent[0] = now;
                }
            });
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            output.flush(); output.close(); output = null;
            if (digest != null && !hex(digest.digest()).equalsIgnoreCase(expected)) throw new HttpError(422, "Checksum mismatch");
            destination.commit();
            boolean complete = true;
            synchronized (lock) {
                if (transfer.cancelled) throw new IOException("Transfer cancelled");
                put(file, "transferred", count); put(file, "status", "completed"); put(file, "path", destination.location());
                if (text != null) put(file, "text", new String(text.toByteArray(), StandardCharsets.UTF_8));
                for (int i = 0; i < transfer.files.length(); i++) if (!"completed".equals(transfer.files.optJSONObject(i).optString("status"))) complete = false;
            }
            if (complete) finish(transfer, "completed", null); else progress(transfer);
            reply(r, 200, null);
        } catch (Exception e) {
            close(output); if (destination != null) try { destination.abort(); } catch (Exception ignored) { }
            synchronized (lock) { put(file, "status", transfer.cancelled ? "cancelled" : "failed"); }
            finish(transfer, transfer.cancelled ? "cancelled" : "failed", e.getMessage());
            for (Socket socket : transfer.sockets) if (socket != r.socket) close(socket);
            throw e;
        } finally { transfer.sockets.remove(r.socket); }
    }
    private static JSONObject findFile(Transfer t, String id) { for (int i = 0; i < t.files.length(); i++) { JSONObject f = t.files.optJSONObject(i); if (f.optString("id").equals(id)) return f; } return null; }
    /** Returns a portable relative path; every receiver uses the same path checks. */
    public static String safeRelative(String name) {
        if (name == null || name.isEmpty() || name.length() > 1000 || name.startsWith("/") || name.startsWith("\\") || name.matches("(?i)^[a-z]:.*")) throw new IllegalArgumentException("Invalid file name");
        String[] parts = name.replace('\\', '/').split("/", -1); StringBuilder result = new StringBuilder();
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) throw new IllegalArgumentException("Unsafe file path");
            String clean = part.replaceAll("[<>:\"|?*\\x00-\\x1f]", "_").replaceAll("[. ]+$", "");
            if (clean.isEmpty() || clean.matches("(?i)^(con|prn|aux|nul|conin\\$|conout\\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\\..*)?$") || clean.length() > 255) throw new IllegalArgumentException("Reserved or invalid file name");
            if (result.length() > 0) result.append('/'); result.append(clean);
        }
        return result.toString();
    }
    private Destination reserveFile(String relativeName) throws Exception {
        if (!receiveDir.isDirectory() && !receiveDir.mkdirs() && !receiveDir.isDirectory()) throw new IOException("Unable to create the receive directory");
        File root = receiveDir.getCanonicalFile(); String rootPrefix = root.getPath() + File.separator;
        String[] parts = relativeName.split("/"); File parent = root;
        for (int i = 0; i < parts.length-1; i++) {
            File next = new File(parent, parts[i]);
            String canonical = next.getCanonicalPath(); if (!canonical.startsWith(rootPrefix)) throw new IOException("Destination points outside the receive directory");
            if (!next.isDirectory() && !next.mkdir() && !next.isDirectory()) throw new IOException("Unable to create destination folder");
            parent = next.getCanonicalFile(); if (!parent.getPath().startsWith(rootPrefix)) throw new IOException("Unsafe destination folder");
        }
        String fileName = parts[parts.length-1]; int dot = fileName.lastIndexOf('.'); if (dot <= 0) dot = fileName.length();
        String base = fileName.substring(0, dot), extension = fileName.substring(dot);
        for (int i = 0; i < 10000; i++) {
            final File candidate = new File(parent, i == 0 ? fileName : base+" ("+i+")"+extension);
            if (!candidate.getCanonicalPath().startsWith(rootPrefix)) throw new IOException("Unsafe destination");
            if (!candidate.createNewFile()) continue;
            return new Destination() {
                private OutputStream output;
                public synchronized OutputStream output() throws Exception { if (output == null) output = new FileOutputStream(candidate); return output; }
                public String location() { return candidate.getAbsolutePath(); }
                public synchronized void commit() throws Exception { if (output != null) { output.close(); output = null; } }
                public synchronized void abort() { close(output); output = null; candidate.delete(); }
            };
        }
        throw new IOException("Too many files with the same name");
    }

    private static final class Result { final int status; final JSONObject data; final String fingerprint; Result(int status, JSONObject data, String fingerprint) { this.status = status; this.data = data; this.fingerprint = fingerprint; } }
    private Result request(JSONObject peer, String route, JSONObject json, Source source, Transfer transfer, int timeout) throws Exception {
        String protocol = peer.optString("protocol"), host = peer.optString("host");
        if (!("https".equals(protocol) || "http".equals(protocol))) throw new IOException("Unsupported device protocol");
        HttpURLConnection connection = (HttpURLConnection)new URL(protocol, host, peer.optInt("port"), API+route).openConnection();
        byte[] body = json == null ? null : json.toString().getBytes(StandardCharsets.UTF_8);
        if (body != null && body.length > MAX_JSON) throw new IOException("Transfer metadata is too large. Send fewer messages at once");
        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false); connection.setConnectTimeout(Math.min(timeout, 10000)); connection.setReadTimeout(timeout);
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Connection", "close");
        connection.setRequestProperty("Content-Type", source == null ? "application/json" : "application/octet-stream");
        connection.setFixedLengthStreamingMode(source != null ? source.size : body == null ? 0L : body.length);
        if (connection instanceof HttpsURLConnection) { HttpsURLConnection https = (HttpsURLConnection)connection; https.setSSLSocketFactory(tls.getSocketFactory()); https.setHostnameVerifier((hostname, session) -> true); }
        if (transfer != null) transfer.connections.add(connection);
        try {
            if (transfer != null && (transfer.cancelled || transfer.aborting)) throw new IOException("Transfer stopped");
            connection.connect();
            String actualFingerprint = null;
            if (connection instanceof HttpsURLConnection) {
                Certificate[] certificates = ((HttpsURLConnection)connection).getServerCertificates();
                if (certificates.length == 0) throw new IOException("Device did not present a certificate");
                actualFingerprint = certFingerprint(certificates[0]); String expected = normalizeFingerprint(peer.optString("fingerprint", ""));
                if (!expected.isEmpty() && !expected.equals(actualFingerprint)) throw new IOException("Device certificate changed. Discover the device again");
            }
            // Validate the peer certificate before getOutputStream can send body bytes.
            try (OutputStream output = new BufferedOutputStream(connection.getOutputStream(), TRANSFER_BUFFER_SIZE)) {
                if (source != null) {
                    try (InputStream input = source.opener.open()) {
                        if (input == null) throw new IOException("Unable to open " + source.name);
                        if (transfer != null) transfer.sources.add(input);
                        try {
                        final long[] lastEvent = {System.nanoTime()};
                        JSONObject file = transfer == null ? null : findFile(transfer, source.id);
                        long count = copyFile(input, output, source.size, true, transfer, (buffer, n, transferred) -> {
                            if (file != null) {
                                long now = System.nanoTime();
                                if (now-lastEvent[0] >= PROGRESS_INTERVAL_NANOS) {
                                    synchronized (lock) { put(file, "transferred", transferred); progressLocked(transfer); }
                                    changed(); lastEvent[0] = now;
                                }
                            }
                        });
                        if (file != null) { synchronized (lock) { put(file, "transferred", count); progressLocked(transfer); } }
                        } finally { if (transfer != null) transfer.sources.remove(input); }
                    }
                } else if (body != null) output.write(body);
            }
            int status = connection.getResponseCode();
            InputStream response = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream raw = new ByteArrayOutputStream();
            if (response != null) try (InputStream input = response) { byte[] buffer = new byte[8192]; int n; while ((n = input.read(buffer)) != -1) { if (raw.size()+n > MAX_JSON) throw new IOException("Device response is too large"); raw.write(buffer, 0, n); } }
            JSONObject data = null;
            if (raw.size() > 0) try { data = new JSONObject(new String(raw.toByteArray(), StandardCharsets.UTF_8)); } catch (Exception ignored) { }
            if (status < 200 || status >= 300) {
                String fallback = status == 401 ? "Receiver requires a PIN" : status == 403 ? "The receiver declined the transfer" : status == 409 ? "The receiver is busy" : "Device returned HTTP " + status;
                throw new HttpError(status, data == null ? fallback : data.optString("message", fallback));
            }
            return new Result(status, data, actualFingerprint);
        } finally { connection.disconnect(); if (transfer != null) transfer.connections.remove(connection); }
    }
    private void performSend(JSONObject peer, List<Source> sources, Transfer transfer) {
        try {
            JSONObject files = sourceMetadata(sources);
            Result prepared = request(peer, "/prepare-upload", obj("info", info(), "files", files), null, transfer, 130000);
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            if (prepared.status == 204) { synchronized (lock) { for (int i = 0; i < transfer.files.length(); i++) { JSONObject f = transfer.files.optJSONObject(i); put(f, "status", "completed"); put(f, "transferred", f.optLong("size")); } } finish(transfer, "completed", null); return; }
            if (prepared.data == null || prepared.data.optString("sessionId").isEmpty() || prepared.data.optJSONObject("files") == null) throw new IOException("Receiver sent an invalid transfer response");
            transfer.remoteSession = prepared.data.optString("sessionId"); JSONObject tokens = prepared.data.optJSONObject("files");
            boolean any = false; for (Source source : sources) if (!tokens.optString(source.id, "").isEmpty()) any = true;
            if (!any) throw new HttpError(403, "The receiver did not accept any files");
            synchronized (lock) { put(transfer.json, "status", "transferring"); } changed();
            sendFiles(peer, sources, transfer, tokens, parallelFiles(prepared.data.optJSONObject("capabilities")));
            if (transfer.cancelled) throw new IOException("Transfer cancelled");
            finish(transfer, "completed", null);
        } catch (Exception e) {
            finish(transfer, transfer.cancelled ? "cancelled" : e instanceof HttpError && ((HttpError)e).status == 403 ? "rejected" : "failed", e.getMessage());
            if (transfer.remoteSession != null) cancelRemote(transfer);
        }
    }
    private interface CopyProgress { void update(byte[] bytes, int length, long transferred); }
    private static void checkStopped(Transfer transfer) throws IOException {
        if (Thread.currentThread().isInterrupted() || transfer != null && (transfer.cancelled || transfer.aborting)) throw new IOException("Transfer stopped");
    }
    /** Bounded streaming copy shared by direct uploads and PC-initiated downloads. */
    private long copyFile(InputStream input, OutputStream output, long size, boolean checkEnd, Transfer transfer, CopyProgress progress) throws Exception {
        byte[] buffer = new byte[TRANSFER_BUFFER_SIZE];long count = 0;
        while (count < size) {
            checkStopped(transfer);int n = input.read(buffer, 0, (int)Math.min(buffer.length, size-count));
            if (n < 0) throw new IOException("File size changed or transfer was interrupted");
            if (n == 0) continue;
            checkStopped(transfer);output.write(buffer, 0, n);count += n;progress.update(buffer, n, count);
        }
        if (checkEnd && input.read() != -1) throw new IOException("File size changed during transfer");
        return count;
    }
    private static int parallelFiles(JSONObject capabilities) {
        Object value = capabilities == null ? null : capabilities.opt("parallelFiles");
        if (!(value instanceof Number)) return 1;
        double n = ((Number)value).doubleValue();
        return n >= 1 && n <= MAX_PARALLEL_FILES && n == Math.floor(n) ? (int)n : 1;
    }
    private void sendFiles(JSONObject peer, List<Source> sources, Transfer transfer, JSONObject tokens, int limit) throws Exception {
        final AtomicInteger next = new AtomicInteger();
        final AtomicReference<Exception> failure = new AtomicReference<>();
        final int workers = Math.min(limit, sources.size());
        final CountDownLatch done = new CountDownLatch(workers);
        Runnable worker = () -> {
            try {
                while (failure.get() == null) {
                    int index = next.getAndIncrement(); if (index >= sources.size()) break;
                    Source source = sources.get(index); JSONObject file = findFile(transfer, source.id);
                    try {
                        if (transfer.cancelled || transfer.aborting) throw new IOException("Transfer stopped");
                        String token = tokens.optString(source.id, "");
                        if (token.isEmpty()) { synchronized (lock) { put(file, "status", "skipped"); } continue; }
                        synchronized (lock) { put(file, "status", "transferring"); }
                        String query = "?sessionId="+encode(transfer.remoteSession)+"&fileId="+encode(source.id)+"&token="+encode(token);
                        request(peer, "/upload"+query, null, source, transfer, 120000);
                        if (transfer.cancelled || transfer.aborting) throw new IOException("Transfer stopped");
                        synchronized (lock) { put(file, "status", "completed"); } progress(transfer);
                    } catch (Exception e) {
                        synchronized (lock) { put(file, "status", transfer.cancelled || transfer.aborting ? "cancelled" : "failed"); }
                        if (failure.compareAndSet(null, e)) { transfer.aborting = true; disconnect(transfer); }
                    }
                }
            } finally { done.countDown(); }
        };
        // Fixed worker count keeps open content-provider handles, TLS sockets and memory bounded.
        for (int i = 0; i < workers; i++) {
            if (!execute(worker)) {
                if (failure.compareAndSet(null, new IOException("Too many simultaneous connections. Try again"))) { transfer.aborting = true; disconnect(transfer); }
                done.countDown();
            }
        }
        done.await();
        if (failure.get() != null) throw failure.get();
    }
    private void cancelRemote(Transfer transfer) { try { request(transfer.peer, "/cancel?sessionId="+encode(transfer.remoteSession), null, null, null, 2000); } catch (Exception ignored) { } }
    private static String encode(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
}
