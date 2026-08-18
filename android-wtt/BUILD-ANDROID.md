# WTT Capture — Android APK build guide

The `android-wtt/` folder is a Capacitor wrapper that loads the live web app
(`https://wtt-stock-system.onrender.com/mobile.html`) inside an Android WebView.
No app code lives here — when the website updates, the installed APK automatically
gets the new version.

## Prerequisites (one-time)

1. **JDK 17** (Java 8 will NOT work — Android Gradle Plugin 8 requires 17+)
   - Download: https://adoptium.net/ (Temurin 17 JDK)
   - Verify: `java -version` must show `17.x`
2. **Android SDK command-line tools**
   - Easiest: install **Android Studio** (https://developer.android.com/studio)
     and open this project with it.
   - Or headless: download commandline-tools from
     https://developer.android.com/studio#command-line-tools-only
3. **Node.js** (already installed on this machine — not needed elsewhere)

## Build the APK (signed, for sideloading)

```powershell
cd C:\Users\ravim\wttonline\android-wtt

# 1. regenerate the native project (after any web changes)
npx cap sync android

# 2. create a signing keystore (once)
keytool -genkeypair -v -keystore wtt-release.keystore -alias wtt \
  -keyalg RSA -keysize 2048 -validity 10000

# 3. point gradle at the keystore (put these in a local file, do not commit)
#    android/gradle.properties:
#      WTT_STORE_FILE=wtt-release.keystore
#      WTT_STORE_PASSWORD=your-strong-password
#      WTT_KEY_ALIAS=wtt
#      WTT_KEY_PASSWORD=your-strong-password

# 4. build
cd android
.\gradlew assembleRelease
```

Output: `android\app\build\outputs\apk\release\app-release.apk`

Install on staff phones: copy the `.apk` over (WhatsApp/Drive/USB), open it,
allow "Install unknown apps". It will appear as **WTT Capture** with the green
**W** launcher icon.

## Optional: Android Studio path

Open `android-wtt\android` in Android Studio → **Build → Generate Signed Bundle /
APK** → follow the wizard using `wtt-release.keystore`.

## Rebuilding for the real domain

When www.witbankterminals.co.za is live, change the URL in
`android-wtt\capacitor.config.json` → `server.url` and rerun:

```powershell
cd C:\Users\ravim\wttonline\android-wtt
npx cap sync android
cd android
.\gradlew assembleRelease
```

## Notes

- The app needs internet (it loads the web app, and saving + WhatsApp alerts
  require a connection).
- For **Play Store** publication you'd also need: the app signed with an upload
  key, a `.well-known/assetlinks.json` on the domain, and an app listing.
  Sideloading avoids all of that.
- When you pick a target, point `server.url` at **https://** URLs only
  (`cleartext` is disabled).