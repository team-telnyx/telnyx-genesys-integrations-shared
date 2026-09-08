#!/usr/bin/env python3
"""Read deployment-scoped artifacts/secrets using the VM's native identity."""
import base64
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def request(url, headers=None):
    # Metadata calls must not be sent to an operator-configured HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(urllib.request.Request(url, headers=headers or {}), timeout=60)


def json_get(url, headers=None):
    with request(url, headers) as response:
        return json.load(response)


def token(config, resource=None):
    if config["target"] == "azure":
        query = urllib.parse.urlencode({"api-version": "2018-02-01", "resource": resource})
        return json_get("http://169.254.169.254/metadata/identity/oauth2/token?" + query,
                        {"Metadata": "true"})["access_token"]
    return json_get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                    {"Metadata-Flavor": "Google"})["access_token"]


def secret(config, name):
    if config["target"] == "azure":
        url = f'https://{config["vault"]}.vault.azure.net/secrets/{name}?api-version=7.4'
        value = json_get(url, {"Authorization": "Bearer " + token(config, "https://vault.azure.net")})
        return value["value"]
    url = f'https://secretmanager.googleapis.com/v1/projects/{config["project_id"]}/secrets/{name}/versions/latest:access'
    value = json_get(url, {"Authorization": "Bearer " + token(config)})
    return base64.b64decode(value["payload"]["data"]).decode()


def download(config, key, destination):
    if config["target"] == "azure":
        url = f'https://{config["storage_account"]}.blob.core.windows.net/{config["container"]}/' + urllib.parse.quote(key, safe="/")
        headers = {"Authorization": "Bearer " + token(config, "https://storage.azure.com/"), "x-ms-version": "2023-11-03"}
    else:
        url = f'https://storage.googleapis.com/storage/v1/b/{config["bucket"]}/o/' + urllib.parse.quote(key, safe="") + "?alt=media"
        headers = {"Authorization": "Bearer " + token(config)}
    with request(url, headers) as response, open(destination, "wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def environment(config, runtime, database):
    # Never evaluate shell supplied by a secret, or log its contents.
    values = {}
    for line in runtime.splitlines():
        if line and not line.startswith("#"):
            name, separator, value = line.partition("=")
            if not separator or not name.replace("_", "").isalnum():
                raise ValueError("Invalid runtime environment entry")
            values[name] = value
    master = values.get("ADMIN_SECRETS_MASTER_KEY", "")
    if len(base64.b64decode(master, validate=True)) != 32:
        raise ValueError("Runtime encryption key must decode to 32 bytes; refusing to rotate it")
    required = ("username", "password", "host", "port", "dbname")
    if any(not str(database.get(key, "")) for key in required):
        raise ValueError("Database secret is missing required fields")
    quote = lambda value: urllib.parse.quote(str(value), safe="")
    values["DATABASE_URL"] = (f'postgresql://{quote(database["username"])}:{quote(database["password"])}'
                              f'@{database["host"]}:{int(database["port"])}/{quote(database["dbname"])}')
    values.update(NODE_ENV="production", PORT="3000", GC_PUBLIC_BASE_URL="https://" + config["domain"])
    # GCP traffic traverses the Auth Proxy over a private Docker network;
    # the proxy verifies and encrypts the Cloud SQL connection using IAM.
    values["PGSSLMODE"] = "disable" if config["target"] == "gcp" else "verify-full"
    for key in ("PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "POSTGRES_SSL", "DATABASE_SSL"):
        values.pop(key, None)
    if any("\n" in value or "\r" in value for value in values.values()):
        raise ValueError("Multiline runtime values are not supported")
    return "".join(f"{key}={value}\n" for key, value in values.items())


def retry(action):
    for attempt in range(12):
        try:
            return action()
        except (urllib.error.URLError, TimeoutError):
            if attempt == 11:
                raise
            time.sleep(5)


def main(argv):
    action, config_file, *args = argv
    config = json.loads(Path(config_file).read_text())
    if action == "download":
        retry(lambda: download(config, args[0], args[1]))
    elif action == "env":
        runtime = retry(lambda: secret(config, config["app_secret"]))
        database = json.loads(retry(lambda: secret(config, config["db_secret"])))
        content = environment(config, runtime, database)
        target = Path(args[0])
        # Exclusive temporary file and atomic rename preserve the last usable env.
        temporary = target.with_suffix(".pending")
        descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(content)
        os.chmod(temporary, 0o600)
        temporary.replace(target)
    else:
        raise ValueError("Unknown provider operation")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        # URLs may include secret identifiers, but responses/tokens are never emitted.
        print(f"Runtime provider operation failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
