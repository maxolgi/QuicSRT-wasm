#include "stats_map.h"

#include <cstring>

void srtw_map_stats(const SRT_TRACEBSTATS* from, struct SrtwStats* to)
{
    std::memset(to, 0, sizeof *to);

    to->elapsed_ms    = static_cast<double>(from->msTimeStamp);
    to->rx_data       = from->pktRecvTotal;
    to->rx_bytes      = static_cast<int64_t>(from->byteRecvTotal);
    to->rx_loss       = from->pktRcvLossTotal;
    to->rx_retransmit = from->pktRcvRetrans; // no Total variant; never cleared - see header
    to->rx_dropped    = from->pktRcvDropTotal;
    to->rx_ack        = from->pktRecvACKTotal;
    to->rx_nak        = from->pktRecvNAKTotal;
    to->rtt_ms        = from->msRTT;
    to->bandwidth_bps = static_cast<int64_t>(from->mbpsBandwidth * 1000000.0);
    to->rx_buffered   = from->pktRcvBuf;
    to->rx_belated    = from->pktRcvBelated; // no Total variant; never cleared - see header
    to->tx_data       = from->pktSentTotal;
    to->tx_bytes      = static_cast<int64_t>(from->byteSentTotal);
    to->tx_retransmit = from->pktRetransTotal;
    to->tx_loss       = from->pktSndLossTotal;
    to->tx_buffered   = from->pktSndBuf;
}
