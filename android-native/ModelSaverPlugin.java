package com.phoenix.glbfbxconverter;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Scoped Android file saver. Exports new files; never touches the original model. */
@CapacitorPlugin(name="ModelSaver")
public class ModelSaverPlugin extends Plugin {
    private File temporary;
    private FileOutputStream stream;
    private String filename;
    private String mime;
    private boolean choosing;
    private static final long MAX_SIZE=500L*1024L*1024L;

    private synchronized void reset() {
        if(stream!=null){try{stream.close();}catch(Exception ignored){}stream=null;}
        if(temporary!=null){temporary.delete();temporary=null;}
        filename=null;mime=null;choosing=false;
    }

    @PluginMethod
    public synchronized void begin(PluginCall call) {
        if(temporary!=null||choosing){call.reject("Уже выполняется экспорт");return;}
        String name=call.getString("name","model.glb");
        name=name.replaceAll("[\\\\/\\r\\n\\t]","_").trim();
        if(name.isEmpty())name="model.glb";
        try {
            temporary=File.createTempFile("model_forge_",".tmp",getContext().getCacheDir());
            stream=new FileOutputStream(temporary);
            filename=name;
            mime=call.getString("mime","application/octet-stream");
            call.resolve();
        }catch(Exception e){reset();call.reject("Не удалось открыть временный файл: "+e.getMessage());}
    }

    @PluginMethod
    public synchronized void append(PluginCall call) {
        if(stream==null||choosing){call.reject("Нет начатого экспорта");return;}
        String base64=call.getString("data");
        if(base64==null||base64.length()>160000){call.reject("Некорректный блок данных");return;}
        try{
            byte[] data=Base64.decode(base64,Base64.NO_WRAP);
            if(temporary.length()+data.length>MAX_SIZE)throw new IllegalStateException("Лимит безопасности 500 МБ");
            stream.write(data);
            call.resolve();
        }catch(Exception e){reset();call.reject("Ошибка записи данных: "+e.getMessage());}
    }

    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if(stream==null||choosing){call.reject("Нет готового экспорта");return;}
        try{
            stream.flush();stream.close();stream=null;
            if(temporary.length()==0)throw new IllegalStateException("Пустой файл");
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime);
            intent.putExtra(Intent.EXTRA_TITLE,filename);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            choosing=true;
            startActivityForResult(call,intent,"onDestination");
        }catch(Exception e){reset();call.reject("Не получилось выбрать файл: "+e.getMessage());}
    }

    @ActivityCallback
    private void onDestination(PluginCall call,ActivityResult result) {
        if(call==null){reset();return;}
        Uri dest=result.getData()==null?null:result.getData().getData();
        if(result.getResultCode()!=Activity.RESULT_OK||dest==null){
            reset();JSObject response=new JSObject();response.put("cancelled",true);call.resolve(response);return;
        }
        final File from=temporary;
        new Thread(()->{
            try(FileInputStream input=new FileInputStream(from);
                OutputStream output=getContext().getContentResolver().openOutputStream(dest,"w")){
                if(output==null)throw new IllegalStateException("Не удалось создать файл");
                byte[] buf=new byte[65536];int n;
                while((n=input.read(buf))!=-1)output.write(buf,0,n);
                output.flush();
                JSObject response=new JSObject();response.put("saved",true);
                getActivity().runOnUiThread(()->call.resolve(response));
            }catch(Exception e){getActivity().runOnUiThread(()->call.reject("Ошибка сохранения: "+e.getMessage()));}
            finally{reset();}
        },"GLBFBX-save").start();
    }

    @PluginMethod
    public synchronized void abort(PluginCall call) {
        if(!choosing)reset();
        call.resolve();
    }
}
