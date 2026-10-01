# AdGuard Home Certificate Setter

Eine kleine, deutschsprachige Webanwendung, die ein Zertifikat samt Private Key nach einer gemeinsamen Vorprüfung auf **alle** hinterlegten AdGuard-Home-Instanzen verteilt.

- Quellcode: <https://github.com/ruepp-jenkins/adguard-cert-setter>
- Container-Image: `ruepp/adguard-cert-setter`

## Funktionen

- Beliebig viele AdGuard-Home-Ziele mit URL und Basic-Auth-Zugangsdaten
- Lokale RSA-/EC-Key-Paar-Prüfung und Entschlüsselung passwortgeschützter Private Keys
- Zweistufiger Ablauf: erst alle Ziele validieren, dann parallel verteilen
- Erhalt der vorhandenen TLS-Ports und AdGuard-Einstellungen
- Fingerprint-Prüfung nach der Installation und Ergebnis je Ziel
- Ein Admin-Konto mit Argon2id-Passworthash
- HTTP als Standard oder eingebautes HTTPS mit gemounteten PEM-Dateien
- Persistente SQLite-Datenbank und Containerbetrieb ohne Root-Rechte

## Schnellstart mit Docker Compose

```bash
docker compose build
docker run --rm -it ruepp/adguard-cert-setter:local node dist/server/cli.js hash-password
cp .env.example .env
# Den erzeugten Hash in .env eintragen.
docker compose up -d
```

Danach ist die Anwendung standardmäßig unter `http://localhost:3000` erreichbar.

> Die AdGuard-Passwörter werden entsprechend der gewählten Betriebsanforderung unverschlüsselt in `/data/app.db` gespeichert. Das Volume und seine Backups sind wie Secrets zu behandeln. Zertifikate, Private Keys und deren Passphrasen werden dagegen nie gespeichert.

## Konfiguration

Die Anwendung lädt optional `/config/config.yaml`; ein anderer Pfad kann über `APP_CONFIG_FILE` gesetzt werden. Environment-Variablen überschreiben YAML-Werte. Ein vollständiges Beispiel befindet sich in [`config.example.yaml`](config.example.yaml).

| Environment               | Bedeutung                              | Standard                                 |
| ------------------------- | -------------------------------------- | ---------------------------------------- |
| `APP_USERNAME`            | Admin-Benutzername                     | `admin`                                  |
| `APP_PASSWORD_HASH`       | Erforderlicher Argon2id-Hash           | –                                        |
| `APP_HOST` / `APP_PORT`   | Listen-Adresse und Port                | `0.0.0.0:3000`                           |
| `APP_DATA_DIR`            | SQLite-Datenverzeichnis                | `./data` bzw. im Image `/data`           |
| `APP_PUBLIC_URL`          | Öffentliche URL für die Origin-Prüfung | aktuelle Request-URL                     |
| `APP_COOKIE_SECURE`       | Cookie ausschließlich über HTTPS       | bei eingebautem HTTPS automatisch `true` |
| `APP_SESSION_TTL_HOURS`   | Sitzungsdauer                          | `8`                                      |
| `APP_ADGUARD_TIMEOUT_MS`  | Timeout je API-Aufruf                  | `10000`                                  |
| `APP_ADGUARD_CONCURRENCY` | Parallele Ziele                        | `5`                                      |
| `APP_TLS_CERT_FILE`       | Zertifikatskette der App               | –                                        |
| `APP_TLS_KEY_FILE`        | Private Key der App                    | –                                        |
| `APP_TLS_KEY_PASSPHRASE`  | Optionale Key-Passphrase               | –                                        |

Es gibt kein Standardpasswort. Das Hash-Kommando liest das Passwort verdeckt vom Terminal oder alternativ von stdin:

```bash
printf '%s' 'ein-langes-passwort' | docker run --rm -i ruepp/adguard-cert-setter:local \
  node dist/server/cli.js hash-password
```

## Eingebautes HTTPS

Zertifikat und Private Key müssen gemeinsam gesetzt und in den Container gemountet werden:

```yaml
services:
  adguard-cert-setter:
    environment:
      APP_TLS_CERT_FILE: /certs/fullchain.pem
      APP_TLS_KEY_FILE: /certs/privkey.pem
      APP_COOKIE_SECURE: 'true'
    volumes:
      - ./certs:/certs:ro
```

Ohne diese beiden Einstellungen läuft der Container per HTTP. Da Browser den zu verteilenden Private Key übertragen, sollte HTTP nur in einem entsprechend vertrauenswürdigen internen Netz verwendet werden.

## AdGuard-Ziel-URLs

Eingaben ohne Schema werden als HTTP interpretiert. Ports und Reverse-Proxy-Pfade sind erlaubt; `/control` darf enthalten sein, wird aber nicht doppelt angehängt. HTTP-Ziele sind möglich, übertragen deren AdGuard-Zugangsdaten jedoch ohne Transportverschlüsselung.

Die globale Ziel-TLS-Prüfung ist standardmäßig aktiv und kann in der UI mit deutlicher Warnung deaktiviert werden. Die Einstellung betrifft ausschließlich AdGuard-Verbindungen.

## Jenkins-Build

Die `Jenkinsfile` baut das Image nativ und parallel für `linux/amd64` und `linux/arm64`. TypeScript-Prüfung, ESLint, Prettier, Produktions-Build und Vitest laufen dabei innerhalb des Docker-Builds; die JUnit-Berichte werden anschließend von Jenkins veröffentlicht. Erst wenn beide Architekturen erfolgreich sind, erzeugt Jenkins das gemeinsame Multi-Arch-Manifest.

Auf `main` und `master` werden folgende Tags nach `ruepp/adguard-cert-setter` veröffentlicht:

- Tagesversion im Format `YYYYMMDD`
- `latest`

Andere Branches werden mit `<branch>-YYYYMMDD` nach `ruepp/adguard-cert-setter-test` veröffentlicht. Jenkins benötigt die Agents `docker` für amd64 und `oracle_docker` für arm64, `DOCKER_USERNAME` auf den Agents sowie das Secret-Text-Credential `DOCKER_API_PASSWORD`.

Der lokale Docker-Testpfad erzeugt dieselben JUnit-Artefakte wie Jenkins:

```bash
./scripts/test.sh
```

`scripts/start.sh` initialisiert zusätzlich Buildx, meldet sich an der Registry an und führt Tests, den nativen Build sowie den Push-by-Digest aus. Es wird normalerweise nur durch Jenkins mit den benötigten Credentials gestartet.

## Entwicklung und Tests

```bash
npm ci
APP_PASSWORD_HASH='…' npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

Die End-to-End-Tests benötigen einmalig `npx playwright install chromium` und laufen mit `npm run test:e2e`.
