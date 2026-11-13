#!/bin/bash
set -euo pipefail
trap 'result=$?; if [ "$result" != 0 ]; then cat /tmp/monitor.log /tmp/old-server.log 2>/dev/null || true; fi; exit "$result"' EXIT

source /packages/version.env
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d
apt-get update -qq
if [ "$1" = upgrade ]; then
    apt-get install -y --no-install-recommends nut-client nut-server
    dpkg-query -W nut-client nut-server
    cp /usr/bin/upsc /tmp/upsc-old
    cp /lib/nut/upsd /tmp/upsd-old
    printf 'MODE=netclient\n' > /etc/nut/nut.conf
    printf '# preserved configuration\n' > /etc/nut/upsmon.conf
    chmod 640 /etc/nut/upsmon.conf
    sha256sum /etc/nut/nut.conf /etc/nut/upsmon.conf > /tmp/config.sha256
fi
(cd /packages && sha256sum --check SHA256SUMS)
apt-get -o Dpkg::Options::=--force-confold install -y --no-install-recommends /packages/*.deb libusb-1.0-0
for package in $NUT_PACKAGES; do
    [ "$(dpkg-query -W -f='${Version}' "$package")" = "$NUT_PACKAGE_VERSION" ]
done
if [ "$1" = upgrade ]; then
    sha256sum --check /tmp/config.sha256
    [ "$(stat -c %a /etc/nut/upsmon.conf)" = 640 ]
else
    grep -qx MODE=none /etc/nut/nut.conf
fi
test -f /usr/lib/udev/rules.d/62-nut-usbups.rules
test -x /usr/lib/systemd/system-shutdown/nutshutdown
test -x /usr/libexec/nut/usbhid-ups
test -f /usr/lib/systemd/system/nut-udev-settle.service
nut-scanner --help > /tmp/scanner-help
grep -q -- '--usb_scan' /tmp/scanner-help
nut-scanner --usb_scan --usb_scan --quiet

install -d -o nut -g nut -m 770 /run/nut
cat > /etc/nut/ups.conf <<'CONF'
[startos]
    driver = dummy-ups
    port = /tmp/ups.dev
    mode = dummy-once
CONF
printf 'MODE=netserver\n' > /etc/nut/nut.conf
printf 'LISTEN 127.0.0.1 3493\n' > /etc/nut/upsd.conf
cat > /etc/nut/upsd.users <<'CONF'
[startos]
    password = test-primary
    upsmon primary
[remote]
    password = test-secondary
    upsmon secondary
CONF
chown root:nut /etc/nut/*.conf /etc/nut/upsd.users
chmod 640 /etc/nut/*.conf /etc/nut/upsd.users
printf 'ups.status: OL\nbattery.charge: 100\n' > /tmp/ups.dev
/usr/libexec/nut/dummy-ups -a startos -u nut
upsd -u nut
wait_status() {
    for attempt in {1..80}; do
        observed=$(upsc startos@127.0.0.1 ups.status 2>/dev/null || true)
        missing=false
        for status in $1; do
            case " $observed " in
                *" $status "*) ;;
                *) missing=true ;;
            esac
        done
        if [ "$missing" = false ]; then return; fi
        sleep 0.25
    done
    printf 'UPS did not reach %s\n' "$1" >&2
    upsc startos@127.0.0.1 || true
    return 1
}
set_status() {
    sleep 1
    printf 'ups.status: %s\nbattery.charge: 50\n' "$1" > /tmp/ups.next
    mv /tmp/ups.next /tmp/ups.dev
    wait_status "$1"
}
wait_status OL
if [ "$1" = upgrade ]; then
    [ "$(/tmp/upsc-old startos@127.0.0.1 ups.status 2>/dev/null)" = OL ]
    mkdir /tmp/old-config
    cp /etc/nut/ups.conf /etc/nut/upsd.users /tmp/old-config/
    printf 'LISTEN 127.0.0.1 3494\n' > /tmp/old-config/upsd.conf
    chown root:nut /tmp/old-config/*
    chmod 640 /tmp/old-config/*
    NUT_CONFPATH=/tmp/old-config /tmp/upsd-old -F -u nut > /tmp/old-server.log 2>&1 &
    old_server=$!
    for attempt in {1..40}; do
        if upsc startos@127.0.0.1:3494 ups.status 2>/dev/null | grep -qx OL; then break; fi
        sleep 0.25
    done
    [ "$(upsc startos@127.0.0.1:3494 ups.status 2>/dev/null)" = OL ]
    kill "$old_server"
    wait "$old_server" || true
fi
cat > /etc/nut/upsmon.conf <<'CONF'
MONITOR startos@127.0.0.1:3493 1 startos test-primary primary
MINSUPPLIES 1
SHUTDOWNCMD "/usr/bin/touch /tmp/shutdown-observed"
POWERDOWNFLAG /tmp/killpower
POLLFREQ 1
POLLFREQALERT 1
HOSTSYNC 1
FINALDELAY 5
CONF
chown root:nut /etc/nut/upsmon.conf
chmod 640 /etc/nut/upsmon.conf
upsmon -F > /tmp/monitor.log 2>&1 &
monitor=$!
set_status 'OB CAL'
sleep 2
test ! -e /tmp/shutdown-observed
set_status OL
sleep 2
set_status OB
sleep 2
test ! -e /tmp/shutdown-observed
set_status 'OB LB'
for attempt in {1..80}; do
    if [ -e /tmp/shutdown-observed ]; then break; fi
    sleep 0.25
done
test -e /tmp/shutdown-observed
kill "$monitor" 2>/dev/null || true
printf '%s: matching packages, USB discovery, compatibility and CAL-to-OB/LB shutdown passed\n' "$1"
