# Эталоны

## Actual — один контейнер, свой логин, нативные клиенты

```nix
{
  homelab.services.actual = {
    subdomain = "budget";
    hostPort = 5006;
    auth = "bypass";
    dashboard = {
      name = "Actual Budget";
      category = "Finance";
      icon = "dollar";
      iconUrl = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/actual-budget.png";
    };
    containers.server = {
      image = "actualbudget/actual-server:25.1.0@sha256:2dec3118f7e7c0a05f626dc879cf71ac8c553200fe837c56dfe1d78827e56fa7";
      port = 5006;
      volumes = [ "/var/lib/actual:/data" ];
      healthcheck = {
        test = "node -e \"fetch('http://localhost:5006/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))\"";
        startPeriod = 20;
      };
    };
  };
}
```

- `auth = "bypass"`: у Actual свой пароль, а мобильный и десктопный клиенты не проходят браузерный редирект Authelia.
- Нет `public`: сервис живёт во внутреннем контуре (LAN и tailnet через AdGuard и Traefik).
- `hostPort` у Actual остался с прошлого рантайма. Новому сервису его не задавай: порт выводится из имени, уникальность проверяет assertion.
- В образе нет `curl` и `wget`, поэтому healthcheck идёт через `node -e fetch`. Пробу бери из того, что есть в образе.

## PowerSync — выделенный Postgres, секреты в sops

Целевая форма. Файл в репо ещё на литералах спайка (`password`, токены в `environment`) — не копируй их.

```nix
{
  homelab.services.powersync = {
    subdomain = "sync";
    auth = "bypass";
    secrets.env = ./secrets.yaml;
    needs.postgres = {
      dedicated = true;
      image = "postgres:17.11@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232";
      databases = [
        "vault"
        "powersync_storage"
      ];
      user = "vault";
      hostAuthMethod = "md5";
      settings.wal_level = "logical";
    };
    containers.service = {
      image = "journeyapps/powersync-service:1.26.1@sha256:413a0c813e96935ebe7203b5759f8a594a7b7cd8aa42134713e63af637e0f079";
      port = 8080;
      cmd = [
        "start"
        "-r"
        "unified"
      ];
      volumes = [ "${./config/service.yaml}:/config/service.yaml:ro" ];
      environment.POWERSYNC_CONFIG_PATH = "/config/service.yaml";
      healthcheck = {
        test = "node -e \"fetch('http://localhost:8080/probes/liveness').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))\"";
        startPeriod = 30;
      };
    };
  };
}
```

`services/powersync/secrets.yaml` до шифрования (шифрует человек, `sops services/powersync/secrets.yaml`):

```yaml
powersync-env: |
  POSTGRES_PASSWORD=<generated>
  PS_DATA_SOURCE_URI=postgresql://vault:<generated>@postgres:5432/vault?sslmode=disable
  PS_STORAGE_SOURCE_URI=postgresql://vault:<generated>@postgres:5432/powersync_storage?sslmode=disable
  PS_ADMIN_TOKEN=<generated>
```

- Контейнер Postgres из compose апстрима не переносится: его рендерит `needs.postgres`, алиас в сети — `postgres`, приложение ждёт его healthcheck само.
- Вторая база создаётся initdb-скриптом из `databases`; `settings` уходят в `-c key=value`.
- `password` не задан: `POSTGRES_PASSWORD` и строки подключения с паролем приходят из `secrets.env` во все контейнеры сервиса.
- `md5` только потому, что клиент PowerSync не умеет SCRAM; по умолчанию оставляй `scram-sha-256`.
- Конфиг-файл монтируется из store (`${./config/service.yaml}`); секреты в нём — через `!env`, не литералами.
