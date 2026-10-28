package org.localsend.rebuilt;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

/** Consistent vector strokes, independent of emoji or the phone's installed fonts. */
public final class UiIcon extends Drawable {
    private final String name;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final int size;
    public UiIcon(String name, int color, int pixels) {
        this.name=name; this.size=pixels;
        paint.setColor(color); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(1.8f);
        paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
    }
    private void line(Canvas c,float x,float y,float xx,float yy){c.drawLine(x,y,xx,yy,paint);}
    private void path(Canvas c,float... points){Path p=new Path();p.moveTo(points[0],points[1]);for(int i=2;i<points.length;i+=2)p.lineTo(points[i],points[i+1]);c.drawPath(p,paint);}
    @Override public void draw(Canvas c) {
        c.save();c.translate(getBounds().left,getBounds().top);c.scale(getBounds().width()/24f,getBounds().height()/24f);
        switch(name){
            case "receive": line(c,12,3,12,15);path(c,8,11,12,15,16,11);path(c,3,14,3,21,21,21,21,14);break;
            case "send": line(c,12,17,12,3);path(c,8,7,12,3,16,7);path(c,3,14,3,21,21,21,21,14);break;
            case "history": c.drawArc(new RectF(3,3,21,21),-150,300,false,paint);path(c,3,4,3,10,9,10);path(c,12,7,12,12,16,14);break;
            case "settings": c.drawCircle(12,12,6.8f,paint);c.drawCircle(12,12,2.4f,paint);for(int i=0;i<8;i++){double a=i*Math.PI/4;line(c,12+(float)Math.cos(a)*7,12+(float)Math.sin(a)*7,12+(float)Math.cos(a)*10,12+(float)Math.sin(a)*10);}break;
            case "phone": c.drawRoundRect(new RectF(6,2,18,22),2,2,paint);line(c,10,5,14,5);line(c,11,19,13,19);break;
            case "desktop": c.drawRoundRect(new RectF(3,3,21,16),1.8f,1.8f,paint);line(c,12,16,12,21);line(c,8,21,16,21);break;
            case "folder": path(c,3,7,3,20,21,20,21,7,12,7,10,4,3,4,3,7);break;
            case "file": path(c,5,3,14,3,20,9,20,21,5,21,5,3);path(c,14,3,14,9,20,9);line(c,8,14,16,14);line(c,8,17,13,17);break;
            case "text": line(c,4,5,20,5);line(c,12,5,12,20);line(c,8,20,16,20);line(c,4,5,4,9);line(c,20,5,20,9);break;
            case "copy": c.drawRoundRect(new RectF(8,8,21,21),2,2,paint);path(c,16,8,16,3,3,3,3,16,8,16);break;
            case "wifi": c.drawArc(new RectF(0,4,24,28),-135,90,false,paint);c.drawArc(new RectF(4,9,20,25),-135,90,false,paint);c.drawArc(new RectF(8,14,16,22),-135,90,false,paint);c.drawCircle(12,21,.5f,paint);break;
            case "check": path(c,5,12,10,17,20,6);break;
            case "close": line(c,6,6,18,18);line(c,6,18,18,6);break;
            case "add": line(c,12,4,12,20);line(c,4,12,20,12);break;
            case "arrow": path(c,14,6,20,12,14,18);line(c,4,12,20,12);break;
            case "chevron": path(c,9,5,16,12,9,19);break;
            case "down": path(c,5,9,12,16,19,9);break;
            case "info": c.drawCircle(12,12,9,paint);line(c,12,11,12,17);c.drawCircle(12,7,.5f,paint);break;
            case "lock": c.drawRoundRect(new RectF(5,10,19,21),2,2,paint);c.drawArc(new RectF(8,2,16,18),180,180,false,paint);line(c,12,14,12,17);break;
            case "refresh": c.drawArc(new RectF(4,4,20,20),-60,290,false,paint);path(c,21,4,21,10,15,10);break;
            default: c.drawCircle(12,12,8,paint);
        }
        c.restore();
    }
    @Override public int getIntrinsicWidth(){return size;}
    @Override public int getIntrinsicHeight(){return size;}
    @Override public void setAlpha(int alpha){paint.setAlpha(alpha);invalidateSelf();}
    @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);invalidateSelf();}
    @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
}
