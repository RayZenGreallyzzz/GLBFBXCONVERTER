# Phoenix Model Forge — Classic (branded backup)

This is the preserved **classic** version based on the repository's original `main` branch.

- Same GLB/FBX import/export, same quality/processing logic as the original classic.
- No added formats (VRM/OBJ/PLY/STL/USDZ). MultiFormat development continues only in its own branches.
- Turtle + golden phoenix image as the native Android launcher icon.
- Full-screen portrait startup art via an offline WebView splash overlay. Android 12+ may initially show the OS-managed launch icon before this image.
- Android resources are generated during CI from `public/branding/icon.webp` and `public/branding/splash.webp`.

After successful GitHub Actions build download `Phoenix-Model-Forge-Classic-Branded-APK` artifact ZIP from the branch's run.
