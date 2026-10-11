package com.linjiang12.coursereader;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Headers resolve start; body chunks arrive independently, including before first UI read. */
@CapacitorPlugin(name = "ReaderStream")
public class ReaderStreamPlugin extends Plugin {
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Request> requests = new ConcurrentHashMap<>();
    private static final class Request {
        final String id;
        final PluginCall call;
        volatile HttpURLConnection connection;
        volatile InputStream input;
        volatile boolean ended = false;
        volatile boolean resolved = false;
        Request(String id, PluginCall call) { this.id = id; this.call = call; }
    }
    private void event(Request request, String kind, String data) {
        JSObject value = new JSObject(); value.put("requestId", request.id); value.put("kind", kind);
        if (data != null) value.put("data", data);
        notifyListeners("stream", value);
    }
    private synchronized void stop(Request request) {
        if (request.ended) return;
        request.ended = true;
        if (!request.resolved) request.call.reject("Request stopped"); else event(request, "error", null);
        // Disconnect first: closing an input stream can wait for a blocked read.
        if (request.connection != null) request.connection.disconnect();
        if (request.input != null) try { request.input.close(); } catch (Exception ignored) { }
        requests.remove(request.id, request);
    }
    @PluginMethod public void start(PluginCall call) {
        String id = call.getString("requestId"), address = call.getString("url"), method = call.getString("method", "GET");
        if (id == null || address == null || (!method.equals("GET") && !method.equals("POST"))) { call.reject("Invalid request"); return; }
        try {
            URL url = new URL(address);
            if ((!url.getProtocol().equals("http") && !url.getProtocol().equals("https")) || url.getUserInfo() != null) throw new IllegalArgumentException();
            Request request = new Request(id, call);
            if (requests.putIfAbsent(id, request) != null) { call.reject("Duplicate request"); return; }
            int timeout = Math.max(1, Math.min(600000, call.getInt("timeoutMs", 120000)));
            ScheduledFuture<?> deadline = timer.schedule(() -> stop(request), timeout, TimeUnit.MILLISECONDS);
            workers.execute(() -> {
                try {
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    request.connection = connection;
                    if (request.ended) { connection.disconnect(); return; }
                    connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout); connection.setRequestMethod(method);
                    // Reject redirect responses so credentials never follow to a different origin.
                    connection.setInstanceFollowRedirects(false);
                    JSObject headers = call.getObject("headers", new JSObject());
                    java.util.Iterator<String> headerNames = headers.keys();
                    while (headerNames.hasNext()) { String key = headerNames.next(); connection.setRequestProperty(key, headers.getString(key)); }
                    String body = call.getString("body");
                    if (body != null) {
                        connection.setDoOutput(true);
                        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body.getBytes(StandardCharsets.UTF_8)); }
                    }
                    int status = connection.getResponseCode();
                    JSObject response = new JSObject(), responseHeaders = new JSObject();
                    for (Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                        if (entry.getKey() != null) responseHeaders.put(entry.getKey().toLowerCase(java.util.Locale.ROOT), String.join(", ", entry.getValue()));
                    }
                    response.put("ok", status >= 200 && status < 300); response.put("status", status);
                    response.put("statusText", connection.getResponseMessage()); response.put("headers", responseHeaders);
                    synchronized (this) {
                        if (request.ended) return;
                        request.resolved = true; call.resolve(response);
                    }
                    InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream();
                    request.input = input;
                    if (input != null) try (InputStream stream = input) {
                        byte[] buffer = new byte[8192]; int length;
                        while (!request.ended && (length = stream.read(buffer)) != -1) {
                            if (!request.ended) event(request, "chunk", Base64.encodeToString(Arrays.copyOf(buffer, length), Base64.NO_WRAP));
                        }
                    }
                    synchronized (this) { if (!request.ended) { event(request, "done", null); request.ended = true; } }
                } catch (Exception error) { stop(request); }
                finally { deadline.cancel(false); if (request.connection != null) request.connection.disconnect(); requests.remove(id, request); }
            });
        } catch (Exception error) { call.reject("Invalid request"); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        Request request = requests.get(call.getString("requestId", ""));
        if (request != null) stop(request);
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        for (Request request : requests.values()) stop(request);
        workers.shutdownNow(); timer.shutdownNow();
        super.handleOnDestroy();
    }
}
