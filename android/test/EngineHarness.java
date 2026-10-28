package org.localsend.rebuilt;

import org.json.JSONObject;
import javax.net.ssl.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.*;
import java.security.cert.*;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;

/** JVM test host for exactly the engine class compiled into the APK. */
public final class EngineHarness {
    static final AtomicInteger openedSources=new AtomicInteger();
    static final AtomicInteger activeSources=new AtomicInteger(), peakSources=new AtomicInteger();
    static synchronized void emit(JSONObject event) { try { event.put("openedSources",openedSources.get());event.put("activeSources",activeSources.get());event.put("peakSources",peakSources.get()); } catch(Exception ignored){} System.out.println(event.toString()); System.out.flush(); }
    static String hex(byte[] data) { StringBuilder out=new StringBuilder();for(byte b:data)out.append(String.format("%02X",b&255));return out.toString(); }
    static SSLContext identity(String certFile,String keyFile) throws Exception {
        X509Certificate cert=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new FileInputStream(certFile));
        String pem=new String(Files.readAllBytes(Paths.get(keyFile)),StandardCharsets.UTF_8).replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----","").replaceAll("\\s","");
        PrivateKey key=KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
        KeyStore store=KeyStore.getInstance("JKS");store.load(null,null);store.setKeyEntry("device",key,"test-password".toCharArray(),new java.security.cert.Certificate[]{cert});
        KeyManagerFactory keys=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());keys.init(store,"test-password".toCharArray());
        TrustManager[] trust={new X509TrustManager(){public X509Certificate[]getAcceptedIssuers(){return new X509Certificate[0];}public void checkClientTrusted(X509Certificate[] c,String a){}public void checkServerTrusted(X509Certificate[] c,String a){}}};
        SSLContext context=SSLContext.getInstance("TLS");context.init(keys.getKeyManagers(),trust,new SecureRandom());return context;
    }
    public static void main(String[] args) throws Exception {
        X509Certificate cert=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new FileInputStream(args[0]));
        String fingerprint=hex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
        TransferEngine engine=new TransferEngine(identity(args[0],args[1]),fingerprint,"Mobile JVM test",new File(args[2]),state->{try{emit(new JSONObject().put("type","state").put("state",state));}catch(Exception e){e.printStackTrace();}},null);
        engine.start(0,false);
        emit(new JSONObject().put("type","ready").put("state",engine.state()));
        try(BufferedReader reader=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8))) {
            String line;
            while((line=reader.readLine())!=null){
                JSONObject command=new JSONObject(line);
                try{
                    String action=command.getString("action");
                    if(action.equals("stop"))break;
                    else if(action.equals("peer"))engine.addPeer(command.getString("host"),command.getInt("port"),command.optString("protocol","https"));
                    else if(action.equals("text"))engine.addText(command.getString("text"));
                    else if(action.equals("file")){
                        final File file=new File(command.getString("path"));final int slowReadMs=command.optInt("slowReadMs",0);final long failAfter=command.optLong("failAfterBytes",-1);
                        engine.addSource(new TransferEngine.Source(command.optString("name",file.getName()),file.length(),"application/octet-stream",null,()->{
                            InputStream opened=new FileInputStream(file);
                            openedSources.incrementAndGet();peakSources.accumulateAndGet(activeSources.incrementAndGet(),Math::max);
                            return new FilterInputStream(opened) {
                                private boolean closed;private long readBytes;
                                @Override public int read(byte[] buffer,int offset,int length) throws IOException {
                                    if(failAfter>=0&&readBytes>=failAfter)throw new IOException("Injected source failure");
                                    int count=super.read(buffer,offset,length);
                                    if(count>0)readBytes+=count;
                                    if(count>0&&slowReadMs>0)try{Thread.sleep(slowReadMs);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException("Test source interrupted",e);}
                                    return count;
                                }
                                @Override public synchronized void close() throws IOException {if(!closed){closed=true;activeSources.decrementAndGet();try{super.close();}finally{emit(new JSONObject().put("type","source-state"));}}}
                            };
                        }));
                    }
                    else if(action.equals("clear"))engine.clearSelection();
                    else if(action.equals("send"))engine.send(command.getString("peerId"));
                    else if(action.equals("respond"))engine.respond(command.getString("requestId"),command.getBoolean("accept"));
                    else if(action.equals("cancel"))engine.cancelTransfer(command.getString("transferId"));
                    else if(action.equals("settings"))engine.updateSettings(command.optString("alias","Mobile JVM test"),command.optBoolean("autoAccept",false));
                    emit(new JSONObject().put("type","result").put("id",command.optString("id")).put("state",engine.state()));
                }catch(Exception error){emit(new JSONObject().put("type","error").put("id",command.optString("id")).put("message",error.toString()));}
            }
        }finally{engine.stop();}
    }
}
