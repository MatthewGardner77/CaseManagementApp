# 7 · Cleanup

Tear everything down so you stop incurring AWS charges. Do these in order.

## 7.1 Stop the application

On the EC2 instance, from the project directory:

```bash
docker compose down -v
```

`down -v` stops and removes the containers **and** the Postgres data volume. If
you only want to stop the demo but keep the data for later, use `docker compose
stop` instead.

## 7.2 (Optional) Uninstall OneAgent

If you're keeping the instance for other work but want OneAgent gone:

```bash
sudo /opt/dynatrace/oneagent/agent/uninstall.sh
```

You can also delete the now-unused host and the web application from your
Dynatrace environment so they don't clutter the UI.

## 7.3 Terminate the EC2 instance

In the AWS Console: **EC2 → Instances**, select your instance →
**Instance state → Terminate instance**.

!!! note "The root volume"
    The 30 GiB root EBS volume has **Delete on termination** enabled by default,
    so it's removed with the instance. Confirm under **EC2 → Volumes** that no
    stray volume remains.

## 7.4 Delete the security group

After the instance is terminated: **EC2 → Security Groups**, select the security
group you created for this demo → **Actions → Delete security groups**.

!!! tip
    A security group can't be deleted while it's still attached to an instance
    (even a recently terminated one in `shutting-down` state). Wait until the
    instance shows **terminated**, then delete it.

## 7.5 Delete the key pair (optional)

If you created the key pair just for this demo and won't reuse it:
**EC2 → Key Pairs**, select `<YOUR_KEY_NAME>` → **Actions → Delete**. Also delete
the local `.pem` file (`<PATH_TO_KEY.pem>`).

## 7.6 Final check

Confirm nothing is still billing in `<YOUR_AWS_REGION>`:

- **EC2 → Instances** — your instance shows **terminated**.
- **EC2 → Volumes** — no leftover volume.
- **EC2 → Elastic IPs** — none allocated (you didn't allocate one in this guide,
  but check; unassociated Elastic IPs incur charges).

!!! success "Done"
    The demo is fully torn down and AWS charges have stopped.
