# 6 · Day-to-day operations

Quick reference for running the demo over its lifetime. Run the `docker compose`
commands from the directory that contains `docker-compose.yml`.

## Stack lifecycle

```bash
docker compose ps                 # status of all five containers
docker compose up -d              # start (detached)
docker compose stop               # stop containers, keep them and the data
docker compose start              # start previously stopped containers
docker compose restart            # restart all
docker compose restart gateway    # restart one service
docker compose down               # stop & remove containers (KEEPS the database volume)
docker compose up --build -d      # rebuild images and start (after code changes)
```

!!! tip "Re-seed the database from scratch"
    The schema/seed only run when the Postgres volume is empty. To get a fresh
    300-case dataset, remove the volume:

    ```bash
    docker compose down -v        # also deletes the pgdata volume
    docker compose up --build -d  # re-seeds on first start
    ```

## View container logs

```bash
docker compose logs -f                      # all services, follow
docker compose logs -f gateway              # one service
docker compose logs --tail=50 case-service  # last 50 lines
docker compose logs loadgen                 # confirm baseline traffic
```

## Check OneAgent status

```bash
# Service state
sudo systemctl status oneagent

# OneAgent version & configuration (oneagentctl)
sudo /opt/dynatrace/oneagent/agent/tools/oneagentctl --version
sudo /opt/dynatrace/oneagent/agent/tools/oneagentctl --get-server

# OneAgent logs
sudo ls /var/log/dynatrace/oneagent
```

In the Dynatrace UI, the **Hosts** page shows the host as monitored and lists the
OneAgent version; **Deployment status** shows agent health.

## Reset all scenarios

If you've been experimenting, turn everything off in one shot:

```bash
for s in HIGH_CPU DB_FAILURE_RATE BACKEND_SLOWDOWN; do
  curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/scenarios/$s \
    -H 'Content-Type: application/json' -d '{"enabled":false}'
done
```

## Publish this guide to GitHub Pages (optional)

This guide is a MkDocs Material site. To preview locally:

```bash
pip install -r docs-requirements.txt
mkdocs serve      # http://127.0.0.1:8000
```

To publish to GitHub Pages from the repo (like the reference lab), set
`site_url`/`repo_url` in `mkdocs.yml`, then:

```bash
mkdocs gh-deploy
```

That builds the site and pushes it to the `gh-pages` branch. (A ready-to-use
GitHub Actions workflow is included at `.github/workflows/docs.yml` — enabling
GitHub Pages for the `gh-pages` branch makes pushes to `main` publish
automatically.)

Next: [**Cleanup →**](cleanup.md)
