package com.mapcine.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Grava o vídeo exportado na galeria do aparelho.
 *
 * O WebView do Android não baixa links `blob:`, então a exportação nunca
 * chegava ao disco. Esta ponte recebe o arquivo em pedaços (base64) e grava
 * direto em Filmes/MapCine pelo MediaStore, sem pedir permissão.
 */
public class SaveBridge {
    private static final String FOLDER = "MapCine";

    private final Context ctx;
    private OutputStream out;
    private Uri uri;
    private File file;
    private String publicPath = "";
    private long bytes;

    public SaveBridge(Context context) {
        ctx = context.getApplicationContext();
    }

    /** Caminho mostrado ao usuário depois de salvar. */
    @JavascriptInterface
    public String folder() {
        return "Filmes/" + FOLDER;
    }

    /**
     * Abre o arquivo de destino.
     * @return "" quando deu certo, ou uma mensagem de erro.
     */
    @JavascriptInterface
    public String start(String name, String mime) {
        abort();
        String safe = (name == null || name.trim().isEmpty()) ? "mapcine.webm" : name.replaceAll("[\\\\/:*?\"<>|]", "-");
        String type = (mime == null || mime.trim().isEmpty()) ? "video/webm" : mime;
        bytes = 0;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Video.Media.DISPLAY_NAME, safe);
                values.put(MediaStore.Video.Media.MIME_TYPE, type);
                values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + FOLDER);
                values.put(MediaStore.Video.Media.IS_PENDING, 1);

                ContentResolver resolver = ctx.getContentResolver();
                uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "nao foi possivel criar o arquivo na galeria";
                out = resolver.openOutputStream(uri);
                if (out == null) return "nao foi possivel abrir o arquivo na galeria";
                publicPath = "Filmes/" + FOLDER + "/" + safe;
                return "";
            }

            File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES);
            if (dir == null) dir = ctx.getFilesDir();
            File target = new File(new File(dir, FOLDER), safe);
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            file = target;
            out = new FileOutputStream(target);
            publicPath = target.getAbsolutePath();
            return "";
        } catch (Exception err) {
            abort();
            return "erro ao abrir o arquivo: " + err.getMessage();
        }
    }

    /** Recebe um pedaço do vídeo em base64. */
    @JavascriptInterface
    public String write(String chunk) {
        if (out == null) return "arquivo nao iniciado";
        try {
            byte[] data = Base64.decode(chunk, Base64.DEFAULT);
            out.write(data);
            bytes += data.length;
            return "";
        } catch (Exception err) {
            return "erro ao gravar: " + err.getMessage();
        }
    }

    /** Fecha o arquivo e o publica na galeria. Devolve o caminho ou um erro. */
    @JavascriptInterface
    public String finish() {
        if (out == null) return "arquivo nao iniciado";
        try {
            out.flush();
            out.close();
            out = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && uri != null) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.Video.Media.IS_PENDING, 0);
                ctx.getContentResolver().update(uri, done, null, null);
                uri = null;
                return publicPath;
            }

            if (file != null) {
                final File saved = file;
                MediaScannerConnection.scanFile(
                    ctx,
                    new String[] { saved.getAbsolutePath() },
                    null,
                    null
                );
                file = null;
                return publicPath;
            }
            return publicPath;
        } catch (Exception err) {
            abort();
            return "erro ao finalizar: " + err.getMessage();
        }
    }

    /** Descarta o arquivo em andamento (usado quando a exportação falha). */
    @JavascriptInterface
    public void abort() {
        try {
            if (out != null) out.close();
        } catch (Exception ignored) {
            // nada a fazer
        }
        out = null;

        if (uri != null) {
            try {
                ctx.getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
                // nada a fazer
            }
        }
        uri = null;

        if (file != null && file.exists()) {
            // arquivo incompleto não deve ficar na galeria
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
        file = null;
        bytes = 0;
    }

    /** Quantidade já gravada, para a barra de progresso. */
    @JavascriptInterface
    public long written() {
        return bytes;
    }
}
