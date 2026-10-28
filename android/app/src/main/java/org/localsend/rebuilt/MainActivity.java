package org.localsend.rebuilt;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.drawable.RippleDrawable;
import android.view.ContextThemeWrapper;
import android.widget.ImageView;
import android.widget.FrameLayout;
import android.widget.RadioGroup;
import android.widget.RadioButton;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.TextUtils;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.ArrayAdapter;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native Android document-picker client; no browser or network work on the UI thread. */
public final class MainActivity extends Activity implements TransferService.Observer {
    private static final int PICK_FILES = 101, PICK_FOLDER = 102, SAVE_COPY = 103;
    private int BG, SURFACE, TEAL, INK, MUTED, SOFT, LINE, RED;
    private boolean dark;
    private String lastShape = "", navigationTab = "", historyFilter = "all", historyQuery = "";
    private LinearLayout historyBody;
    private TextView headerStatus;
    private final Set<String> expanded = new HashSet<>();
    private final Map<String, ProgressBar> progressBars = new HashMap<>();
    private final Map<String, TextView> progressLabels = new HashMap<>();
    private final Map<String, TransferRate> transferRates = new HashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean resumed, speedTickQueued;
    private final Runnable speedTick = () -> {
        speedTickQueued = false;
        if (!resumed || this.destroyed) return;
        sampleTransferRates(); updateProgress(); queueSpeedTick();
    };
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private TransferService service;
    private boolean bound, renderQueued, preparing, destroyed;
    private JSONObject state = new JSONObject();
    private LinearLayout root, page, navigation;
    private ScrollView scroll;
    private String tab = "receive", requestShown = "", pendingExport;
    private String pendingExportMime;
    private AlertDialog incoming;
    private AlertDialog manualDialog;
    private TextView manualError;
    private String manualHost;
    private String manualOldError;
    private int manualPort;
    private Intent sharedIntent;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((TransferService.LocalBinder) binder).service();
            service.observe(MainActivity.this);
            consumeSharedIntent();
        }
        @Override public void onServiceDisconnected(ComponentName name) { service = null; render(); }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) {
            tab=saved.getString("tab","receive"); pendingExport=saved.getString("pendingExport"); pendingExportMime=saved.getString("pendingExportMime");
            historyQuery=saved.getString("historyQuery",""); historyFilter=saved.getString("historyFilter","all");
            ArrayList<String> opened=saved.getStringArrayList("expanded");if(opened!=null)expanded.addAll(opened);
        }
        applyPalette(); buildChrome(); sharedIntent=getIntent(); render();
        SharedPreferences prefs=getSharedPreferences("localsend",MODE_PRIVATE);
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED && !prefs.getBoolean("askedNotifications",false)){
            prefs.edit().putBoolean("askedNotifications",true).apply();requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},201);
        }
        connect();
    }
    private void applyPalette(){
        String theme=getSharedPreferences("localsend",MODE_PRIVATE).getString("theme","dark");
        dark="dark".equals(theme)||("system".equals(theme)&&(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES);
        BG=dark?0xFF0B1020:0xFFF3F6FD;SURFACE=dark?0xFF141E33:Color.WHITE;TEAL=dark?0xFFA2BBFF:0xFF365FE1;
        INK=dark?0xFFF1F5FF:0xFF17233D;MUTED=dark?0xFFAFBED7:0xFF55647E;SOFT=dark?0xFF1B2942:0xFFEAF0FB;
        LINE=dark?0xFF2E3D59:0xFFDCE4F2;RED=dark?0xFFFFB3AA:0xFFA83232;
        getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(SURFACE);
        getWindow().getDecorView().setSystemUiVisibility(dark?0:View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }
    private void buildChrome(){
        root=column();root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        setContentView(root);root.requestApplyInsets();
        LinearLayout brand=row();brand.setPadding(dp(20),dp(14),dp(20),dp(12));
        ImageView logo=new ImageView(this);logo.setImageResource(R.drawable.logo);logo.setBackground(round(0xFF101A30,12));logo.setClipToOutline(true);logo.setContentDescription("Super Send");brand.addView(logo,new LinearLayout.LayoutParams(dp(40),dp(40)));
        LinearLayout name=column();name.setPadding(dp(11),0,dp(8),0);name.addView(text("Super Send",20,INK,true));name.addView(text("LOCAL FILE SHARING",10,MUTED,true));brand.addView(name,new LinearLayout.LayoutParams(0,-2,1));
        headerStatus=text("Starting",12,MUTED,true);headerStatus.setPadding(dp(11),dp(6),dp(11),dp(6));headerStatus.setBackground(round(SOFT,20));brand.addView(headerStatus);root.addView(brand);
        scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setClipToPadding(false);
        page=column();page.setPadding(dp(20),dp(8),dp(20),dp(24));
        int width=getResources().getConfiguration().screenWidthDp;FrameLayout.LayoutParams content=new FrameLayout.LayoutParams(width>760?dp(720):-1,-2,Gravity.TOP|Gravity.CENTER_HORIZONTAL);
        scroll.addView(page,content);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        navigation=row();navigation.setGravity(Gravity.CENTER);navigation.setPadding(dp(6),dp(8),dp(6),dp(8));navigation.setBackgroundColor(SURFACE);root.addView(navigation,new LinearLayout.LayoutParams(-1,-2));
    }
    private void renderNavigation(){
        if(tab.equals(navigationTab)&&navigation.getChildCount()>0)return;
        navigationTab=tab;navigation.removeAllViews();
        String[][] tabs={{"receive","Receive"},{"send","Send"},{"history","History"},{"settings","Settings"}};
        for(String[] item:tabs){
            boolean selected=tab.equals(item[0]);LinearLayout cell=column();cell.setGravity(Gravity.CENTER);cell.setMinimumHeight(dp(60));
            ImageView glyph=icon(item[0],24,selected?TEAL:MUTED);glyph.setPadding(dp(16),dp(4),dp(16),dp(4));if(selected)glyph.setBackground(round(dark?0xFF283F70:0xFFDEE8FF,20));
            cell.addView(glyph,new LinearLayout.LayoutParams(dp(56),dp(32)));
            TextView label=text(item[1],12,selected?TEAL:MUTED,selected);label.setGravity(Gravity.CENTER);cell.addView(label);
            cell.setContentDescription("Navigation: "+item[1]);cell.setFocusable(true);cell.setOnClickListener(v->navigate(item[0]));
            navigation.addView(cell,new LinearLayout.LayoutParams(0,-2,1));
        }
    }

    private void connect() {
        try {
            startForegroundService(new Intent(this, TransferService.class));
            if (!bound) bound = bindService(new Intent(this, TransferService.class), connection, Context.BIND_AUTO_CREATE);
        } catch (Exception error) { toast("Could not start sharing: " + TransferService.readable(error)); }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); sharedIntent = intent; consumeSharedIntent(); }
    @Override protected void onResume() {
        super.onResume(); resumed = true; transferRates.clear(); sampleTransferRates(); updateProgress(); queueSpeedTick();
    }
    @Override protected void onPause() {
        resumed = false; main.removeCallbacks(speedTick); speedTickQueued = false; transferRates.clear(); super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); out.putString("tab", tab); out.putString("pendingExport", pendingExport); out.putString("pendingExportMime", pendingExportMime); out.putString("historyQuery",historyQuery);out.putString("historyFilter",historyFilter);out.putStringArrayList("expanded",new ArrayList<>(expanded)); }
    @Override protected void onDestroy() {
        destroyed = true;
        if (incoming != null) incoming.dismiss();
        if (manualDialog != null) manualDialog.dismiss();
        if (service != null) service.unobserve(this);
        if (bound) unbindService(connection);
        files.shutdown(); main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
    @Override public void onState(JSONObject next) {
        state=next;
        if (resumed) { sampleTransferRates(); queueSpeedTick(); }
        checkManualConnection();
        if(headerStatus!=null){boolean ready=object("network").optBoolean("ready");headerStatus.setText(ready?"Ready":"Paused");headerStatus.setTextColor(ready?TEAL:MUTED);}
        String shape=shape();
        if(shape.equals(lastShape)){updateProgress();showIncoming();return;}
        if(!renderQueued){renderQueued=true;main.postDelayed(()->{renderQueued=false;if(!destroyed){render();showIncoming();}},100);}
    }
    private void checkManualConnection(){
        if(manualDialog==null||manualHost==null)return;
        JSONArray peers=array("peers");for(int i=0;i<peers.length();i++){
            JSONObject peer=peers.optJSONObject(i);
            if(peer!=null&&manualHost.equalsIgnoreCase(peer.optString("host"))&&manualPort==peer.optInt("port")){
                manualHost=null;manualDialog.dismiss();manualDialog=null;navigate("send");toast("Device connected. Choose it to send your selection.");return;
            }
        }
        String error=object("network").optString("error","");if(error.isEmpty())manualOldError="";else if(!error.equals(manualOldError))manualConnectionError(error);
    }
    private void manualConnectionError(String message){
        manualHost=null;if(manualDialog==null)return;manualError.setText(message);manualError.setVisibility(View.VISIBLE);
        manualDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);manualDialog.getButton(AlertDialog.BUTTON_POSITIVE).setText("Connect");
    }
    private String shape(){
        StringBuilder out=new StringBuilder(tab).append(object("device").toString()).append(object("settings").toString()).append(object("network").toString()).append(array("selection").toString());
        JSONArray peers=array("peers");for(int i=0;i<peers.length();i++){JSONObject p=peers.optJSONObject(i);if(p!=null)out.append(p.optString("id")).append(p.optString("alias")).append(p.optString("host"));}
        for(JSONObject t:allTransfers()){
            out.append(t.optString("id")).append(t.optString("status")).append(t.optString("error"));JSONArray fs=t.optJSONArray("files");
            if(fs!=null)for(int i=0;i<fs.length();i++){JSONObject f=fs.optJSONObject(i);if(f!=null)out.append(f.optString("id")).append(f.optString("status")).append(f.optString("path"));}
        }
        return out.toString();
    }
    private void updateProgress(){
        for(JSONObject t:allTransfers()){
            String id=t.optString("id");ProgressBar bar=progressBars.get(id);TextView label=progressLabels.get(id);
            if(bar!=null){bar.setIndeterminate("waiting".equals(t.optString("status")));bar.setProgress((int)(Math.max(0,Math.min(1,t.optDouble("progress")))*1000));}
            if(label!=null)label.setText(progressText(t));
        }
    }
    private String progressText(JSONObject t){String detail=t.optString("statusDetail","");if("waiting".equals(t.optString("status")))return detail.isEmpty()?"Waiting for approval":detail;String progress=bytes(t.optLong("transferred"))+" / "+bytes(t.optLong("total"))+"  ·  "+Math.round(t.optDouble("progress")*100)+"%";if("transferring".equals(t.optString("status"))){TransferRate rate=transferRates.get(t.optString("id"));progress+="\n"+(rate==null?"Measuring speed…":rate.label());}return detail.isEmpty()?progress:detail+"\n"+progress;}

    /** A short observed-byte window; approval time and time with the screen paused are excluded. */
    private static final class TransferRate {
        private final ArrayDeque<long[]> samples = new ArrayDeque<>();
        void observe(long bytes, long now) {
            long[] latest = samples.peekLast();
            if (latest != null && (bytes < latest[1] || now < latest[0])) { samples.clear(); latest = null; }
            if (latest != null && now == latest[0]) latest[1] = bytes;
            else samples.addLast(new long[]{now, bytes});
            // Keep the first point within the two-second window, making a stalled
            // transfer settle to zero even when no transport events arrive.
            while (samples.size() > 1 && samples.peekFirst()[0] < now - 2000) samples.removeFirst();
        }
        String label() {
            long[] first = samples.peekFirst(), last = samples.peekLast();
            if (first == null || last[0] - first[0] < 250) return "Measuring speed…";
            double megabytesPerSecond = (last[1] - first[1]) / ((last[0] - first[0]) * 1000.0);
            return String.format(Locale.getDefault(), "%.1f MB/s", Math.max(0, megabytesPerSecond));
        }
    }
    private void sampleTransferRates() {
        Set<String> activeIds = new HashSet<>(); long now = SystemClock.elapsedRealtime();
        for (JSONObject transfer : allTransfers()) if ("transferring".equals(transfer.optString("status"))) {
            String id = transfer.optString("id"); activeIds.add(id);
            TransferRate rate = transferRates.get(id);
            if (rate == null) { rate = new TransferRate(); transferRates.put(id, rate); }
            rate.observe(transfer.optLong("transferred"), now);
        }
        transferRates.keySet().retainAll(activeIds);
    }
    private void queueSpeedTick() {
        if (resumed && !destroyed && !speedTickQueued && !transferRates.isEmpty()) {
            speedTickQueued = true; main.postDelayed(speedTick, 500);
        }
    }

    private JSONObject object(String key) { JSONObject o = state.optJSONObject(key); return o == null ? new JSONObject() : o; }
    private JSONArray array(String key) { JSONArray a = state.optJSONArray(key); return a == null ? new JSONArray() : a; }
    private String alias() { return object("device").optString("alias", getSharedPreferences("localsend", MODE_PRIVATE).getString("alias", Build.MODEL)); }
    private void command(TransferService.Operation operation) {
        if (service == null) { toast("Local sharing is starting…"); return; }
        service.execute(operation, error -> { if (error != null) toast(error); });
    }
    private void navigate(String next) { tab = next; scroll.scrollTo(0, 0); render(); }
    private void render() {
        if(page==null||destroyed)return;
        int position=scroll.getScrollY();View focused=root.findFocus();Object tag=focused==null?null:focused.getTag();int cursor=focused instanceof EditText?((EditText)focused).getSelectionStart():-1;
        page.removeAllViews();progressBars.clear();progressLabels.clear();historyBody=null;renderNavigation();
        heading(title(tab),"receive".equals(tab)?"Your files. Your devices. Your way.":"send".equals(tab)?"Choose what to share, then a device.":"history".equals(tab)?"Your files and messages, in one place.":"Set up sharing your way.");
        JSONObject network=object("network");String error=network.optString("error","");if(!error.isEmpty())note(error,true);
        if(service==null||!network.optBoolean("ready")){
            LinearLayout status=card();status.addView(text(service!=null&&service.running()?"Starting local sharing…":"Sharing is paused",17,INK,true));
            status.addView(text("Start sharing to send and receive on this network.",14,MUTED,false));gap(status,8);status.addView(button("Start sharing",true,v->connect()));
        }
        if("receive".equals(tab))renderReceive();else if("send".equals(tab))renderSend();else if("history".equals(tab))renderHistory();else renderSettings();
        lastShape=shape();updateProgress();
        if(tag!=null){View restored=root.findViewWithTag(tag);if(restored!=null){restored.requestFocus();if(restored instanceof EditText&&cursor>=0)((EditText)restored).setSelection(Math.min(cursor,((EditText)restored).length()));}}
        scroll.post(()->{if(!destroyed)scroll.scrollTo(0,position);});
    }

    private void renderReceive(){
        activeTransfers();
        LinearLayout hero=card();hero.setGravity(Gravity.CENTER_HORIZONTAL);GradientDrawable station=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{dark?0xFF192D53:0xFFEDF3FF,SURFACE});station.setCornerRadius(dp(22));station.setStroke(dp(1),LINE);hero.setBackground(station);
        TextView eyebrow=text("YOUR RECEIVE STATION",11,MUTED,true);eyebrow.setLetterSpacing(.12f);hero.addView(eyebrow);gap(hero,14);
        ImageView train=new ImageView(this);train.setImageResource(R.drawable.logo);train.setContentDescription("Super Send bullet train");train.setScaleType(ImageView.ScaleType.CENTER_CROP);train.setBackground(round(0xFF101A30,20));train.setClipToOutline(true);hero.addView(train,new LinearLayout.LayoutParams(dp(160),dp(112)));gap(hero,16);
        TextView name=text(alias(),26,INK,true);name.setGravity(Gravity.CENTER);hero.addView(name);
        TextView help=text("On your PC, connect to this phone in Super Send.",14,MUTED,false);help.setGravity(Gravity.CENTER);hero.addView(help);gap(hero,12);
        JSONArray addresses=object("device").optJSONArray("addresses");
        if(addresses!=null&&addresses.length()>0){String address=addresses.optString(0);hero.addView(button(address+"  ·  Copy IP",false,v->copy("Local IP",address)));}
        TextView details=text("HTTPS  ·  Port "+object("device").optInt("port",53317),12,MUTED,false);details.setTextIsSelectable(true);hero.addView(details);
        LinearLayout folder=card();sectionTitle(folder,"folder","Receive folder");folder.addView(text(storage().description(),14,MUTED,false));gap(folder,8);folder.addView(button("Change folder",false,v->chooseFolder()));
        LinearLayout quick=card();quickSave(quick);
        note("Keep both devices on the same Wi-Fi. Your PC can connect to this phone using the IP and port above. You approve incoming files unless Quick save is enabled.",false);
    }
    private void quickSave(LinearLayout parent){
        Switch toggle=new Switch(this);toggle.setText("Quick save");toggle.setTextColor(INK);toggle.setTextSize(16);toggle.setMinHeight(dp(48));toggle.setPadding(0,dp(6),0,dp(6));
        toggle.setThumbTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{dark?0xFF101C38:Color.WHITE,dark?0xFFAFBED7:Color.WHITE}));
        toggle.setTrackTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{TEAL,dark?0xFF55647E:0xFF8D9DB8}));
        toggle.setChecked(object("settings").optBoolean("autoAccept",getSharedPreferences("localsend",MODE_PRIVATE).getBoolean("autoAccept",false)));
        toggle.setOnCheckedChangeListener((v,yes)->{if(service!=null)service.updateSettings(alias(),yes,e->{if(e!=null)toast(e);});});parent.addView(toggle,new LinearLayout.LayoutParams(-1,-2));
        parent.addView(text("Automatically accept incoming files and messages.",13,MUTED,false));
    }

    private AndroidStorage storage() { return service == null ? new AndroidStorage(this) : service.storage(); }
    private void renderSend(){
        activeTransfers();
        LinearLayout selected=card();sectionTitle(selected,"file","Selection");LinearLayout actions=row();addWeighted(actions,button("Files",true,v->pickFiles()));addWeighted(actions,button("Text",false,v->messageDialog()));selected.addView(actions);
        selected.addView(button("Paste text",false,v->pasteClipboard()));JSONArray selection=array("selection");long total=0;
        if(preparing)selected.addView(text("Preparing selected files…",14,TEAL,false));
        if(selection.length()==0){gap(selected,10);selected.addView(text("Photos, documents or a message — choose something to send.",14,MUTED,false));}
        for(int i=0;i<selection.length();i++){
            JSONObject f=selection.optJSONObject(i);if(f==null)continue;total+=f.optLong("size");LinearLayout item=row();item.setPadding(0,dp(10),0,dp(10));
            ImageView glyph=icon("text".equals(f.optString("type"))?"text":"file",22,TEAL);item.addView(glyph,new LinearLayout.LayoutParams(dp(32),dp(38)));
            LinearLayout detail=column();TextView name=text(f.optString("name"),14,INK,true);name.setMaxLines(2);name.setEllipsize(TextUtils.TruncateAt.END);name.setMinHeight(dp(48));name.setOnClickListener(v->dialogBuilder().setTitle("Selected file").setMessage(f.optString("name")+"\n\n"+bytes(f.optLong("size"))).setPositiveButton("Close",null).show());detail.addView(name);detail.addView(text(bytes(f.optLong("size")),12,MUTED,false));item.addView(detail,new LinearLayout.LayoutParams(0,-2,1));
            item.addView(iconButton("close","Remove "+f.optString("name"),v->command(e->e.removeSelection(f.optString("id")))));selected.addView(item);
        }
        if(selection.length()>0){selected.addView(text(selection.length()+(selection.length()==1?" item":" items")+" · "+bytes(total),13,MUTED,true));selected.addView(button("Clear selection",false,v->command(TransferEngine::clearSelection)));}
        LinearLayout peers=card();sectionTitle(peers,"wifi","Nearby devices");LinearLayout tools=row();addWeighted(tools,button("Refresh",false,v->command(TransferEngine::discover)));addWeighted(tools,button("Add by IP",false,v->addDeviceDialog()));peers.addView(tools);
        JSONArray devices=array("peers");
        if(devices.length()==0){gap(peers,18);ImageView radar=icon("wifi",32,TEAL);peers.addView(radar,new LinearLayout.LayoutParams(dp(40),dp(40)));peers.addView(text("No devices found yet",16,INK,true));peers.addView(text("Open Super Send on your PC and connect to the same Wi-Fi. You can also add its IP address.",14,MUTED,false));}
        for(int i=0;i<devices.length();i++){
            JSONObject peer=devices.optJSONObject(i);if(peer==null)continue;gap(peers,12);LinearLayout device=column();device.setBackground(round(SOFT,14));device.setPadding(dp(14),dp(14),dp(14),dp(14));
            LinearLayout summary=row();summary.addView(icon("mobile".equals(peer.optString("deviceType"))?"phone":"desktop",24,TEAL),new LinearLayout.LayoutParams(dp(38),dp(42)));
            LinearLayout detail=column();TextView name=text(peer.optString("alias","Nearby device"),17,INK,true);name.setMaxLines(2);name.setEllipsize(TextUtils.TruncateAt.END);detail.addView(name);detail.addView(text(peer.optString("deviceModel","Device"),13,MUTED,false));summary.addView(detail,new LinearLayout.LayoutParams(0,-2,1));device.addView(summary);gap(device,8);
            boolean busy=false;for(JSONObject t:allTransfers())if(active(t)&&"send".equals(t.optString("direction"))&&peer.optString("alias").equals(t.optString("peer")))busy=true;
            Button send=button(busy?"Transfer in progress":"Send to device",true,v->{command(e->e.send(peer.optString("id")));navigate("history");});send.setEnabled(selection.length()>0&&!preparing&&!busy&&object("network").optBoolean("ready"));device.addView(send,new LinearLayout.LayoutParams(-1,-2));peers.addView(device);
        }
    }
    private void renderHistory(){
        LinearLayout filters=row();for(String[] filter:new String[][]{{"all","All"},{"receive","Received"},{"send","Sent"}}){Button chip=button(filter[1],historyFilter.equals(filter[0]),v->{historyFilter=filter[0];render();});addWeighted(filters,chip);}page.addView(filters);gap(page,12);
        EditText search=input("Search files or devices",false);search.setTag("historySearch");search.setText(historyQuery);search.setContentDescription("Search transfers");page.addView(search,new LinearLayout.LayoutParams(-1,dp(50)));gap(page,14);
        historyBody=column();page.addView(historyBody,new LinearLayout.LayoutParams(-1,-2));fillHistory();
        search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence x,int a,int c,int d){}public void onTextChanged(CharSequence x,int a,int b,int c){historyQuery=x.toString();fillHistory();}public void afterTextChanged(Editable x){}});
    }
    private void fillHistory(){
        if(historyBody==null)return;historyBody.removeAllViews();progressBars.clear();progressLabels.clear();int matches=0;String query=historyQuery.trim().toLowerCase(Locale.ROOT);
        for(JSONObject transfer:allTransfers()){
            if(!"all".equals(historyFilter)&&!historyFilter.equals(transfer.optString("direction")))continue;
            StringBuilder haystack=new StringBuilder(transfer.optString("peer"));JSONArray fs=transfer.optJSONArray("files");if(fs!=null)for(int i=0;i<fs.length();i++){JSONObject f=fs.optJSONObject(i);if(f!=null)haystack.append(' ').append(f.optString("name"));}
            if(!query.isEmpty()&&!haystack.toString().toLowerCase(Locale.ROOT).contains(query))continue;
            transferCard(historyBody,transfer);matches++;
        }
        if(matches==0){LinearLayout empty=card(historyBody);empty.setGravity(Gravity.CENTER);gap(empty,18);empty.addView(icon("history",38,TEAL),new LinearLayout.LayoutParams(dp(52),dp(52)));gap(empty,12);empty.addView(text(allTransfers().isEmpty()?"No transfers yet":"No matching transfers",18,INK,true));TextView help=text(allTransfers().isEmpty()?"Files and messages you share will appear here.":"Try another search or filter.",14,MUTED,false);help.setGravity(Gravity.CENTER);empty.addView(help);gap(empty,18);}
        updateProgress();
    }
    private void renderSettings(){
        LinearLayout device=card();sectionTitle(device,"phone","Your device");device.addView(text(alias(),20,INK,true));device.addView(text("The name other devices see on your network.",13,MUTED,false));gap(device,8);device.addView(button("Rename device",false,v->renameDialog()));
        LinearLayout receiving=card();sectionTitle(receiving,"folder","Receiving");receiving.addView(text(storage().description(),14,MUTED,false));gap(receiving,8);receiving.addView(button("Choose folder",false,v->chooseFolder()));receiving.addView(button("Use default folder",false,v->{storage().useDefault();render();}));gap(receiving,12);quickSave(receiving);
        LinearLayout appearance=card();sectionTitle(appearance,"settings","Appearance");appearance.addView(text("Choose a comfortable look for this device.",13,MUTED,false));RadioGroup choices=new RadioGroup(this);String preference=getSharedPreferences("localsend",MODE_PRIVATE).getString("theme","dark");
        for(String mode:new String[]{"system","light","dark"}){RadioButton radio=new RadioButton(this);radio.setId(View.generateViewId());radio.setText("system".equals(mode)?"Follow system":title(mode));radio.setTextColor(INK);radio.setTextSize(15);radio.setButtonTintList(ColorStateList.valueOf(TEAL));radio.setMinHeight(dp(48));radio.setChecked(preference.equals(mode));radio.setOnClickListener(v->{if(!preference.equals(mode)){getSharedPreferences("localsend",MODE_PRIVATE).edit().putString("theme",mode).apply();recreate();}});choices.addView(radio,new RadioGroup.LayoutParams(-1,-2));}appearance.addView(choices);
        LinearLayout network=card();sectionTitle(network,"wifi","Connection");JSONObject info=object("device");JSONArray addresses=info.optJSONArray("addresses");
        if(addresses!=null)for(int i=0;i<addresses.length();i++){String address=addresses.optString(i);network.addView(button(address+"  ·  Copy",false,v->copy("Local IP",address)));}
        network.addView(text("HTTPS · Port "+info.optInt("port",53317),14,MUTED,false));gap(network,8);network.addView(button("Add device by IP",false,v->addDeviceDialog()));network.addView(button("Refresh devices",false,v->command(TransferEngine::discover)));
        String fingerprint=info.optString("fingerprint","");if(!fingerprint.isEmpty())network.addView(button("Copy device fingerprint",false,v->copy("Device fingerprint",fingerprint)));
        Button stop=button(object("network").optBoolean("ready")?"Stop sharing":"Start sharing",false,v->{if(service!=null&&service.running())service.stopSharing();else connect();});if(object("network").optBoolean("ready"))stop.setTextColor(RED);network.addView(stop);
        LinearLayout about=card();sectionTitle(about,"info","Super Send");String version="1.6.0";try{version=getPackageManager().getPackageInfo(getPackageName(),0).versionName;}catch(Exception ignored){}about.addView(text("Version "+version,13,MUTED,false));about.addView(text("Share directly with nearby devices. Your files stay between you and the device you choose.",14,MUTED,false));
    }

    private void activeTransfers() {
        for (JSONObject t : allTransfers()) if (active(t)) transferCard(t);
    }
    private List<JSONObject> allTransfers() {
        LinkedHashMap<String, JSONObject> merged = new LinkedHashMap<>();
        JSONArray history = array("history"), transfers = array("transfers");
        for (int i = 0; i < history.length(); i++) { JSONObject t = history.optJSONObject(i); if (t != null) merged.put(t.optString("id"), t); }
        for (int i = 0; i < transfers.length(); i++) { JSONObject t = transfers.optJSONObject(i); if (t != null) merged.put(t.optString("id"), t); }
        List<JSONObject> all = new ArrayList<>(merged.values()); all.sort((a, b) -> Long.compare(b.optLong("createdAt"), a.optLong("createdAt"))); return all;
    }
    private boolean active(JSONObject t) { return "waiting".equals(t.optString("status")) || "transferring".equals(t.optString("status")); }
    private void transferCard(JSONObject t){transferCard(page,t);}
    private void transferCard(LinearLayout parent,JSONObject t){
        LinearLayout card=card(parent);String id=t.optString("id");boolean sending="send".equals(t.optString("direction")),isActive=active(t),opened=expanded.contains(id);String status=t.optString("status");
        LinearLayout summary=row();summary.setMinimumHeight(dp(52));summary.addView(icon(sending?"send":"receive",24,TEAL),new LinearLayout.LayoutParams(dp(38),dp(40)));
        LinearLayout detail=column();TextView peer=text((sending?"To ":"From ")+t.optString("peer","Nearby device"),16,INK,true);peer.setMaxLines(2);peer.setEllipsize(TextUtils.TruncateAt.END);detail.addView(peer);
        JSONArray entries=t.optJSONArray("files");int count=entries==null?0:entries.length();detail.addView(text(count+(count==1?" item":" items")+" · "+bytes(t.optLong("total")),12,MUTED,false));summary.addView(detail,new LinearLayout.LayoutParams(0,-2,1));
        summary.addView(icon(opened?"down":"chevron",20,MUTED),new LinearLayout.LayoutParams(dp(24),dp(36)));summary.setContentDescription((opened?"Hide":"Show")+" transfer details for "+t.optString("peer"));summary.setFocusable(true);summary.setOnClickListener(v->{if(!expanded.add(id))expanded.remove(id);render();});card.addView(summary);
        String label="waiting".equals(status)?"Waiting for approval":"transferring".equals(status)?(sending?"Sending":"Receiving"):"completed".equals(status)?"Completed":"rejected".equals(status)?"Declined":title(status);
        card.addView(text(label,13,"failed".equals(status)||"rejected".equals(status)?RED:TEAL,true));
        if(isActive){
            ProgressBar bar=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);bar.setMax(1000);bar.setProgressTintList(ColorStateList.valueOf(TEAL));bar.setIndeterminateTintList(ColorStateList.valueOf(TEAL));bar.setProgressBackgroundTintList(ColorStateList.valueOf(LINE));card.addView(bar,new LinearLayout.LayoutParams(-1,dp(14)));progressBars.put(id,bar);
            TextView progress=text(progressText(t),12,MUTED,false);card.addView(progress);progressLabels.put(id,progress);gap(card,8);Button cancel=button("Cancel transfer",false,v->command(e->e.cancelTransfer(id)));cancel.setTextColor(RED);card.addView(cancel);
        }else if(t.optLong("createdAt")>0)card.addView(text(DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(new Date(t.optLong("createdAt"))),12,MUTED,false));
        if(!t.optString("error").isEmpty())card.addView(text(t.optString("error"),13,RED,false));
        if(opened&&entries!=null)for(int i=0;i<entries.length();i++){
            JSONObject file=entries.optJSONObject(i);if(file==null)continue;gap(card,14);card.addView(text(file.optString("name",file.optString("fileName","File")),14,INK,true));card.addView(text(bytes(file.optLong("size")),12,MUTED,false));String content=file.optString("text","");
            if(!content.isEmpty()){Button view=button("View message",false,v->showMessage(content));card.addView(view);card.addView(button("Copy message",false,v->copy("Message",content)));}
            String path=file.optString("path","");if(!path.isEmpty()&&"completed".equals(file.optString("status"))){LinearLayout actions=row();if(path.startsWith("content://"))addWeighted(actions,button("Open",false,v->openReceived(file)));addWeighted(actions,button("Save a copy",false,v->exportFile(file)));card.addView(actions);}
        }
    }
    private void showMessage(String content){TextView text=text(content,15,INK,false);text.setTextIsSelectable(true);text.setPadding(dp(22),dp(12),dp(22),dp(12));ScrollView body=new ScrollView(this);body.addView(text);dialogBuilder().setTitle("Message").setView(body).setPositiveButton("Copy",(d,w)->copy("Message",content)).setNegativeButton("Close",null).show();}
    private AlertDialog.Builder dialogBuilder(){
        return new AlertDialog.Builder(new ContextThemeWrapper(this,dark?R.style.AppDialogDark:R.style.AppDialogLight)){
            @Override public AlertDialog create(){
                AlertDialog dialog=super.create();dialog.setOnShowListener(d->{
                    if(dialog.getWindow()!=null){dialog.getWindow().setBackgroundDrawable(round(SURFACE,20));dialog.getWindow().getDecorView().setClipToOutline(true);dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);}
                });return dialog;
            }
        };
    }
    private ScrollView dialogForm(View content){
        ScrollView body=new ScrollView(this){
            @Override protected void onMeasure(int widthSpec,int heightSpec){
                int limit=(int)(getResources().getDisplayMetrics().heightPixels*.55f);
                if(View.MeasureSpec.getMode(heightSpec)!=View.MeasureSpec.UNSPECIFIED)limit=Math.min(limit,View.MeasureSpec.getSize(heightSpec));
                super.onMeasure(widthSpec,View.MeasureSpec.makeMeasureSpec(limit,View.MeasureSpec.AT_MOST));
            }
        };
        body.setTag("dialogForm");body.setClipToPadding(false);body.addView(content);return body;
    }

    private void showIncoming() {
        JSONArray requests = array("requests"); JSONObject request = requests.optJSONObject(0);
        if (request == null) {
            if (incoming != null) incoming.dismiss(); incoming = null; requestShown = ""; return;
        }
        String id = request.optString("id");
        if (requestShown.equals(id)) return;
        if (incoming != null) incoming.dismiss(); requestShown = id;
        StringBuilder message = new StringBuilder(request.optString("alias", "Nearby device") + " wants to send you:\n\n");
        JSONArray items = request.optJSONArray("files"); long total = 0;
        if (items != null) for (int i = 0; i < items.length(); i++) { JSONObject f = items.optJSONObject(i); if (f == null) continue; total += f.optLong("size"); if (i < 10) message.append("• ").append(f.optString("fileName", "File")).append("  (").append(bytes(f.optLong("size"))).append(")\n"); }
        if (items != null && items.length() > 10) message.append("… and ").append(items.length() - 10).append(" more items\n");
        message.append("\n").append(bytes(total)).append(" total\nSave to ").append(storage().description());
        incoming = dialogBuilder().setTitle("Incoming transfer").setMessage(message)
                .setPositiveButton("Accept", (d, w) -> { command(e -> e.respond(id, true)); incoming = null; })
                .setNegativeButton("Decline", (d, w) -> { command(e -> e.respond(id, false)); incoming = null; }).setCancelable(false).create();
        incoming.show();
    }
    private void renameDialog() {
        EditText name = input("Device name", false); name.setText(alias()); name.setSelectAllOnFocus(true);
        AlertDialog dialog = dialogBuilder().setTitle("Rename device").setView(dialogForm(padded(name))).setPositiveButton("Save", null).setNegativeButton("Cancel", null).create(); dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String value = name.getText().toString().trim(); if (value.isEmpty() || value.length() > 80) { name.setError("Use 1–80 characters"); return; }
            if (service != null) service.updateSettings(value, object("settings").optBoolean("autoAccept"), error -> { if (error != null) toast(error); else dialog.dismiss(); });
        });
    }
    private void messageDialog() {
        EditText message = input("Write a message…", true); message.setMinLines(3); message.setMaxLines(8); message.setGravity(Gravity.TOP); message.setVerticalScrollBarEnabled(true);
        LinearLayout fields=padded(message);TextView validation=text("",13,RED,false);validation.setVisibility(View.GONE);fields.addView(validation);
        AlertDialog dialog = dialogBuilder().setTitle("Send a message").setView(dialogForm(fields)).setPositiveButton("Add message", null).setNegativeButton("Cancel", null).create(); dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String value = message.getText().toString(); if (value.trim().isEmpty()) { message.setError("Enter a message");message.requestFocus();validation.setText("Write a message before adding it.");validation.setVisibility(View.VISIBLE); return; }
            if (service != null) service.execute(e -> e.addText(value), error -> { if (error != null) toast(error); else dialog.dismiss(); });
        });
    }
    private void pasteClipboard() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) { toast("The clipboard is empty."); return; }
        CharSequence text = clip.getItemAt(0).getText();
        if (text == null || text.toString().trim().isEmpty()) { toast("The clipboard has no text."); return; }
        command(e -> e.addText(text.toString()));
    }
    private void addDeviceDialog() {
        LinearLayout fields = column(); fields.setPadding(dp(22), dp(5), dp(22), 0);
        fields.addView(text("IP address",13,MUTED,true));
        EditText host = input("PC IP address, e.g. 192.168.1.10", false); host.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); fields.addView(host);
        fields.addView(text("Port",13,MUTED,true));
        EditText port = input("Port", false); port.setText("53317"); port.setInputType(android.text.InputType.TYPE_CLASS_NUMBER); fields.addView(port);
        fields.addView(text("Protocol",13,MUTED,true));
        Context dialogContext = new ContextThemeWrapper(this, dark ? R.style.AppDialogDark : R.style.AppDialogLight);
        Spinner protocol = new Spinner(dialogContext); protocol.setMinimumHeight(dp(48)); protocol.setAdapter(new ArrayAdapter<>(dialogContext, android.R.layout.simple_spinner_dropdown_item, new String[]{"HTTPS (encrypted)", "HTTP"})); fields.addView(protocol);
        fields.addView(text("Use the IP, port and protocol shown on your PC's Receive or Settings screen.", 12, MUTED, false));
        manualError=text("",13,RED,false);manualError.setVisibility(View.GONE);fields.addView(manualError);
        AlertDialog dialog = dialogBuilder().setTitle("Add PC by IP").setView(dialogForm(fields)).setPositiveButton("Connect", null).setNegativeButton("Cancel", null).create(); dialog.show();
        manualDialog=dialog;dialog.setOnDismissListener(d->{if(manualDialog==dialog){manualDialog=null;manualHost=null;}});
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            int number; try { number = Integer.parseInt(port.getText().toString()); if (number < 1 || number > 65535) throw new NumberFormatException(); } catch (NumberFormatException ex) { port.setError("Use a port from 1 to 65535");port.requestFocus();manualError.setText("Use a port from 1 to 65535.");manualError.setVisibility(View.VISIBLE); return; }
            String address = host.getText().toString().trim();
            if (address.isEmpty()) { host.setError("Enter the PC's IP address");host.requestFocus();manualError.setText("Enter the IP address shown on your PC.");manualError.setVisibility(View.VISIBLE); return; }
            String scheme = protocol.getSelectedItemPosition() == 0 ? "https" : "http"; final int peerPort = number;
            if (service != null) {
                manualHost=address;manualPort=peerPort;manualOldError=object("network").optString("error","");manualError.setVisibility(View.GONE);dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);dialog.getButton(AlertDialog.BUTTON_POSITIVE).setText("Connecting…");
                service.execute(e -> e.addPeer(address, peerPort, scheme), error -> { if(error!=null)manualConnectionError(error); });
                main.postDelayed(()->{if(manualDialog==dialog&&manualHost!=null)manualConnectionError("The device did not respond. Check its IP, port and Wi-Fi connection.");},10000);
            }
        });
    }
    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_FILES); } catch (Exception e) { toast("No document picker is available on this phone."); }
    }
    private void chooseFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_FOLDER); } catch (Exception e) { toast("No folder picker is available on this phone."); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data); if (result != RESULT_OK || data == null) return;
        if (request == PICK_FILES) {
            List<Uri> uris = new ArrayList<>(); if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) uris.add(data.getData());
            for (Uri uri : uris) try { getContentResolver().takePersistableUriPermission(uri, data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
            prepareSources(uris);
        } else if (request == PICK_FOLDER && data.getData() != null) {
            Uri uri = data.getData(); int grant = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            files.execute(() -> { String error = null; try { getContentResolver().takePersistableUriPermission(uri, grant); storage().selectFolder(uri); } catch (Exception e) { error = TransferService.readable(e); }
                final String message = error; main.post(() -> { if (destroyed) return; toast(message == null ? "Receive folder updated" : message); render(); }); });
        } else if (request == SAVE_COPY && data.getData() != null && pendingExport != null) {
            String source = pendingExport; Uri destination = data.getData(); pendingExport = null;
            files.execute(() -> {
                String error = null;
                try (InputStream in = source.startsWith("content://") ? getContentResolver().openInputStream(Uri.parse(source)) : new FileInputStream(source); OutputStream out = getContentResolver().openOutputStream(destination, "w")) {
                    if (in == null || out == null) throw new java.io.IOException("The file could not be opened.");
                    byte[] buffer = new byte[65536]; int n; while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                } catch (Exception e) { error = TransferService.readable(e); }
                final String message = error; main.post(() -> { if (!destroyed) toast(message == null ? "Copy saved" : "Could not save the copy: " + message); });
            });
        }
    }
    private void prepareSources(List<Uri> uris) {
        if (uris.isEmpty()) return;
        if (service == null) { toast("Wait for local sharing to start, then choose the files again."); return; }
        final TransferService target = service;
        final ContentResolver resolver = getApplicationContext().getContentResolver();
        preparing = true; tab = "send"; render();
        files.execute(() -> {
            List<TransferEngine.Source> ready = new ArrayList<>(); List<String> errors = new ArrayList<>();
            for (Uri uri : uris) {
                File temporary = null;
                try {
                    if (uri == null || !("content".equals(uri.getScheme()) || "file".equals(uri.getScheme()))) throw new java.io.IOException("Unsupported file location");
                    String name = uri.getLastPathSegment() == null ? "Shared file" : uri.getLastPathSegment(); long size = -1;
                    try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                        if (c != null && c.moveToFirst()) { int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE); if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni); if (si >= 0 && !c.isNull(si)) size = c.getLong(si); }
                    } catch (RuntimeException unavailableMetadata) { size = -1; }
                    name = AndroidStorage.safeName(name); String mime = resolver.getType(uri); if (mime == null) mime = AndroidStorage.mime(name);
                    if (size < 0) {
                        File folder = new File(getCacheDir(), "outgoing"); if (!folder.isDirectory() && !folder.mkdirs()) throw new java.io.IOException("Could not prepare the shared file");
                        temporary = new File(folder, UUID.randomUUID().toString()); size = 0;
                        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(temporary)) {
                            if (in == null) throw new java.io.IOException("Could not read the shared file");
                            byte[] buffer = new byte[65536]; int n; while ((n = in.read(buffer)) != -1) { out.write(buffer, 0, n); size += n; }
                        }
                    }
                    final File cached = temporary; final Uri source = uri;
                    ready.add(new TransferEngine.Source(name, size, mime, null, () -> {
                        InputStream in = cached == null ? resolver.openInputStream(source) : new FileInputStream(cached);
                        if (in == null) throw new java.io.IOException("The selected file is no longer available. Select it again."); return in;
                    }));
                } catch (Exception e) { if (temporary != null) temporary.delete(); errors.add(TransferService.readable(e)); }
            }
            target.execute(engine -> { for (TransferEngine.Source source : ready) engine.addSource(source); }, error -> {
                preparing = false; if (destroyed) return; render();
                if (error != null) toast(error); else if (!errors.isEmpty()) toast("Some files could not be added: " + errors.get(0)); else toast(ready.size() + (ready.size() == 1 ? " file added" : " files added"));
            });
        });
    }
    private void consumeSharedIntent() {
        if (sharedIntent == null || service == null) return;
        Intent intent = sharedIntent; sharedIntent = null;
        String action = intent.getAction(); if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) { ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (list != null) uris.addAll(list); }
        else { Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri); }
        if (uris.isEmpty() && intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) { Uri uri = intent.getClipData().getItemAt(i).getUri(); if (uri != null) uris.add(uri); }
        CharSequence message = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (message != null && !message.toString().trim().isEmpty()) command(e -> e.addText(message.toString()));
        tab = "send"; if (!uris.isEmpty()) prepareSources(uris); else render();
        setIntent(new Intent(this, MainActivity.class));
    }
    private void openReceived(JSONObject file) {
        String location = file.optString("path"); if (!location.startsWith("content://")) { exportFile(file); return; }
        Uri uri = Uri.parse(location); String mime = AndroidStorage.mime(file.optString("name"));
        try {
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            view.setClipData(ClipData.newRawUri("Received file", uri));
            startActivity(view);
        }
        catch (Exception e) { dialogBuilder().setTitle("Open file").setMessage("No installed app can open this type of file. You can save another copy using the system file picker.").setPositiveButton("Save a copy", (d, w) -> exportFile(file)).setNegativeButton("Close", null).show(); }
    }
    private void exportFile(JSONObject file) {
        pendingExport = file.optString("path"); pendingExportMime = AndroidStorage.mime(file.optString("name"));
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(pendingExportMime).putExtra(Intent.EXTRA_TITLE, file.optString("name", "Received file")), SAVE_COPY); }
        catch (Exception e) { toast("No document picker is available to save this file."); }
    }
    private void copy(String label, String value) { ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText(label, value)); if (Build.VERSION.SDK_INT < 33) toast("Copied"); }
    private void toast(String value) { if (!destroyed) Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
    private int dp(float n) { return (int)(getResources().getDisplayMetrics().density * n + 0.5f); }
    private LinearLayout column() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.VERTICAL); return v; }
    private LinearLayout row() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.HORIZONTAL); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    private TextView text(String value,float size,int color,boolean bold){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setTypeface(Typeface.create("sans-serif",bold?Typeface.BOLD:Typeface.NORMAL));v.setLineSpacing(dp(2),1);v.setPadding(0,dp(3),0,dp(3));return v;}
    private ImageView icon(String name,int size,int color){ImageView view=new ImageView(this);view.setImageDrawable(new UiIcon(name,color,dp(size)));view.setScaleType(ImageView.ScaleType.CENTER_INSIDE);view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);return view;}
    private View iconButton(String glyph,String label,View.OnClickListener click){ImageView view=icon(glyph,20,MUTED);view.setPadding(dp(14),dp(14),dp(14),dp(14));view.setBackground(new RippleDrawable(ColorStateList.valueOf(SOFT),round(SURFACE,12),null));view.setContentDescription(label);view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);view.setFocusable(true);view.setClickable(true);view.setOnClickListener(click);view.setLayoutParams(new LinearLayout.LayoutParams(dp(48),dp(48)));return view;}
    private void sectionTitle(LinearLayout parent,String glyph,String title){LinearLayout line=row();line.addView(icon(glyph,20,TEAL),new LinearLayout.LayoutParams(dp(30),dp(34)));line.addView(text(title,17,INK,true),new LinearLayout.LayoutParams(0,-2,1));parent.addView(line,new LinearLayout.LayoutParams(-1,-2));gap(parent,8);}
    private GradientDrawable round(int color,int radius){GradientDrawable bg=new GradientDrawable();bg.setColor(color);bg.setCornerRadius(dp(radius));return bg;}
    private Button button(String value,boolean filled,View.OnClickListener click){Button b=new Button(this);b.setText(value);b.setTextSize(14);b.setAllCaps(false);b.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));b.setTextColor(filled?(dark?0xFF101C38:Color.WHITE):TEAL);b.setBackground(new RippleDrawable(ColorStateList.valueOf(dark?0x33A2BBFF:0x22365FE1),round(filled?TEAL:SOFT,13),null));b.setStateListAnimator(null);b.setMinHeight(dp(48));b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(14),dp(10),dp(14),dp(10));b.setOnClickListener(click);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,dp(5),0,dp(5));b.setLayoutParams(lp);return b;}
    private LinearLayout card(){return card(page);}
    private LinearLayout card(LinearLayout parent){LinearLayout v=column();v.setPadding(dp(18),dp(17),dp(18),dp(17));GradientDrawable bg=round(SURFACE,20);bg.setStroke(dp(1),LINE);v.setBackground(bg);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,0,0,dp(16));parent.addView(v,lp);return v;}
    private void gap(LinearLayout parent, int h) { View v = new View(this); parent.addView(v, new LinearLayout.LayoutParams(1, dp(h))); }
    private void addWeighted(LinearLayout parent, View view) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1); lp.setMargins(dp(2), 0, dp(2), 0); parent.addView(view, lp); }
    private void heading(String title, String subtitle) { page.addView(text(title, 31, INK, true)); page.addView(text(subtitle, 13, MUTED, false)); gap(page, 17); }
    private void note(String value, boolean error) { TextView note = text(value, 12, error ? RED : MUTED, false); note.setBackground(round(error ? (dark?0xFF452B26:0xFFFFF0ED) : SOFT, 14)); note.setPadding(dp(13), dp(12), dp(13), dp(12)); LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.setMargins(0, dp(12), 0, dp(15)); page.addView(note, lp); }
    private EditText input(String hint, boolean multiline) { EditText e = new EditText(this); e.setHint(hint); e.setTextColor(INK); e.setHintTextColor(MUTED); e.setTextSize(16); e.setBackgroundTintList(ColorStateList.valueOf(TEAL)); e.setSingleLine(!multiline); e.setSelectAllOnFocus(false); return e; }
    private LinearLayout padded(View view) { LinearLayout v = column(); v.setPadding(dp(20), 0, dp(20), 0); v.addView(view, new LinearLayout.LayoutParams(-1, -2)); return v; }
    private String title(String value) { return value == null || value.isEmpty() ? "" : value.substring(0, 1).toUpperCase(Locale.ROOT) + value.substring(1); }
    private String bytes(long n) { if (n < 1024) return n + " B"; String[] unit = {"KB", "MB", "GB", "TB"}; double amount = n; int order = -1; do { amount /= 1024; order++; } while (amount >= 1024 && order < unit.length - 1); return String.format(Locale.getDefault(), amount >= 100 ? "%.0f %s" : "%.1f %s", amount, unit[order]); }
}
