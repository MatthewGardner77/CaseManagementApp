# 3 · Deploy the app

Get the project onto the instance and start it with one command.

## 3.1 Get the project onto the instance

Use whichever you have. **Git clone** is simplest if the repo is hosted.

=== "Clone from Git"

    ```bash
    sudo dnf install -y git    # Amazon Linux 2023
    # sudo apt-get install -y git   # Ubuntu

    git clone <YOUR_REPO_URL>
    cd <repo-directory>
    ```

=== "Copy from your workstation (scp)"

    Run this **on your workstation**, from the parent of the project folder, then
    SSH back in:

    ```bash
    # Amazon Linux 2023 user is ec2-user; Ubuntu user is ubuntu
    scp -i <PATH_TO_KEY.pem> -r "CaseManagementApp" \
      ec2-user@<EC2_PUBLIC_IP>:~/CaseManagementApp

    ssh -i <PATH_TO_KEY.pem> ec2-user@<EC2_PUBLIC_IP>
    cd ~/CaseManagementApp
    ```

You should now be in the directory that contains `docker-compose.yml`:

```bash
ls
# case-service  db  docker-compose.yml  document-service  gateway  loadgen  README.md ...
```

## 3.2 Environment variables

**None are required.** Every setting the stack needs is already defined inline
in `docker-compose.yml` (service ports, the `casemgmt` / `casemgmt` Postgres
credentials, internal service URLs, and the seed). You can run it as-is.

??? info "What's preconfigured (for reference)"
    - Postgres database `casemgmt`, user `casemgmt`, password `casemgmt`.
    - `gateway` listens on **8080** and calls `case-service` (`:3001`) and
      `document-service` (`:3002`) over the internal compose network.
    - The database schema and a ~300-case seed load automatically on first start
      from `db/init/`.
    - `loadgen` starts generating baseline traffic automatically (default 6 req/s).

## 3.3 Start the stack

Build the images and start everything. This is the exact command this repo uses
(add `-d` to run detached, which you want on a remote box):

```bash
docker compose up --build -d
```

The first run pulls base images and builds the four Node services, so allow a
few minutes. Watch them come up healthy:

```bash
docker compose ps
```

All five (`csa-postgres`, `csa-case-service`, `csa-document-service`,
`csa-gateway`, `csa-loadgen`) should reach `running`, and the services should
show `healthy`. Tail the logs if you want to watch startup:

```bash
docker compose logs -f gateway case-service
# Ctrl+C to stop tailing (containers keep running)
```

!!! note "First-start ordering"
    Services wait for Postgres to be healthy before starting, and `loadgen`
    waits for the gateway. If a service restarts a couple of times during the
    very first boot while Postgres seeds, that's expected — it settles within a
    minute.

## 3.4 Verify the app in a browser

Open the citizen application:

```
http://<EC2_PUBLIC_IP>:8080
```

You should see the **U.S. Citizen Services Administration — Case Management
System** dashboard with case counts, an SLA-breach figure, and an average
time-to-close. Click **Case Queue** to see the seeded cases, and open any case.

## 3.5 Reach the operator control page

The control console is **not linked** from the citizen UI. Open it directly:

```
http://<EC2_PUBLIC_IP>:8080/control
```

You'll see three failure-scenario toggles (HIGH_CPU, DB_FAILURE_RATE,
BACKEND_SLOWDOWN), intensity sliders, a live "currently active" indicator, and a
load-generator panel showing traffic is already running.

!!! success "Checkpoint"
    The app is live on EC2 and generating its own baseline traffic. Now make
    Dynatrace see it.

Next: [**Install Dynatrace OneAgent →**](install-oneagent.md)
