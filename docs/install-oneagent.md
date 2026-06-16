# 4 · Install Dynatrace OneAgent

You install OneAgent **once, on the EC2 host**. As a full-stack host agent it
automatically discovers and deep-instruments every container (the Node.js
services) and the PostgreSQL database — no per-container agent, no code changes,
no Operator.

## 4.1 Get your install command from the tenant

!!! danger "Never hardcode the URL, version, or token"
    The install command embeds **your** environment URL and a token. Always copy
    the freshly generated command from your own tenant. The snippet below shows
    only the *shape* of that command, with placeholders.

1. In your Dynatrace environment (`<YOUR_TENANT>`), open the deployment screen:
   **Deploy OneAgent** (newer menus: **Deploy Dynatrace → Start installation**).
2. Choose **Linux**, architecture **x86**, installer type **default**.
3. Select or create a **PaaS token** when prompted.
4. **Copy the generated command.** It will look like the following — but use
   *yours*, not this:

    ```bash
    # ── EXAMPLE SHAPE ONLY — copy the real command from your tenant ──
    wget -O Dynatrace-OneAgent-Linux.sh \
      "https://<YOUR_TENANT>/api/v1/deployment/installer/agent/unix/default/latest?arch=x86&flavor=default" \
      --header="Authorization: Api-Token <YOUR_PAAS_TOKEN>"

    sudo /bin/sh Dynatrace-OneAgent-Linux.sh --set-app-log-content-access=true
    ```

5. Paste and run it **on the EC2 instance** over your SSH session.

The installer sets up the OneAgent service and starts it. Confirm it's running:

```bash
sudo systemctl status oneagent
```

## 4.2 Restart the stack so processes get instrumented

OneAgent injects into application processes **when they start**. Because the
containers were already running before you installed OneAgent, restart them once
so the Node.js and Postgres processes come up instrumented:

```bash
cd ~/CaseManagementApp     # or wherever docker-compose.yml lives
docker compose down
docker compose up --build -d
```

!!! tip "Order for a clean run"
    If you do this lab again, install OneAgent **before** the first
    `docker compose up` and you can skip this restart entirely.

Within a few minutes the host, its processes, and the containers appear in
Dynatrace (you'll confirm this on the next page).

## 4.3 Enable Real User Monitoring (RUM)

The frontend ships with a commented placeholder so you can drop in your tenant's
RUM JavaScript agent. It's in the `<head>` of
`gateway/public/index.html`:

```html
<!-- DYNATRACE RUM: paste your Real User Monitoring snippet on the line     -->
<!-- below ...                                                              -->
<!-- <script type="text/javascript" src="PASTE_YOUR_RUM_JS_AGENT_URL"></script> -->
```

There are two ways to get RUM:

=== "Manual snippet (matches the placeholder)"

    1. In Dynatrace, open **Web applications** (Frontend / Digital experience),
       and create or open the application that auto-detected your gateway host.
    2. Go to its setup → **Instrumentation / Manual insertion** and copy the
       **JavaScript tag** (or inline snippet).
    3. On the EC2 box, edit the file and replace the commented placeholder line
       with your real snippet:

        ```bash
        nano ~/CaseManagementApp/gateway/public/index.html
        ```

    4. Rebuild and restart **just the gateway** so the new HTML ships (the file
       is baked into the image):

        ```bash
        docker compose up --build -d gateway
        ```

=== "Automatic injection (no edit)"

    OneAgent can inject the RUM snippet for you. In Dynatrace, enable RUM for the
    web application / host and turn on **automatic injection**. No file edit or
    rebuild is needed — OneAgent rewrites the served HTML. Use this if you'd
    rather not touch the source.

!!! success "Checkpoint"
    OneAgent is installed on the host, the stack has been restarted so its
    processes are instrumented, and RUM is configured. Time to validate.

Next: [**Validate & run the demo →**](validate-demo.md)
