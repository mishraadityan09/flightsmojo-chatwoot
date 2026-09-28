#!/bin/bash
# Server sizing for email: 2 GB swap file + grow the root filesystem into any
# extra EBS space (after enlarging the volume in the AWS console).
# Idempotent, no downtime. Usage (as root):  bash scripts/email/server-prep.sh
set -euo pipefail

echo "== swap"
if swapon --show | grep -q '^/'; then
  echo "swap already active:"; swapon --show
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl -q -p /etc/sysctl.d/99-swappiness.conf
  echo "2 GB swap enabled"
fi

echo "== root filesystem"
# The server reports the root device as /dev/root, so ask lsblk which real
# partition is mounted on / instead of trusting findmnt's SOURCE.
PARTNAME=$(lsblk -nro NAME,MOUNTPOINT | awk '$2=="/"{print $1; exit}')   # nvme0n1p1
SRC="/dev/$PARTNAME"
FST=$(findmnt -no FSTYPE /)                        # ext4 or xfs
DISK=$(lsblk -no PKNAME "$SRC")                    # nvme0n1
PART=$(cat "/sys/class/block/$PARTNAME/partition") # 1
df -h / | tail -1
out=$(growpart "/dev/$DISK" "$PART" 2>&1 || true); echo "$out"
if echo "$out" | grep -q NOCHANGE; then
  echo "partition already fills the disk (enlarge the EBS volume in the console first if you wanted more)"
else
  case "$FST" in
    ext4) resize2fs "$SRC" ;;
    xfs)  xfs_growfs / ;;
    *)    echo "unknown fs $FST, grow manually"; exit 1 ;;
  esac
  df -h / | tail -1
fi
free -h | head -2
