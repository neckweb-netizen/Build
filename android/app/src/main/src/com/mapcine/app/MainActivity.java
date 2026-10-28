package com.mapcine.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // O WebView não baixa links blob:; esta ponte grava o vídeo exportado
        // direto em Filmes/MapCine.
        getBridge().getWebView().addJavascriptInterface(new SaveBridge(this), "MapCineSave");
    }
}
