package com.phoenix.glbfbxconverter;

import android.app.ActivityManager;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Read-only memory snapshot. No extra Android permissions are required. */
@CapacitorPlugin(name="DeviceMemory")
public class DeviceMemoryPlugin extends Plugin {
    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            ActivityManager manager=(ActivityManager)getContext().getSystemService(Context.ACTIVITY_SERVICE);
            if(manager==null){call.reject("Недоступны сведения о памяти Android");return;}
            ActivityManager.MemoryInfo info=new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(info);
            JSObject result=new JSObject();
            result.put("totalMiB",info.totalMem/1048576L);
            result.put("availableMiB",info.availMem/1048576L);
            result.put("thresholdMiB",info.threshold/1048576L);
            result.put("lowMemory",info.lowMemory);
            result.put("lowRamDevice",manager.isLowRamDevice());
            call.resolve(result);
        }catch(Exception e){call.reject("Не удалось проверить память Android");}
    }
}
