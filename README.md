# AdGuard Home Certificate Setter

A small web application that validates a certificate and its private key, then deploys them to **all** configured AdGuard Home instances.

- Source code: <https://github.com/ruepp-jenkins/adguard-cert-setter>
- Container image: `ruepp/adguard-cert-setter:latest`

## Features

- Any number of AdGuard Home targets with a URL and Basic Authentication credentials
- Local RSA/EC key-pair validation and decryption of passphrase-protected private keys
- Two-stage deployment: validate every target first, then deploy in parallel
- Preserves existing TLS ports and AdGuard Home settings
- Verifies the certificate fingerprint after installation and reports the result per target
- One administrator account secured with an Argon2id password hash
- HTTP by default or built-in HTTPS with mounted PEM files
- Persistent SQLite database and a non-root container runtime

## Quick start with Docker Compose

```bash
docker run --rm -it ruepp/adguard-cert-setter:latest node dist/server/cli.js hash-password
cp .env.example .env
# Add the generated hash to .env.
docker compose up -d
```

The application is then available at `http://localhost:3000` by default.

> AdGuard Home passwords are stored unencrypted in `/data/app.db` as required by the chosen operating model. Treat the volume and its backups as secrets. Certificates, private keys, and their passphrases are never stored.

## Configuration

The application optionally loads `/config/config.yaml`. Set `APP_CONFIG_FILE` to use a different path. Environment variables override YAML values. See [`config.example.yaml`](config.example.yaml) for a complete example.

| Environment               | Purpose                                 | Default                           |
| ------------------------- | --------------------------------------- | --------------------------------- |
| `APP_USERNAME`            | Administrator username                  | `admin`                           |
| `APP_PASSWORD_HASH`       | Required Argon2id hash                  | –                                 |
| `APP_HOST` / `APP_PORT`   | Listen address and port                 | `0.0.0.0:3000`                    |
| `APP_DATA_DIR`            | SQLite data directory                   | `./data`, or `/data` in the image |
| `APP_PUBLIC_URL`          | Public URL used for origin validation   | Current request URL               |
| `APP_COOKIE_SECURE`       | Send the session cookie over HTTPS only | `true` with built-in HTTPS        |
| `APP_SESSION_TTL_HOURS`   | Session lifetime                        | `8`                               |
| `APP_ADGUARD_TIMEOUT_MS`  | Timeout per API request                 | `10000`                           |
| `APP_ADGUARD_CONCURRENCY` | Number of parallel target operations    | `5`                               |
| `APP_TLS_CERT_FILE`       | Application certificate chain           | –                                 |
| `APP_TLS_KEY_FILE`        | Application private key                 | –                                 |
| `APP_TLS_KEY_PASSPHRASE`  | Optional application key passphrase     | –                                 |

There is no default password. The hash command reads the password without echoing it in an interactive terminal, or from standard input:

```bash
printf '%s' 'a-long-password' | docker run --rm -i ruepp/adguard-cert-setter:latest \
  node dist/server/cli.js hash-password
```

## Built-in HTTPS

The certificate and private key must be configured together and mounted into the container:

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

Without these settings, the container serves HTTP. Because the browser transmits the private key that will be deployed, use HTTP only on a suitably trusted internal network.

## AdGuard Home target URLs

Values without a scheme are interpreted as HTTP. Ports and reverse-proxy paths are supported. A trailing `/control` is accepted and is not appended twice. HTTP targets are supported, but their AdGuard Home credentials are transmitted without transport encryption.

Target TLS verification is enabled globally by default. It can be disabled in the UI after acknowledging a prominent warning. This setting applies only to connections to AdGuard Home.

## Jenkins build

The `Jenkinsfile` builds the image natively and in parallel for `linux/amd64` and `linux/arm64`. TypeScript validation, ESLint, Prettier, the production build, and Vitest run inside the Docker build. Jenkins then publishes the resulting JUnit reports. The combined multi-architecture manifest is created only after both architectures succeed.

Builds from `main` and `master` publish these tags to `ruepp/adguard-cert-setter`:

- A daily version in `YYYYMMDD` format
- `latest`

Other branches publish `<branch>-YYYYMMDD` to `ruepp/adguard-cert-setter-test`. Jenkins requires agents labeled `docker` for amd64 and `oracle_docker` for arm64, `DOCKER_USERNAME` on the agents, and the secret-text credential `DOCKER_API_PASSWORD`.

The local Docker test path produces the same JUnit artifacts as Jenkins:

```bash
./scripts/test.sh
```

`scripts/start.sh` also initializes Buildx, signs in to the registry, runs the tests and native build, and pushes the resulting digest. Jenkins normally invokes it with the required credentials.

## Development and tests

```bash
npm ci
APP_PASSWORD_HASH='…' npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

Install Chromium once with `npx playwright install chromium` before running the end-to-end tests with `npm run test:e2e`.
