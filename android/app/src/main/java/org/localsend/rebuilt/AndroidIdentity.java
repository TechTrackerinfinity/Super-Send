package org.localsend.rebuilt;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Calendar;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509KeyManager;
import javax.net.ssl.X509TrustManager;
import javax.security.auth.x500.X500Principal;

/** A private, persistent Android Keystore identity for the LocalSend TLS endpoint. */
public final class AndroidIdentity {
    public final SSLContext context;
    public final String fingerprint;
    private static final String ALIAS = "localsend-rebuilt-device-v2";

    public AndroidIdentity() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            Calendar from = Calendar.getInstance();
            from.add(Calendar.DAY_OF_YEAR, -1);
            Calendar until = Calendar.getInstance();
            until.add(Calendar.YEAR, 25);
            KeyPairGenerator gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            gen.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE, KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
                    .setCertificateSubject(new X500Principal("CN=LocalSend Rebuilt Android"))
                    .setCertificateSerialNumber(new BigInteger(128, new SecureRandom()).abs().add(BigInteger.ONE))
                    .setCertificateNotBefore(from.getTime()).setCertificateNotAfter(until.getTime()).build());
            gen.generateKeyPair();
        }
        final PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
        final X509Certificate cert = (X509Certificate) store.getCertificate(ALIAS);
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(cert.getEncoded())) hex.append(String.format(java.util.Locale.ROOT, "%02X", b & 255));
        fingerprint = hex.toString();
        X509KeyManager manager = new X509KeyManager() {
            public String[] getClientAliases(String t, Principal[] p) { return "RSA".equalsIgnoreCase(t) ? new String[]{ALIAS} : null; }
            public String chooseClientAlias(String[] t, Principal[] p, Socket s) { for (String k : t) if ("RSA".equalsIgnoreCase(k)) return ALIAS; return null; }
            public String[] getServerAliases(String t, Principal[] p) { return "RSA".equalsIgnoreCase(t) ? new String[]{ALIAS} : null; }
            public String chooseServerAlias(String t, Principal[] p, Socket s) { return "RSA".equalsIgnoreCase(t) ? ALIAS : null; }
            public X509Certificate[] getCertificateChain(String a) { return ALIAS.equals(a) ? new X509Certificate[]{cert} : null; }
            public PrivateKey getPrivateKey(String a) { return ALIAS.equals(a) ? key : null; }
        };
        // LocalSend uses self-signed identities. TransferEngine binds HTTPS responses to
        // the fingerprint learned during discovery rather than to public web PKI.
        X509TrustManager trust = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) { }
            public void checkServerTrusted(X509Certificate[] c, String a) { }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        context = SSLContext.getInstance("TLS");
        context.init(new KeyManager[]{manager}, new TrustManager[]{trust}, new SecureRandom());
    }
}
