package com.linjiang12.coursereader;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only authenticated ciphertext reaches private app preferences. No key export. */
@CapacitorPlugin(name = "ReaderSecrets")
public class ReaderSecretsPlugin extends Plugin {
    private static final String ALIAS = "course-reader-models-v1";
    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("model-secrets", Context.MODE_PRIVATE);
    }
    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private String name(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty() || key.length() > 200) throw new IllegalArgumentException("Invalid secret name");
        return key;
    }
    @PluginMethod public synchronized void get(PluginCall call) {
        try {
            String encoded = preferences().getString(name(call), null);
            JSObject result = new JSObject();
            if (encoded != null) {
                String[] parts = encoded.split(":", -1);
                if (parts.length != 2) throw new IllegalStateException("Invalid vault entry");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) { call.reject("Secure storage unavailable"); }
    }
    @PluginMethod public synchronized void set(PluginCall call) {
        try {
            String key = name(call), value = call.getString("value");
            if (value == null) throw new IllegalArgumentException("Missing value");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if (!preferences().edit().putString(key, encoded).commit()) throw new IllegalStateException("Save failed");
            call.resolve();
        } catch (Exception error) { call.reject("Secure storage unavailable"); }
    }
    @PluginMethod public synchronized void remove(PluginCall call) {
        try {
            if (!preferences().edit().remove(name(call)).commit()) throw new IllegalStateException("Remove failed");
            call.resolve();
        } catch (Exception error) { call.reject("Secure storage unavailable"); }
    }
}
