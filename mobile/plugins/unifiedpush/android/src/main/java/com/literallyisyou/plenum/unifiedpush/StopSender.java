package com.literallyisyou.plenum.unifiedpush;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SNIServerName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Stop from a notification with no unlock (wave 6, k3): the phone's native half of "Stop without unlocking". It sends one signed
 * STOP_ONLY (lib/remote/stop-only.mjs) to the computer that sent the notification, on a fresh WebSocket, exactly as the shell's
 * channel worker does (mobile/shell/channel.worker.js stopLocked), and reads back the signed STOP_ONLY_ACK. No Noise session is ever
 * opened. All it can do is what the Stop key can do on the computer: stop runs and deny the cards they wait on.
 *
 * Pure Java with no Android import, so the same file is compiled and run by the plain JDK in the tests against the computer's real
 * listener (build/v06/w6-k3). The Android side (StopReceiver.kt, StopCards.kt) gives it the Stop card and the counter.
 *
 * Rules kept from the shell (MOBILE.json transport):
 *   - The ways (carrier addresses) are dialled together, DIAL_STAGGER_MS apart, and only the socket that opened first carries the
 *     STOP_ONLY, so two sockets never send with counters that could arrive out of order. The others are closed unused.
 *   - The counter is raised and stored (Counter.next) before every send; the same 16-byte stopId is on every resend of one press.
 *   - A way that opened and gave no ACK is put aside and the rest are dialled again. A round in which every way closed with 4401 means the
 *     computer does not know this Stop key ('unknown'). A 4400 (replay: the counter did not rise) is tried again once with a counter
 *     REPLAY_JUMP higher, on any way.
 *   - The whole press has a budget (BUDGET_MS by default): this runs inside a BroadcastReceiver's goAsync window.
 * Nothing here logs, and the Stop key never leaves this class except as the HMAC it makes.
 */
public final class StopSender {
    public static final int STOP_ONLY_LEN = 90;
    public static final int STOP_ACK_LEN = 66;
    public static final byte STOP_ONLY_TYPE = 0x7e;
    public static final byte STOP_ACK_TYPE = 0x7d;
    public static final byte VERSION = 0x01;
    public static final long BUDGET_MS = 8000L;
    public static final long DIAL_STAGGER_MS = 250L;
    public static final long CONNECT_TIMEOUT_MS = 6000L;
    public static final long CONNECT_TIMEOUT_PRIVATE_MS = 2000L;
    public static final long ACK_WAIT_MS = 6000L;
    public static final long REPLAY_JUMP = 1024L;
    // A new round starts only with at least this much of the budget left, after a pause of at most ROUND_PAUSE_MS.
    private static final long ROUND_MIN_MS = 1500L;
    private static final long ROUND_PAUSE_MS = 1000L;
    public static final int MAX_WAYS = 12;
    private static final int MAX_URL_LENGTH = 512;
    private static final int MAX_HEADER_BYTES = 8192;
    private static final int MAX_FRAME = 65535 + 64;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final byte[] PAD_INFO = "plenum-stop-ack".getBytes(StandardCharsets.US_ASCII);
    private static final SecureRandom RANDOM = new SecureRandom();

    private StopSender() {}

    /** One carrier address: kind 'lan' | 'tailscale' | 'relay', and its ws:// or wss:// URL. */
    public static final class Way {
        public final String kind;
        public final String url;

        public Way(String kind, String url) {
            this.kind = kind;
            this.url = url;
        }
    }

    /** Stores a counter that is at least `atLeast` and above every counter used before for this computer, and answers it. */
    public interface Counter {
        long next(long atLeast) throws Exception;
    }

    /** The host name check for wss:// (Android passes its own HostnameVerifier; null leaves it to the TLS endpoint check). */
    public interface HostCheck {
        boolean ok(String host, SSLSession session);
    }

    /** What one press ended with. status: 'stopped' (counts are the computer's), 'unknown' or 'unreachable'. */
    public static final class Outcome {
        public final String status;
        public final long[] counts;
        public final int tries;

        Outcome(String status, long[] counts, int tries) {
            this.status = status;
            this.counts = counts;
            this.tries = tries;
        }
    }

    // ----- the messages (lib/remote/stop-only.mjs) -----

    public static byte[] encodeStopOnly(byte[] stopKey, String deviceIdHex, long counter, byte[] stopId) {
        if (stopKey == null || stopKey.length != 32) throw new IllegalArgumentException("stop key");
        if (deviceIdHex == null || !deviceIdHex.matches("^[0-9a-f]{64}$")) throw new IllegalArgumentException("device id");
        if (counter < 1 || counter > 9007199254740991L) throw new IllegalArgumentException("counter");
        if (stopId == null || stopId.length != 16) throw new IllegalArgumentException("stop id");
        byte[] out = new byte[STOP_ONLY_LEN];
        out[0] = STOP_ONLY_TYPE;
        out[1] = VERSION;
        byte[] id = hex(deviceIdHex);
        System.arraycopy(id, 0, out, 2, 32);
        for (int i = 0; i < 8; i++) out[34 + i] = (byte) (counter >>> (56 - 8 * i));
        System.arraycopy(stopId, 0, out, 42, 16);
        byte[] mac = hmac(stopKey, out, 0, 58);
        System.arraycopy(mac, 0, out, 58, 32);
        return out;
    }

    /** The four counts (cancelled, drivesStopped, agentsStopped, cardsDenied) when `bytes` is the ACK of this stopId under this key, else null. */
    public static long[] decodeStopAck(byte[] stopKey, byte[] bytes, byte[] stopId) {
        if (bytes == null || bytes.length != STOP_ACK_LEN || bytes[0] != STOP_ACK_TYPE || bytes[1] != VERSION) return null;
        if (stopKey == null || stopKey.length != 32 || stopId == null || stopId.length != 16) return null;
        if (!same(bytes, 2, stopId, 0, 16)) return null;
        if (!same(hmac(stopKey, bytes, 0, 34), 0, bytes, 34, 32)) return null;
        byte[] padInput = new byte[PAD_INFO.length + 16];
        System.arraycopy(PAD_INFO, 0, padInput, 0, PAD_INFO.length);
        System.arraycopy(stopId, 0, padInput, PAD_INFO.length, 16);
        byte[] pad = hmac(stopKey, padInput, 0, padInput.length);
        long[] counts = new long[4];
        for (int i = 0; i < 4; i++) {
            long n = 0;
            for (int j = 0; j < 4; j++) n = (n << 8) | ((bytes[18 + i * 4 + j] ^ pad[i * 4 + j]) & 0xff);
            counts[i] = n;
        }
        return counts;
    }

    /** The same sentence the shell shows after a Stop (mobile/shell/stop.js stopResultText). */
    public static String resultText(long[] counts, String computerName) {
        String name = computerName == null || computerName.isEmpty() ? "this computer" : computerName;
        long replies = counts == null ? 0 : counts[0];
        long runs = counts == null ? 0 : counts[1];
        long agents = counts == null ? 0 : counts[2];
        long cards = counts == null ? 0 : counts[3];
        if (replies == 0 && runs == 0 && agents == 0 && cards == 0) return "Nothing was running on " + name + ".";
        List<String> parts = new ArrayList<>();
        if (replies > 0) parts.add(plural(replies, "reply", "replies"));
        if (runs > 0) parts.add(plural(runs, "computer run", "computer runs"));
        if (agents > 0) parts.add(plural(agents, "agent", "agents"));
        String tail = cards > 0 ? " " + plural(cards, "card", "cards") + " denied." : "";
        return "Stopped everything on " + name + ": " + String.join(", ", parts) + "." + tail;
    }

    private static String plural(long n, String one, String many) {
        return n + " " + (n == 1 ? one : many);
    }

    // ----- which addresses (mobile/shell/carriers.js carrierUrlOk, dialOrder, isPrivateUrl) -----

    /** carriers.js carrierUrlOk: ws: or wss:, no user name, at most 512 characters; lan private, tailscale wss .ts.net, relay wss. */
    public static boolean carrierUrlOk(String kind, String url) {
        if (url == null || url.length() > MAX_URL_LENGTH) return false;
        if (!"lan".equals(kind) && !"tailscale".equals(kind) && !"relay".equals(kind)) return false;
        URI uri;
        try {
            uri = new URI(url);
        } catch (Exception e) {
            return false;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"ws".equals(scheme) && !"wss".equals(scheme)) return false;
        if (uri.getRawUserInfo() != null || uri.getHost() == null || uri.getHost().isEmpty()) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (isLoopback(host)) return true;
        if ("relay".equals(kind)) return "wss".equals(scheme);
        if ("tailscale".equals(kind)) return "wss".equals(scheme) && host.endsWith(".ts.net");
        int[] v4 = ipv4(host);
        if (v4 != null) return isPrivateV4(v4);
        return isPrivateV6(host) || host.endsWith(".local");
    }

    /** carriers.js isPrivateUrl: an IP literal on a private, link-local or loopback range (a short connect timeout). */
    public static boolean isPrivateUrl(String url) {
        String host;
        try {
            host = new URI(url).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        int[] v4 = ipv4(host);
        if (v4 != null) return v4[0] == 127 || isPrivateV4(v4);
        return "[::1]".equals(host) || isPrivateV6(host);
    }

    /** carriers.js dialOrder: the address that connected last, then the other addresses of the way used last, then the rest; on mobile data
     *  plain ws:// private addresses go to the end. Only addresses that pass carrierUrlOk, at most MAX_WAYS. */
    public static List<Way> dialOrder(List<Way> ways, String lastCarrier, String lastUrl, boolean cellular) {
        List<Way> ok = new ArrayList<>();
        for (Way w : ways) {
            if (w != null && carrierUrlOk(w.kind, w.url) && ok.size() < MAX_WAYS) ok.add(w);
        }
        List<Way> sorted = new ArrayList<>(ok);
        Collections.sort(sorted, (a, b) -> {
            int away = Integer.compare(away(a, cellular), away(b, cellular));
            if (away != 0) return away;
            return Integer.compare(rank(a, lastCarrier, lastUrl), rank(b, lastCarrier, lastUrl));
        });
        return sorted;
    }

    private static int rank(Way w, String lastCarrier, String lastUrl) {
        if (w.url.equals(lastUrl)) return 0;
        return w.kind.equals(lastCarrier) ? 1 : 2;
    }

    private static int away(Way w, boolean cellular) {
        return cellular && w.url.startsWith("ws:") && isPrivateUrl(w.url) ? 1 : 0;
    }

    private static boolean isLoopback(String host) {
        if ("localhost".equals(host) || "[::1]".equals(host)) return true;
        int[] v4 = ipv4(host);
        return v4 != null && v4[0] == 127;
    }

    private static int[] ipv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] out = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("^\\d{1,3}$")) return null;
            out[i] = Integer.parseInt(parts[i]);
            if (out[i] > 255) return null;
        }
        return out;
    }

    private static boolean isPrivateV4(int[] a) {
        return a[0] == 10
            || (a[0] == 172 && a[1] >= 16 && a[1] <= 31)
            || (a[0] == 192 && a[1] == 168)
            || (a[0] == 169 && a[1] == 254)
            || (a[0] == 100 && a[1] >= 64 && a[1] <= 127);
    }

    private static boolean isPrivateV6(String host) {
        if (!host.startsWith("[") || !host.endsWith("]")) return false;
        String first = host.substring(1, host.length() - 1).split(":", -1)[0];
        if (!first.matches("^[0-9a-f]{1,4}$")) return false;
        int value = Integer.parseInt(first, 16);
        return (value >= 0xfc00 && value <= 0xfdff) || (value >= 0xfe80 && value <= 0xfebf);
    }

    // ----- one press -----

    /**
     * Sends one Stop and waits for its ACK, within `budgetMs`. `ways` are dialled in the order given (use dialOrder first).
     * `tls` makes the wss:// sockets (SSLSocketFactory.getDefault() on a phone). Never throws.
     */
    public static Outcome send(List<Way> ways, byte[] stopKey, String deviceIdHex, Counter counter, long budgetMs, SSLSocketFactory tls, HostCheck check) {
        final long deadline = System.currentTimeMillis() + Math.max(1000L, budgetMs);
        if (stopKey == null || stopKey.length != 32 || deviceIdHex == null || !deviceIdHex.matches("^[0-9a-f]{64}$") || ways == null || ways.isEmpty()) {
            return new Outcome("unreachable", null, 0);
        }
        final byte[] key = stopKey.clone();
        final byte[] stopId = new byte[16];
        RANDOM.nextBytes(stopId);
        long used = 0;
        boolean jump = false;
        boolean jumped = false;
        int tries = 0;
        try {
            // Rounds while the budget lasts: a phone that just woke may need a second try at its network.
            while (deadline - System.currentTimeMillis() > ROUND_MIN_MS) {
                List<Way> left = new ArrayList<>(ways);
                List<Integer> codes = new ArrayList<>();
                while (!left.isEmpty() && System.currentTimeMillis() < deadline - 300) {
                    Race race = race(left, deadline, tls, check);
                    for (Way w : race.failed) {
                        left.remove(w);
                        codes.add(-1);
                    }
                    if (race.winner == null) break;
                    left.remove(race.way);
                    WebSocket ws = race.winner;
                    int code;
                    try {
                        long next = counter.next(jump ? used + REPLAY_JUMP : used + 1);
                        if (next <= used || next < 1) throw new IllegalStateException("counter");
                        used = next;
                        jump = false;
                        tries++;
                        ws.sendBinary(encodeStopOnly(key, deviceIdHex, used, stopId));
                        Frame first = ws.next(Math.min(ACK_WAIT_MS, Math.max(200L, deadline - System.currentTimeMillis())));
                        if (first.opcode == 2) {
                            long[] counts = decodeStopAck(key, first.payload, stopId);
                            if (counts != null) return new Outcome("stopped", counts, tries);
                            code = -1;
                        } else {
                            code = first.closeCode;
                        }
                    } catch (Exception e) {
                        code = ws.closeCode;
                    } finally {
                        ws.close();
                    }
                    if (code == 4400 && !jumped) {
                        // The computer holds a higher counter than this phone knew (the shell raised it after the card was handed
                        // over): once more, well above it. The shell reads this counter back before its next handshake (native.js).
                        jumped = true;
                        jump = true;
                        left.add(0, race.way);
                        continue;
                    }
                    codes.add(code);
                }
                // Every way answered, and every one with 4401: the computer does not know this phone's Stop key.
                boolean unknown = !codes.isEmpty() && codes.size() >= ways.size();
                for (int c : codes) if (c != 4401) unknown = false;
                if (unknown) return new Outcome("unknown", null, tries);
                long pause = Math.min(ROUND_PAUSE_MS, deadline - System.currentTimeMillis() - ROUND_MIN_MS);
                if (pause > 0) Thread.sleep(pause);
            }
            return new Outcome("unreachable", null, tries);
        } catch (Exception e) {
            return new Outcome("unreachable", null, tries);
        } finally {
            java.util.Arrays.fill(key, (byte) 0);
        }
    }

    // ----- the dial race -----

    private static final class Race {
        WebSocket winner;
        Way way;
        final List<Way> failed = new ArrayList<>();
    }

    // Opens the ways together, DIAL_STAGGER_MS apart (the next one starts at once when one fails). The first that finishes its
    // WebSocket upgrade wins; every other socket is closed and never carries anything. Answers a snapshot taken when the race ended:
    // the winner (or none), and the ways that failed before that. A dial still running then is not counted (the caller dials it again);
    // when it ends later, its socket is closed at once.
    private static Race race(List<Way> ways, long deadline, SSLSocketFactory tls, HostCheck check) {
        final Object lock = new Object();
        final Race race = new Race();
        final boolean[] over = {false};
        final int n = ways.size();
        final int[] failures = {0};
        final int[] finished = {0};
        final long started = System.currentTimeMillis();
        final List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            final int index = i;
            final Way way = ways.get(i);
            Thread t = new Thread(() -> {
                // Wait for this one's turn: its stagger, or as many failures as there are ways before it.
                synchronized (lock) {
                    long startAt = started + index * DIAL_STAGGER_MS;
                    while (!over[0] && race.winner == null && failures[0] < index) {
                        long wait = startAt - System.currentTimeMillis();
                        if (wait <= 0) break;
                        try {
                            lock.wait(wait);
                        } catch (InterruptedException e) {
                            break;
                        }
                    }
                    if (over[0] || race.winner != null) {
                        finished[0]++;
                        lock.notifyAll();
                        return;
                    }
                }
                WebSocket ws = null;
                try {
                    long timeout = Math.min(isPrivateUrl(way.url) ? CONNECT_TIMEOUT_PRIVATE_MS : CONNECT_TIMEOUT_MS, deadline - System.currentTimeMillis());
                    if (timeout <= 0) throw new IOException("timeout");
                    ws = WebSocket.open(way.url, (int) timeout, tls, check);
                } catch (Exception e) {
                    ws = null;
                }
                synchronized (lock) {
                    finished[0]++;
                    if (ws != null && race.winner == null && !over[0]) {
                        race.winner = ws;
                        race.way = way;
                    } else if (ws != null) {
                        ws.close();
                    } else if (!over[0]) {
                        failures[0]++;
                        race.failed.add(way);
                    }
                    lock.notifyAll();
                }
            }, "plenum-stop-dial");
            t.setDaemon(true);
            threads.add(t);
        }
        for (Thread t : threads) t.start();
        synchronized (lock) {
            while (race.winner == null && finished[0] < n) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) break;
                try {
                    lock.wait(wait);
                } catch (InterruptedException e) {
                    break;
                }
            }
            over[0] = true;
            lock.notifyAll();
            Race snapshot = new Race();
            snapshot.winner = race.winner;
            snapshot.way = race.way;
            snapshot.failed.addAll(race.failed);
            return snapshot;
        }
    }

    // ----- a minimal WebSocket client (RFC 6455): one binary message out, frames in -----

    static final class Frame {
        final int opcode;
        final byte[] payload;
        final int closeCode;

        Frame(int opcode, byte[] payload, int closeCode) {
            this.opcode = opcode;
            this.payload = payload;
            this.closeCode = closeCode;
        }
    }

    static final class WebSocket {
        private final Socket socket;
        private final InputStream in;
        private final OutputStream out;
        volatile int closeCode = -1;

        private WebSocket(Socket socket, InputStream in, OutputStream out) {
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        static WebSocket open(String url, int timeoutMs, SSLSocketFactory tls, HostCheck check) throws Exception {
            URI uri = new URI(url);
            boolean secure = "wss".equalsIgnoreCase(uri.getScheme());
            String host = uri.getHost();
            String bare = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
            int port = uri.getPort() > 0 ? uri.getPort() : (secure ? 443 : 80);
            String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();
            Socket plain = new Socket();
            Socket socket = plain;
            try {
                plain.setTcpNoDelay(true);
                plain.connect(new InetSocketAddress(bare, port), timeoutMs);
                plain.setSoTimeout(timeoutMs);
                if (secure) {
                    SSLSocketFactory factory = tls != null ? tls : (SSLSocketFactory) SSLSocketFactory.getDefault();
                    SSLSocket ssl = (SSLSocket) factory.createSocket(plain, bare, port, true);
                    SSLParameters params = ssl.getSSLParameters();
                    // The certificate must name this host (the JDK and Android both check it with this algorithm set).
                    params.setEndpointIdentificationAlgorithm("HTTPS");
                    if (ipv4(bare) == null && !bare.contains(":")) {
                        List<SNIServerName> names = new ArrayList<>();
                        names.add(new SNIHostName(bare));
                        params.setServerNames(names);
                    }
                    ssl.setSSLParameters(params);
                    ssl.startHandshake();
                    if (check != null && !check.ok(bare, ssl.getSession())) throw new IOException("host");
                    socket = ssl;
                }
                InputStream in = new BufferedInputStream(socket.getInputStream());
                OutputStream out = socket.getOutputStream();
                byte[] nonce = new byte[16];
                RANDOM.nextBytes(nonce);
                String key = Base64.getEncoder().encodeToString(nonce);
                boolean defaultPort = uri.getPort() <= 0 || (secure && uri.getPort() == 443) || (!secure && uri.getPort() == 80);
                String hostHeader = defaultPort ? host : host + ":" + port;
                String request = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + hostHeader + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "\r\n";
                out.write(request.getBytes(StandardCharsets.US_ASCII));
                out.flush();
                String head = readHead(in);
                String[] lines = head.split("\r\n");
                if (lines.length == 0 || !lines[0].matches("^HTTP/1\\.1 101( .*)?$")) throw new IOException("upgrade");
                String accept = null;
                for (int i = 1; i < lines.length; i++) {
                    int colon = lines[i].indexOf(':');
                    if (colon <= 0) continue;
                    if (lines[i].substring(0, colon).trim().equalsIgnoreCase("sec-websocket-accept")) accept = lines[i].substring(colon + 1).trim();
                }
                MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
                String want = Base64.getEncoder().encodeToString(sha1.digest((key + WS_GUID).getBytes(StandardCharsets.US_ASCII)));
                if (!want.equals(accept)) throw new IOException("accept");
                return new WebSocket(socket, in, out);
            } catch (Exception e) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // already closed
                }
                throw e;
            }
        }

        private static String readHead(InputStream in) throws IOException {
            byte[] buf = new byte[MAX_HEADER_BYTES];
            int n = 0;
            while (n < buf.length) {
                int b = in.read();
                if (b < 0) throw new EOFException("head");
                buf[n++] = (byte) b;
                if (n >= 4 && buf[n - 4] == '\r' && buf[n - 3] == '\n' && buf[n - 2] == '\r' && buf[n - 1] == '\n') {
                    return new String(buf, 0, n - 4, StandardCharsets.ISO_8859_1);
                }
            }
            throw new IOException("head too long");
        }

        void sendBinary(byte[] payload) throws IOException {
            writeFrame(0x2, payload);
        }

        private synchronized void writeFrame(int opcode, byte[] payload) throws IOException {
            int len = payload.length;
            byte[] header;
            if (len < 126) {
                header = new byte[] {(byte) (0x80 | opcode), (byte) (0x80 | len)};
            } else if (len <= 0xffff) {
                header = new byte[] {(byte) (0x80 | opcode), (byte) (0x80 | 126), (byte) (len >>> 8), (byte) len};
            } else {
                throw new IOException("too big");
            }
            byte[] mask = new byte[4];
            RANDOM.nextBytes(mask);
            byte[] body = new byte[len];
            for (int i = 0; i < len; i++) body[i] = (byte) (payload[i] ^ mask[i % 4]);
            out.write(header);
            out.write(mask);
            out.write(body);
            out.flush();
        }

        // The next data or close frame. A ping is answered and a pong is skipped. A close frame gives its code.
        Frame next(long timeoutMs) throws IOException {
            long until = System.currentTimeMillis() + timeoutMs;
            while (true) {
                long left = until - System.currentTimeMillis();
                if (left <= 0) throw new IOException("timeout");
                socket.setSoTimeout((int) Math.max(1L, left));
                int b0 = readByte();
                int b1 = readByte();
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) len = (readByte() << 8) | readByte();
                else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
                }
                if (len < 0 || len > MAX_FRAME) throw new IOException("too big");
                byte[] mask = masked ? readFully(4) : null;
                byte[] payload = readFully((int) len);
                if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
                if ((b0 & 0x80) == 0 || opcode == 0) throw new IOException("fragmented");
                if (opcode == 0x9) {
                    writeFrame(0xA, payload);
                    continue;
                }
                if (opcode == 0xA) continue;
                if (opcode == 0x8) {
                    int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                    closeCode = code;
                    return new Frame(0x8, payload, code);
                }
                return new Frame(opcode, payload, -1);
            }
        }

        private int readByte() throws IOException {
            int b = in.read();
            if (b < 0) throw new EOFException("closed");
            return b;
        }

        private byte[] readFully(int len) throws IOException {
            byte[] out = new byte[len];
            int n = 0;
            while (n < len) {
                int r = in.read(out, n, len - n);
                if (r < 0) throw new EOFException("closed");
                n += r;
            }
            return out;
        }

        void close() {
            try {
                writeFrame(0x8, new byte[] {0x03, (byte) 0xe8});
            } catch (IOException ignored) {
                // the other side closed already
            }
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    // ----- small helpers -----

    private static byte[] hmac(byte[] key, byte[] data, int off, int len) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            mac.update(data, off, len);
            return mac.doFinal();
        } catch (Exception e) {
            throw new IllegalStateException("hmac");
        }
    }

    private static boolean same(byte[] a, int aOff, byte[] b, int bOff, int len) {
        int d = 0;
        for (int i = 0; i < len; i++) d |= a[aOff + i] ^ b[bOff + i];
        return d == 0;
    }

    static byte[] hex(String text) {
        byte[] out = new byte[text.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    /** base64url without padding (the shell's form of the Stop key) to bytes, or null. */
    public static byte[] fromB64u(String text) {
        if (text == null || !text.matches("^[A-Za-z0-9_-]{43}$")) return null;
        try {
            return Base64.getUrlDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
