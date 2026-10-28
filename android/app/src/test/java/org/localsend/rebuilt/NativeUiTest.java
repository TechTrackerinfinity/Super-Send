package org.localsend.rebuilt;

import android.app.AlertDialog;
import android.content.Context;
import android.content.ComponentName;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowAlertDialog;
import static org.robolectric.Shadows.shadowOf;
import static org.junit.Assert.*;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
public class NativeUiTest {
    private static Object field(Object target,String name)throws Exception{Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(target);}
    private static void field(Object target,String name,Object value)throws Exception{Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);f.set(target,value);}
    private static void call(Object target,String name,Class<?>[] types,Object...args)throws Exception{Method m=target.getClass().getDeclaredMethod(name,types);m.setAccessible(true);m.invoke(target,args);}
    private static JSONObject obj(Object...pairs)throws Exception{JSONObject out=new JSONObject();for(int i=0;i<pairs.length;i+=2)out.put((String)pairs[i],pairs[i+1]);return out;}
    private JSONObject fixture()throws Exception{
        JSONObject file=obj("id","f","name","Project notes 日本語 — a long document name with useful details.pdf","size",524288,"transferred",200000,"status","transferring");
        JSONObject transfer=obj("id","transfer","direction","send","peer","A nearby computer with a long recognizable name","files",new JSONArray().put(file),"status","transferring","total",524288,"transferred",200000,"progress",.38,"createdAt",System.currentTimeMillis());
        return obj("device",obj("alias","A clearly named Android phone","deviceModel","Android","fingerprint","AABB","port",53317,"protocol","https","addresses",new JSONArray().put("192.168.1.24")),
          "settings",obj("alias","A clearly named Android phone","autoAccept",false),"network",obj("ready",true,"discovery",true),
          "selection",new JSONArray().put(obj("id","selected","name","A long file name with details that needs room to wrap on a small phone.pdf","size",524288,"type","file")),
          "peers",new JSONArray().put(obj("id","pc","alias","A desktop with a long but recognizable device name","deviceModel","Windows","deviceType","desktop","host","192.168.1.10")),
          "transfers",new JSONArray().put(transfer),"history",new JSONArray(),"requests",new JSONArray());
    }
    private ActivityController<MainActivity> create(String theme,int width,int height,float font)throws Exception{
        RuntimeEnvironment.setQualifiers("w"+width+"dp-h"+height+"dp-mdpi");
        Context context=RuntimeEnvironment.getApplication();context.getSharedPreferences("localsend",0).edit().putString("theme",theme).putBoolean("askedNotifications",true).commit();
        Configuration configuration=new Configuration(context.getResources().getConfiguration());configuration.fontScale=font;
        context.getResources().updateConfiguration(configuration,context.getResources().getDisplayMetrics());context.getResources().getDisplayMetrics().scaledDensity=context.getResources().getDisplayMetrics().density*font;
        TransferService service=new TransferService();field(service,"storage",new AndroidStorage(context));field(service,"preferences",context.getSharedPreferences("localsend",0));
        shadowOf(RuntimeEnvironment.getApplication()).setComponentNameAndServiceForBindService(new ComponentName(context,TransferService.class),service.new LocalBinder());
        ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume().visible();
        MainActivity activity=controller.get();
        activity.onState(fixture());shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));return controller;
    }
    private View root(MainActivity activity)throws Exception{return (View)field(activity,"root");}
    private void layout(MainActivity activity,int width,int height)throws Exception{
        View root=root(activity);root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height);shadowOf(Looper.getMainLooper()).idle();
    }
    private void capture(MainActivity activity,String name,int width,int height)throws Exception{
        layout(activity,width,height);Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);root(activity).draw(new Canvas(bitmap));
        File output=new File(System.getProperty("ui.output"),name+".png");output.getParentFile().mkdirs();try(FileOutputStream stream=new FileOutputStream(output)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,stream));}bitmap.recycle();
    }
    private void captureDialog(AlertDialog dialog,String name)throws Exception{
        shadowOf(Looper.getMainLooper()).idle();
        View root=dialog.getWindow().getDecorView();root.measure(View.MeasureSpec.makeMeasureSpec(360,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(600,View.MeasureSpec.AT_MOST));root.layout(0,0,360,root.getMeasuredHeight());
        Bitmap bitmap=Bitmap.createBitmap(360,root.getHeight(),Bitmap.Config.ARGB_8888);root.draw(new Canvas(bitmap));File output=new File(System.getProperty("ui.output"),name+".png");try(FileOutputStream stream=new FileOutputStream(output)){bitmap.compress(Bitmap.CompressFormat.PNG,100,stream);}bitmap.recycle();
    }
    private List<View> descendants(View node){List<View> result=new ArrayList<>();result.add(node);if(node instanceof ViewGroup){ViewGroup group=(ViewGroup)node;for(int i=0;i<group.getChildCount();i++)result.addAll(descendants(group.getChildAt(i)));}return result;}
    private View text(MainActivity activity,String text)throws Exception{for(View view:descendants(root(activity)))if(view instanceof TextView&&text.contentEquals(((TextView)view).getText()))return view;return null;}
    private void navigate(MainActivity activity,String tab)throws Exception{call(activity,"navigate",new Class[]{String.class},tab);shadowOf(Looper.getMainLooper()).idle();}
    private void close(ActivityController<MainActivity> controller)throws Exception{TransferService service=(TransferService)field(controller.get(),"service");((java.util.concurrent.ExecutorService)field(service,"commands")).shutdownNow();controller.pause().stop().destroy();}

    @Test public void screensRemainUsableAtPhoneTabletAndLargeFontSizes()throws Exception{
        int[][] sizes={{360,740},{412,892},{800,1000},{740,360}};
        for(String theme:new String[]{"light","dark"})for(int index=0;index<sizes.length;index++){
            int width=sizes[index][0],height=sizes[index][1];float font=index==1?1.5f:1;
            ActivityController<MainActivity> controller=create(theme,width,height,font);MainActivity activity=controller.get();
            try{for(String tab:new String[]{"receive","send","history","settings"}){
                navigate(activity,tab);layout(activity,width,height);
                LinearLayout navigation=(LinearLayout)field(activity,"navigation");ScrollView scroll=(ScrollView)field(activity,"scroll");
                assertEquals("All navigation destinations remain available",4,navigation.getChildCount());assertTrue("Content remains scrollable in "+theme+"/"+tab,scroll.getHeight()>100);
                for(View v:descendants(root(activity)))if(v.getVisibility()==View.VISIBLE&&v.getWidth()>0&&v.getHeight()>0){
                    if(v.isClickable()&&v instanceof android.widget.Button)assertTrue("Touch target too short: "+((TextView)v).getText(),v.getHeight()>=47);
                    assertTrue("A view is wider than the phone: "+v.getClass().getSimpleName(),v.getWidth()<=width+1);
                }
                capture(activity,theme+"-"+width+"-"+height+"-"+tab,width,height);
                if("settings".equals(tab)&&width==360){((ScrollView)field(activity,"scroll")).fullScroll(View.FOCUS_DOWN);layout(activity,width,height);capture(activity,theme+"-settings-bottom",width,height);}
            }}finally{close(controller);}
        }
    }
    @Test public void progressKeepsControlsAndScrollPositionStable()throws Exception{
        ActivityController<MainActivity> controller=create("light",393,852,1);MainActivity activity=controller.get();
        try{
            navigate(activity,"send");layout(activity,393,852);View cancel=text(activity,"Cancel transfer");assertNotNull(cancel);
            ScrollView scroll=(ScrollView)field(activity,"scroll");scroll.scrollTo(0,70);int y=scroll.getScrollY();
            JSONObject next=fixture();JSONObject transfer=next.getJSONArray("transfers").getJSONObject(0);transfer.put("progress",.55).put("transferred",288358);transfer.getJSONArray("files").getJSONObject(0).put("transferred",288358);
            activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));layout(activity,393,852);
            assertSame("Progress must not replace a pressed/focused control",cancel,text(activity,"Cancel transfer"));assertEquals("Progress must not jump the page",y,scroll.getScrollY());
        }finally{close(controller);}
    }
    @Test public void liveSpeedUsesObservedDecimalMegabytesAndSettlesWhenStalled()throws Exception{
        ActivityController<MainActivity> controller=create("dark",393,852,1);MainActivity activity=controller.get();
        try{
            navigate(activity,"send");JSONObject next=fixture();JSONObject transfer=next.getJSONArray("transfers").getJSONObject(0);
            transfer.put("status","waiting").put("transferred",0).put("total",1000000000L).put("progress",0);
            activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
            java.util.Map<String,TextView> labels=(java.util.Map<String,TextView>)field(activity,"progressLabels");
            assertFalse("Approval time has no speed estimate",labels.get("transfer").getText().toString().contains("MB/s"));
            transfer.put("status","transferring");activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100));
            labels=(java.util.Map<String,TextView>)field(activity,"progressLabels");TextView label=labels.get("transfer");
            assertTrue("The first sample must not invent a speed",label.getText().toString().contains("Measuring speed"));
            View cancel=text(activity,"Cancel transfer");ScrollView scroll=(ScrollView)field(activity,"scroll");scroll.scrollTo(0,70);int y=scroll.getScrollY();
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400));
            transfer.put("transferred",50000000L).put("progress",.05);activity.onState(next);
            // Native view work can advance Robolectric's clock too; exact unit
            // conversion is tested below with explicit timestamps.
            String measured=label.getText().toString();
            assertTrue("Observed bytes should display a finite positive speed: "+measured,measured.matches("(?s).*\\n[1-9][0-9]*[.,][0-9] MB/s"));
            assertSame("Speed updates preserve transfer controls",cancel,text(activity,"Cancel transfer"));assertEquals(y,scroll.getScrollY());
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2500));
            assertTrue("A stalled transfer must not keep displaying its old rate",label.getText().toString().contains(String.format(java.util.Locale.getDefault(),"%.1f MB/s",0.0)));
            controller.pause();assertEquals(false,field(activity,"speedTickQueued"));
            assertTrue(((java.util.Map<?,?>)field(activity,"transferRates")).isEmpty());
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));assertEquals(false,field(activity,"speedTickQueued"));
            controller.resume();assertTrue("Resuming starts a fresh observation window",label.getText().toString().contains("Measuring speed"));
        }finally{close(controller);}
    }
    @Test public void speedMeterUsesDecimalUnitsAndResetsSafely()throws Exception{
        Class<?> type=Class.forName("org.localsend.rebuilt.MainActivity$TransferRate");
        java.lang.reflect.Constructor<?> constructor=type.getDeclaredConstructor();constructor.setAccessible(true);Object meter=constructor.newInstance();
        Method observe=type.getDeclaredMethod("observe",long.class,long.class);observe.setAccessible(true);
        Method label=type.getDeclaredMethod("label");label.setAccessible(true);
        observe.invoke(meter,0L,120000L);assertEquals("Measuring speed…",label.invoke(meter));
        observe.invoke(meter,50000000L,120500L);assertEquals(String.format(java.util.Locale.getDefault(),"%.1f MB/s",100.0),label.invoke(meter));
        for(long now=121000;now<=123000;now+=500)observe.invoke(meter,50000000L,now);
        assertEquals(String.format(java.util.Locale.getDefault(),"%.1f MB/s",0.0),label.invoke(meter));
        observe.invoke(meter,0L,123500L);assertEquals("Measuring speed…",label.invoke(meter));
        observe.invoke(meter,0L,124000L);assertEquals(String.format(java.util.Locale.getDefault(),"%.1f MB/s",0.0),label.invoke(meter));
    }
    @Test public void reverseTransferExplainsConnectionApprovalAndSaveConfirmation()throws Exception{
        ActivityController<MainActivity> controller=create("light",360,740,1.5f);MainActivity activity=controller.get();
        try{
            navigate(activity,"send");JSONObject next=fixture();JSONObject transfer=next.getJSONArray("transfers").getJSONObject(0);
            transfer.put("status","waiting").put("statusDetail","Waiting for the PC. Keep Super Send open on your PC");
            activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));layout(activity,360,740);
            assertNotNull(text(activity,"Waiting for the PC. Keep Super Send open on your PC"));View cancel=text(activity,"Cancel transfer");
            transfer.put("statusDetail","Waiting for approval on the PC");activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));layout(activity,360,740);
            assertNotNull(text(activity,"Waiting for approval on the PC"));assertSame(cancel,text(activity,"Cancel transfer"));
            transfer.put("status","transferring").put("statusDetail","Waiting for the PC to confirm the files were saved");activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));layout(activity,360,740);
            boolean explained=false;for(View view:descendants(root(activity)))if(view instanceof TextView&&((TextView)view).getText().toString().startsWith("Waiting for the PC to confirm the files were saved\n"))explained=true;
            assertTrue("The phone must explain why it is waiting for the PC",explained);capture(activity,"reverse-transfer-status",360,740);
        }finally{close(controller);}
    }
    @Test public void searchAndDetailsWorkWithoutLosingTheInput()throws Exception{
        ActivityController<MainActivity> controller=create("dark",393,852,1);MainActivity activity=controller.get();
        try{
            navigate(activity,"history");layout(activity,393,852);EditText search=(EditText)root(activity).findViewWithTag("historySearch");assertNotNull(search);search.requestFocus();search.setText("no match");
            assertSame(search,root(activity).findViewWithTag("historySearch"));assertNotNull(text(activity,"No matching transfers"));
            search.setText("nearby");assertNotNull(text(activity,"To A nearby computer with a long recognizable name"));
            call(activity,"messageDialog",new Class[]{});AlertDialog dialog=ShadowAlertDialog.getLatestAlertDialog();assertNotNull(dialog);assertTrue(dialog.isShowing());dialog.dismiss();
            capture(activity,"history-search-dark",393,852);
        }finally{close(controller);}
    }
    @Test public void dialogsValidateInputsAndUseTheChosenTheme()throws Exception{
        for(String theme:new String[]{"light","dark"}){
            ActivityController<MainActivity> controller=create(theme,360,740,1);MainActivity activity=controller.get();
            try{
                call(activity,"addDeviceDialog",new Class[]{});AlertDialog dialog=ShadowAlertDialog.getLatestAlertDialog();assertTrue(dialog.isShowing());
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                List<View> fields=descendants(dialog.getWindow().getDecorView());EditText host=null;for(View view:fields)if(view instanceof EditText){host=(EditText)view;break;}
                assertNotNull(host);assertNotNull("Missing IP should be explained inline",host.getError());
                captureDialog(dialog,theme+"-manual-dialog");dialog.dismiss();
                call(activity,"messageDialog",new Class[]{});dialog=ShadowAlertDialog.getLatestAlertDialog();dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                fields=descendants(dialog.getWindow().getDecorView());EditText message=null;for(View view:fields)if(view instanceof EditText){message=(EditText)view;break;}
                assertNotNull(message);assertNotNull("Blank message should be explained inline",message.getError());captureDialog(dialog,theme+"-message-dialog");dialog.dismiss();
                JSONObject next=fixture();next.put("requests",new JSONArray().put(obj("id","incoming","alias","A nearby PC","host","192.168.1.10","files",new JSONArray().put(obj("id","file","fileName","A long filename 日本語 with important details and an extension.pdf","size",1024)))));
                activity.onState(next);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));dialog=ShadowAlertDialog.getLatestAlertDialog();assertTrue(dialog.isShowing());assertTrue(dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled());captureDialog(dialog,theme+"-incoming-dialog");dialog.dismiss();
            }finally{close(controller);}
        }
    }
    @Test public void connectionFormScrollsInLandscape()throws Exception{
        ActivityController<MainActivity> controller=create("dark",740,360,1.5f);MainActivity activity=controller.get();
        try{
            call(activity,"addDeviceDialog",new Class[]{});shadowOf(Looper.getMainLooper()).idle();AlertDialog dialog=ShadowAlertDialog.getLatestAlertDialog();
            View decor=dialog.getWindow().getDecorView();decor.measure(View.MeasureSpec.makeMeasureSpec(600,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(330,View.MeasureSpec.AT_MOST));decor.layout(0,0,600,decor.getMeasuredHeight());
            ScrollView form=(ScrollView)decor.findViewWithTag("dialogForm");
            assertNotNull("Connection fields should scroll",form);assertTrue("Long form must fit a short display",form.getHeight()<=198);
            assertTrue("Fields must remain reachable by scrolling",form.getChildAt(0).getHeight()>form.getHeight());
            assertTrue("Connect remains visible",dialog.getButton(AlertDialog.BUTTON_POSITIVE).getBottom()<=decor.getHeight());dialog.dismiss();
        }finally{close(controller);}
    }
    @Test public void superSendBrandIsVisibleOnAnIdlePhone()throws Exception{
        for(String theme:new String[]{"light","dark"}){
            ActivityController<MainActivity> controller=create(theme,393,852,1);MainActivity activity=controller.get();
            try{
                JSONObject idle=fixture();idle.put("transfers",new JSONArray()).put("history",new JSONArray()).put("selection",new JSONArray()).put("peers",new JSONArray());
                activity.onState(idle);shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));navigate(activity,"receive");layout(activity,393,852);
                assertNotNull(text(activity,"Super Send"));assertNotNull(text(activity,"YOUR RECEIVE STATION"));
                assertNotNull(text(activity,"On your PC, connect to this phone in Super Send."));
                capture(activity,"super-send-"+theme+"-receive-idle",393,852);
                navigate(activity,"send");layout(activity,393,852);assertNotNull(text(activity,"Files"));assertNotNull(text(activity,"Add by IP"));
                capture(activity,"super-send-"+theme+"-send-idle",393,852);
            }finally{close(controller);}
        }
    }
}
