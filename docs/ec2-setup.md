# 2 · EC2 & host setup

In this step you launch the instance, lock down its security group, SSH in, and
install Docker.

## 2.1 Launch the EC2 instance

In the AWS Console, go to **EC2 → Instances → Launch instances** in
`<YOUR_AWS_REGION>` and set:

1. **Name** — e.g. `casemgmt-demo`.
2. **AMI** — Amazon Linux 2023 **or** Ubuntu Server 24.04 LTS (x86_64).
3. **Instance type** — `t3.large` (or `t3.medium` minimum).
4. **Key pair** — select `<YOUR_KEY_NAME>` (or create one and download the `.pem`).
5. **Network settings** — create a security group as described below.
6. **Storage** — set the root volume to **30 GiB gp3**.

Then **Launch instance** and note its **public IPv4 address** (`<EC2_PUBLIC_IP>`).

## 2.2 Security group: explicit inbound rules

Create (or edit) the instance's security group with exactly these **inbound**
rules:

| Type | Protocol | Port range | Source | Purpose |
| --- | --- | --- | --- | --- |
| SSH | TCP | 22 | `<YOUR_WORKSTATION_IP>/32` | Admin SSH, restricted to you |
| Custom TCP | TCP | **8080** | `0.0.0.0/0` | The citizen app **and** the `/control` page |

Leave **outbound** at the default ("All traffic" allowed) so Docker can pull
images and OneAgent can reach your Dynatrace tenant.

!!! danger "Do not open 3001, 3002, or 5432"
    Those ports are published on the host for local debugging only. The app is
    fully usable through **8080** alone. Leaving the database and internal
    services off the security group keeps them private.

!!! warning "The /control page is unauthenticated"
    The operator control page lives on the same port as the public app
    (`http://<EC2_PUBLIC_IP>:8080/control`) and is "hidden" only by not being
    linked. Anyone who can reach port 8080 can reach it. If that matters for your
    demo, set the **8080 source to `<YOUR_WORKSTATION_IP>/32`** instead of
    `0.0.0.0/0` — but then only you can see the app. For a live customer demo,
    `0.0.0.0/0` is usually fine for the short life of the instance.

## 2.3 SSH into the instance

The default login user depends on the AMI:

=== "Amazon Linux 2023"

    ```bash
    ssh -i <PATH_TO_KEY.pem> ec2-user@<EC2_PUBLIC_IP>
    ```

=== "Ubuntu"

    ```bash
    ssh -i <PATH_TO_KEY.pem> ubuntu@<EC2_PUBLIC_IP>
    ```

## 2.4 Install Docker Engine + the Compose plugin

Run the block for your AMI. Both install Docker Engine and the
`docker compose` **v2 plugin**, then let you run Docker without `sudo`.

=== "Amazon Linux 2023"

    ```bash
    # Docker Engine
    sudo dnf update -y
    sudo dnf install -y docker
    sudo systemctl enable --now docker

    # docker compose v2 plugin
    DOCKER_CONFIG=/usr/local/lib/docker
    sudo mkdir -p $DOCKER_CONFIG/cli-plugins
    sudo curl -SL \
      "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
      -o $DOCKER_CONFIG/cli-plugins/docker-compose
    sudo chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose

    # run docker without sudo
    sudo usermod -aG docker $USER
    ```

=== "Ubuntu"

    ```bash
    # Docker Engine + Compose plugin via Docker's official convenience script
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo systemctl enable --now docker

    # run docker without sudo
    sudo usermod -aG docker $USER
    ```

Apply the new group membership (so `docker` works without `sudo`) by logging out
and back in, or just run:

```bash
newgrp docker
```

Verify both tools:

```bash
docker --version
docker compose version
```

You should see a Docker version and **Docker Compose v2** (e.g. `v2.x.x`). If
`docker compose version` errors, re-check the Compose plugin step above.

Next: [**Deploy the app →**](deploy-app.md)
