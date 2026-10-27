#!/bin/sh
# One-time setup of a fresh Ubuntu 24.04 droplet for the digital factory. Run as root:
#   sh setup.sh <ssh-public-key-of-the-operator>
# Idempotent: running it again changes nothing that is already in place.
set -eu

KEY="${1:?usage: sh setup.sh '<ssh public key>'}"
USER_NAME=factory
DIR=/opt/digital-factory

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl git ufw fail2ban unattended-upgrades

# Security updates install themselves.
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine and the compose plugin, from Docker's own repository.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

# An operator account with the key; no passwords, no root login over SSH.
id "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"
usermod -aG sudo,docker "$USER_NAME"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
grep -qxF "$KEY" "/home/$USER_NAME/.ssh/authorized_keys" 2>/dev/null || echo "$KEY" >> "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$USER_NAME"
# sshd keeps the first value it reads, so this file sorts before cloud-init's 50-cloud-init.conf.
rm -f /etc/ssh/sshd_config.d/90-factory.conf
cat > /etc/ssh/sshd_config.d/01-factory.conf <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
sshd -t
# Ubuntu 24.04 starts sshd from ssh.socket, so ssh.service may be inactive; it reads the file on start.
systemctl try-reload-or-restart ssh

# Only SSH and the web. Docker publishes ports past ufw, so compose.yaml publishes only Caddy.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# 4 GB of swap, so a burst of browser pages slows down rather than meets the OOM killer.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# The deployment directory, and the sweeps the all-in-one image does not schedule itself.
install -d -o "$USER_NAME" -g "$USER_NAME" "$DIR"
cat > /etc/cron.d/digital-factory <<CRON
* * * * * $USER_NAME $DIR/deploy/digitalocean/sweeps.sh routines >> /var/log/digital-factory-sweeps.log 2>&1
17 * * * * $USER_NAME $DIR/deploy/digitalocean/sweeps.sh attachments >> /var/log/digital-factory-sweeps.log 2>&1
CRON
touch /var/log/digital-factory-sweeps.log
chown "$USER_NAME" /var/log/digital-factory-sweeps.log
cat > /etc/logrotate.d/digital-factory <<'ROTATE'
/var/log/digital-factory-sweeps.log {
  weekly
  rotate 4
  compress
  missingok
  copytruncate
}
ROTATE

echo "Done. Next: README.md, step 3, as $USER_NAME."
