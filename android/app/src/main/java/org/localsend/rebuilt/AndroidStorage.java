package org.localsend.rebuilt;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;

/** Streaming destinations. A pending document becomes visible only after a full upload. */
public final class AndroidStorage implements TransferEngine.Storage {
    private final Context context;
    private final SharedPreferences preferences;
    public AndroidStorage(Context context) {
        this.context = context.getApplicationContext();
        preferences = context.getSharedPreferences("localsend", Context.MODE_PRIVATE);
    }
    public File fallbackDirectory() {
        File base = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (base == null) base = new File(context.getFilesDir(), "Downloads");
        return new File(base, "Super Send");
    }
    public String description() {
        String tree = preferences.getString("receiveTree", "");
        if (!tree.isEmpty()) return preferences.getString("receiveTreeName", "Selected folder");
        return Build.VERSION.SDK_INT >= 29 ? "Downloads / Super Send" : "App downloads (use Save a copy to export)";
    }
    public void useDefault() { preferences.edit().remove("receiveTree").remove("receiveTreeName").apply(); }
    public String selectFolder(Uri tree) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String name = "Selected folder";
        try (Cursor c = resolver.query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS}, null, null, null)) {
            if (c == null || !c.moveToFirst() || !DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)) || (c.getInt(2) & DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) == 0)
                throw new IOException("Choose a writable folder that supports creating files.");
            name = c.getString(0);
        } catch (SecurityException e) { throw new IOException("Folder permission was not granted. Choose the folder again.", e); }
        Uri probe = null;
        try {
            probe = DocumentsContract.createDocument(resolver, doc, "application/octet-stream", ".localsend-write-check-" + System.currentTimeMillis());
            if (probe == null) throw new IOException("This provider cannot create files in that folder.");
            if (!DocumentsContract.deleteDocument(resolver, probe)) throw new IOException("This provider cannot remove incomplete transfers. Choose another folder.");
            probe = null;
        } catch (Exception e) { throw new IOException("This folder cannot safely receive transfers: " + e.getMessage(), e); }
        finally { if (probe != null) try { DocumentsContract.deleteDocument(resolver, probe); } catch (Exception ignored) { } }
        preferences.edit().putString("receiveTree", tree.toString()).putString("receiveTreeName", name).apply();
        return name;
    }
    public static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot >= 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
        return type == null ? "application/octet-stream" : type;
    }
    public static String safeName(String name) {
        String clean = name == null ? "Received file" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.isEmpty()) clean = "Received file";
        return clean.length() > 180 ? clean.substring(0, 180) : clean;
    }
    @Override public TransferEngine.Destination create(String relativeName) throws IOException {
        final String name = safeName(relativeName);
        final ContentResolver resolver = context.getContentResolver();
        final String tree = preferences.getString("receiveTree", "");
        if (!tree.isEmpty()) {
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), DocumentsContract.getTreeDocumentId(Uri.parse(tree)));
            try {
                final Uri uri = DocumentsContract.createDocument(resolver, parent, mime(name), name);
                if (uri == null) throw new IOException("Could not create received file in the selected folder.");
                return contentDestination(uri, false);
            } catch (Exception e) { throw new IOException("Receive folder is unavailable. Choose it again in Settings. " + e.getMessage(), e); }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime(name));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Super Send/");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            final Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Could not create a file in Downloads.");
            return contentDestination(uri, true);
        }
        File folder = fallbackDirectory();
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Could not create the app downloads folder.");
        File candidate = null;
        for (int number = 0; number < 10000; number++) {
            File attempt = new File(folder, number == 0 ? name : "(" + number + ") " + name);
            if (attempt.createNewFile()) { candidate = attempt; break; }
        }
        if (candidate == null) throw new IOException("Too many files with the same name.");
        final File file = candidate;
        final OutputStream out;
        try { out = new FileOutputStream(file); }
        catch (IOException error) { file.delete(); throw error; }
        return new TransferEngine.Destination() {
            private boolean closed;
            public OutputStream output() { return out; }
            public String location() { return file.getAbsolutePath(); }
            public void commit() throws IOException { if (!closed) { out.close(); closed = true; } }
            public void abort() { try { out.close(); } catch (IOException ignored) { } closed = true; file.delete(); }
        };
    }
    private TransferEngine.Destination contentDestination(final Uri uri, final boolean pending) throws IOException {
        final ContentResolver resolver = context.getContentResolver();
        final OutputStream out;
        try {
            out = resolver.openOutputStream(uri, "w");
            if (out == null) throw new IOException("The document provider did not open an output stream.");
        } catch (Exception e) {
            try { if (DocumentsContract.isDocumentUri(context, uri)) DocumentsContract.deleteDocument(resolver, uri); else resolver.delete(uri, null, null); } catch (Exception ignored) { }
            throw new IOException("Could not open the received file.", e);
        }
        return new TransferEngine.Destination() {
            private boolean closed;
            public OutputStream output() { return out; }
            public String location() { return uri.toString(); }
            public void commit() throws IOException {
                if (!closed) { out.close(); closed = true; }
                if (pending && Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues(); values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    if (resolver.update(uri, values, null, null) != 1) throw new IOException("Could not finish saving the received file.");
                }
            }
            public void abort() {
                try { out.close(); } catch (Exception ignored) { } closed = true;
                try { if (DocumentsContract.isDocumentUri(context, uri)) DocumentsContract.deleteDocument(resolver, uri); else resolver.delete(uri, null, null); } catch (Exception ignored) { }
            }
        };
    }
}
