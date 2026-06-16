# 1 · Prerequisites

Before you start, make sure you have the following.

## AWS account & permissions

- An **AWS account** with permission to launch EC2 instances and create
  security groups and key pairs in your chosen region (`<YOUR_AWS_REGION>`).
- The **AWS Management Console** (this guide is click-through); the AWS CLI is
  optional.

## A recommended EC2 instance

This stack builds four Node.js images and runs five containers plus Postgres,
plus OneAgent — and the `HIGH_CPU` scenario deliberately burns CPU. Size for
comfort:

| Setting | Recommended | Minimum |
| --- | --- | --- |
| Instance type | **`t3.large`** (2 vCPU, 8 GiB) | `t3.medium` (2 vCPU, 4 GiB) |
| Architecture | **x86_64** | x86_64 |
| OS image (AMI) | **Amazon Linux 2023** or **Ubuntu 24.04 LTS** | same |
| Root volume | **30 GiB gp3** | 20 GiB gp3 |

!!! note "Why x86_64?"
    Both `node:20-slim` and `postgres:16` are multi-arch, so the app would run on
    Graviton (`t4g`) too. We standardize on **x86_64** so the OneAgent install
    command you copy from your tenant uses its default architecture with no
    edits. The default 8 GiB root volume is too small for Docker images +
    Postgres data — use **30 GiB**.

## A key pair

- An **EC2 key pair** (`<YOUR_KEY_NAME>`) for SSH. You can create it during
  instance launch. Download the private key (`<PATH_TO_KEY.pem>`) and protect it:

    ```bash
    chmod 400 <PATH_TO_KEY.pem>
    ```

## Your workstation's public IP

- You'll restrict SSH to your own IP. Find it now:

    ```bash
    curl -s https://checkip.amazonaws.com
    ```

    Use the result as `<YOUR_WORKSTATION_IP>` (the security group rule will append
    `/32`).

## A Dynatrace tenant

- Access to a **Dynatrace environment** (`<YOUR_TENANT>`), SaaS or Managed, where
  you can:
    - open the **Deploy OneAgent / Deploy Dynatrace** screen, and
    - create or use a **PaaS token** (`<YOUR_PAAS_TOKEN>`).
- The EC2 instance must have **outbound internet access** so OneAgent can reach
  your tenant and download the installer. The default security group allows all
  outbound traffic — leave that in place.

!!! tip "No Dynatrace tenant yet?"
    Start a free trial at <https://www.dynatrace.com/trial/>. You'll get an
    environment URL of the form `https://<YOUR_TENANT>` and can generate tokens
    from **Access tokens** in the menu.

Next: [**EC2 & host setup →**](ec2-setup.md)
