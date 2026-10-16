// The M2 receiver C ABI: the libwebsrt subscriber session
// (src/srt_session/subscriber.{h,cpp} - SRT listener role over the fork's
// virtual-transport seam) ported behind extern "C" for the browser player
// engine, minus its WTClient layer. The JS wrapper is built against exactly
// this surface.
//
//   srtw_init            srt_startup, once, idempotent
//   srtw_receiver_new    listener socket + options + attached virtual
//                        transport + listen + accept thread
//   srtw_handle_datagram inject one incoming datagram (the JS/WT thread)
//   srtw_poll            deliver one SRT message, non-blocking
//   srtw_get_stats       SrtwStats snapshot (see stats_map.h)
//   srtw_receiver_free   close + release transport
//
// Socket options are set on the listener BEFORE srt_listen and inherited by
// the accepted socket, per subscriber.h: SRTO_TRANSTYPE SRTT_LIVE first (it
// resets the latency/payload presets), then SRTO_PAYLOADSIZE 1128,
// SRTO_RCVLATENCY/SRTO_PEERLATENCY latency_ms, SRTO_SNDBUF/SRTO_RCVBUF
// clamp(latency_ms * 40, 8192, 320000) packets x 1472 bytes, SRTO_SKIP_INDUCTION
// 1, and SRTO_INITIAL_RTT rtt_ms when rtt_ms > 0 (clamped to 1..30000).
//
// Threading (subscriber.cpp's shape): handle_datagram/poll/free run on the
// JS thread; the virtual-transport send callback fires on srt's internal
// threads and touches nothing but send_fn (which must be thread-safe); a
// short-lived accept thread parks in srt_accept until the handshake
// completes. The shutdown order is fixed: accepted socket, listener, accept
// thread join, transport release - srt_close sends its shutdown through the
// send callback, so the transport must outlive both closes.

#ifndef SRTW_RECEIVER_H
#define SRTW_RECEIVER_H

#include <stdint.h>

#include "stats_map.h"

#ifdef __cplusplus
extern "C" {
#endif

// srt_startup once; safe to call repeatedly. 0 ok, -1 error. Call before
// srtw_receiver_new.
int srtw_init(void);

// Seam output callback: handshake replies, ACKs, NAKs. May be invoked from
// srt's internal threads; must not call back into this ABI.
typedef void (*srtw_send_fn)(void* ctx, const uint8_t* data, int len);

// rtt_ms <= 0 skips SRTO_INITIAL_RTT. Returns NULL on failure. The handle is
// a single-connection object: free it with srtw_receiver_free.
void* srtw_receiver_new(int latency_ms, int rtt_ms, srtw_send_fn send_fn, void* send_ctx);

// Inject an incoming datagram into the seam (0 ok, -1 error; -1 also once
// the receiver is closed).
int srtw_handle_datagram(void* h, const uint8_t* data, int len);

// Deliver one SRT message: >0 byte count, 0 none ready yet, -1 error or the
// stream has ended. Non-blocking (SRTO_RCVTIMEO = 0 semantics); buf should
// be at least the 1128-byte payload size.
int srtw_poll(void* h, uint8_t* buf, int cap);

// Snapshot the receiver's stats (0 ok, -1 when no connection is live).
int srtw_get_stats(void* h, struct SrtwStats* out);

// Close the session and release the transport. Idempotent per handle.
void srtw_receiver_free(void* h);

#ifdef __cplusplus
}
#endif

#endif // SRTW_RECEIVER_H
