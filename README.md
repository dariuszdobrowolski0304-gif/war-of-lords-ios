# War of Lords — Android App (Capacitor WebView Wrapper)

To jest osobny projekt (nie ruszamy nic w `W:\War of Lords`) — natywna aplikacja Android, która w
środku po prostu wyświetla `https://waroflords.pl` w pełnoekranowym WebView, bez paska adresu i bez
żadnych przycisków przeglądarki. Działa dokładnie jak zwykła przeglądarka:

- Nic nie jest kopiowane ani przechowywane lokalnie w aplikacji — cała strona (HTML/JS/CSS) ładuje
  się na żywo z serwera, tak jak w Chrome. Zmiana czegokolwiek na `waroflords.pl` (np. deploy nowej
  wersji gry) jest od razu widoczna w aplikacji, bez potrzeby aktualizacji apki.
- Logowanie/token sesji trzyma się dokładnie tak samo jak w przeglądarce (localStorage tego WebView),
  nic nie jest wysyłane ani zapisywane gdzie indziej.
- Docelowy adres jest ustawiony w `capacitor.config.json` (`server.url`).

## Struktura

- `www/` — pusty placeholder, nigdy faktycznie nie wyświetlany (bo `server.url` w configu od razu
  przekierowuje na `waroflords.pl`), Capacitor wymaga żeby ten folder istniał przy buildzie.
- `android/` — wygenerowany natywny projekt Android Studio/Gradle. To tu faktycznie się buduje APK.
- `capacitor.config.json` — jedyny plik, który realnie trzeba edytować, żeby zmienić docelowy adres
  strony albo nazwę/ID aplikacji.

## Jak zbudować APK (po zainstalowaniu Android Studio)

1. Otwórz folder `android/` w Android Studio (File → Open → wskaż `W:\WoL-Android-App\android`).
2. Poczekaj aż Gradle się zsynchronizuje (pierwsze uruchomienie pobiera zależności, może potrwać).
3. Podłącz telefon z Androidem kablem USB (z włączonym trybem debugowania w Ustawieniach →
   Opcje deweloperskie) ALBO uruchom emulator z poziomu Android Studio (Device Manager).
4. Kliknij zielony przycisk "Run" (▶) — zainstaluje i uruchomi apkę na wybranym urządzeniu.

Albo z linii poleceń (PowerShell) — **uwaga: użyj JDK 21 (Temurin), NIE własnej Javy Android
Studio** (ta jest zbyt nowa dla wersji Gradle w tym projekcie i build się wysypie z błędem
"Unsupported class file major version"):
```
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
$env:ANDROID_HOME = "C:\Users\darek\AppData\Local\Android\Sdk"
cd W:\WoL-Android-App
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```
Gotowy plik `.apk` (do ręcznego zainstalowania na dowolnym telefonie) znajdzie się w:
`android/app/build/outputs/apk/debug/app-debug.apk` — pierwszy build (`BUILD SUCCESSFUL in 4m 36s`)
już przeszedł pomyślnie 23.08.2026.

## Jak zainstalować APK na telefonie

Najprościej: skopiuj `app-debug.apk` na telefon (np. przez USB, e-mail do siebie, czy Google Drive)
i otwórz go na telefonie — Android zapyta o zgodę na instalację z nieznanego źródła (trzeba ją
włączyć raz w Ustawieniach), potem instaluje się jak każda inna aplikacja. To wersja "debug" (bez
sklepu Google Play) — w sam raz do własnych testów.

## Zmiana adresu / nazwy aplikacji

Edytuj `capacitor.config.json`, potem uruchom `npx cap sync android` żeby zmiany trafiły do
natywnego projektu.
