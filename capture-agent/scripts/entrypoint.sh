#!/bin/sh
set -e

# Grant NET_RAW+NET_ADMIN to tcpdump and tshark so they can capture
# without running as root. These are set after image build so they
# survive the container filesystem copy.
setcap cap_net_raw,cap_net_admin+eip /usr/bin/tcpdump 2>/dev/null || true
setcap cap_net_raw,cap_net_admin+eip /usr/bin/tshark  2>/dev/null || true

exec /capture-agent "$@"
