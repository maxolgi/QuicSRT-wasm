// SrtwStats: the stats half of the M2 receiver C ABI. Field-for-field the
// shape the JS wrapper's StatsMsg (js/srt_engine.js) is built on, mapped
// onto the forked-srt SRT_TRACEBSTATS (CBytePerfMon) snapshot taken with
// srt_bstats(sock, ..., clear=0).
//
//   SrtStats              TRACEBSTATS            Notes
//   -----------------    -------------------    --------------------------------
//   elapsed_ms           msTimeStamp            ms since the connection epoch
//   rx_data              pktRecvTotal           data pkts received incl. retrans
//   rx_bytes             byteRecvTotal          payload + SRT(16)+UDP(8)+IP(20)
//   rx_loss              pktRcvLossTotal        detected missing at receiver
//   rx_retransmit        pktRcvRetrans          (1)
//   rx_dropped           pktRcvDropTotal        too-late drops (TLPKTDROP)
//   rx_ack               pktRecvACKTotal        ACKs received
//   rx_nak               pktRecvNAKTotal        NAKs received
//   rtt_ms               msRTT                  smoothed RTT EWMA (one per link)
//   bandwidth_bps        mbpsBandwidth * 1e6    Mb/s -> bits/s
//   rx_buffered          pktRcvBuf              acknowledged pkts in rcv buffer
//   rx_belated           pktRcvBelated          (1)
//   tx_data              pktSentTotal           data pkts sent incl. retrans
//   tx_bytes             byteSentTotal          payload + headers
//   tx_retransmit        pktRetransTotal        retransmissions sent
//   tx_loss              pktSndLossTotal        lost as reported by NAKs
//   tx_buffered          pktSndBuf              unACKed pkts in snd buffer
//
// (1) No Total variant exists in the C API for the receiver-side
//     retransmit/belated counters; the never-cleared local counters are used
//     instead (identical while srtw_get_stats keeps passing clear=0, which it
//     does by construction).
//
// bandwidth_bps carries the C API's mbpsBandwidth estimate alone - no
// tx-side rate maxed in, which would be moot for the receive-only
// player socket.

#ifndef SRTW_STATS_MAP_H
#define SRTW_STATS_MAP_H

#include <stdint.h>

#include "srt.h"

#ifdef __cplusplus
extern "C" {
#endif

struct SrtwStats
{
    double  elapsed_ms;    // msTimeStamp
    int64_t rx_data;       // pktRecvTotal
    int64_t rx_bytes;      // byteRecvTotal
    int64_t rx_loss;       // pktRcvLossTotal
    int64_t rx_retransmit; // pktRcvRetrans
    int64_t rx_dropped;    // pktRcvDropTotal
    int64_t rx_ack;        // pktRecvACKTotal
    int64_t rx_nak;        // pktRecvNAKTotal
    double  rtt_ms;        // msRTT
    int64_t bandwidth_bps; // mbpsBandwidth * 1e6
    int64_t rx_buffered;   // pktRcvBuf
    int64_t rx_belated;    // pktRcvBelated
    int64_t tx_data;       // pktSentTotal
    int64_t tx_bytes;      // byteSentTotal
    int64_t tx_retransmit; // pktRetransTotal
    int64_t tx_loss;       // pktSndLossTotal
    int64_t tx_buffered;   // pktSndBuf
};

// Maps one srt_bstats(..., clear=0) snapshot onto SrtwStats; see the table
// above. `to` is zero-initialized first, so any field left untouched reads 0.
void srtw_map_stats(const SRT_TRACEBSTATS* from, struct SrtwStats* to);

#ifdef __cplusplus
}
#endif

#endif // SRTW_STATS_MAP_H
