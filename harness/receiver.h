// The M2 receiver C ABI: libquicsrt's WT-free ReceiverCore
// (deps/libquicsrt/src/srt_session/receiver_core.{h,cpp} - SRT listener
// role over the fork's virtual-transport seam, the same machinery the
// native subscriber session uses) behind extern "C" for the browser
// player engine. The JS wrapper is built against exactly this surface.
//
//   srtw_init            srt_startup, once, idempotent
//   srtw_receiver_new    listener socket + options + attached virtual
//                        transport + listen + accept thread
//   srtw_handle_datagram inject one incoming datagram (the JS/WT thread)
//   srtw_poll            deliver one SRT message, non-blocking
//   srtw_send_message    publish bytes on the accepted socket (the
//                        publish direction; SendResult return contract)
//   srtw_get_stats       SrtwStats snapshot (see stats_map.h)
//   srtw_receiver_free   close + release transport
//
// Socket options, buffer sizing, and the fixed teardown order (accepted
// socket, listener, accept-thread join, transport release - srt_close
// sends its shutdown through the send callback, so the transport must
// outlive both closes) are ReceiverCore's, set on the listener BEFORE
// srt_listen and inherited by the accepted socket: SRTO_TRANSTYPE
// SRTT_LIVE first (it resets the latency/payload presets), then
// SRTO_PAYLOADSIZE 1128, SRTO_RCVLATENCY/SRTO_PEERLATENCY latency_ms,
// SRTO_SNDBUF/SRTO_RCVBUF clamp(latency_ms * 40, 8192, 320000) packets
// x 1472 bytes, SRTO_SKIP_INDUCTION 1, and SRTO_INITIAL_RTT rtt_ms when
// rtt_ms > 0 (clamped to 1..30000).
//
// Threading (ReceiverCore's shape): handle_datagram/poll/free run on the
// JS thread; the virtual-transport send callback fires on srt's internal
// threads and touches nothing but send_fn (which must be thread-safe); a
// short-lived accept thread parks in srt_accept until the handshake
// completes.

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

// Publish len bytes on the accepted socket - the publish direction
// (ReceiverCore::SendMessage, the browser engine's sender half). One call
// frames the buffer into SRT messages of at most the NEGOTIATED payload
// (the HSv5 readback: effectively 940 = 5 x 188, not the configured
// 1128); no remainder carries across calls. timeout_ms bounds the whole
// call (0 = one send attempt) on the calling thread. The return mirrors
// ReceiverCore::SendResult 1:1 - no translation, unlike srtw_poll:
//   >0  bytes accepted; a partial count when the deadline or the session
//       gave out midway - resume from buf + returned
//    0  len == 0 (nothing emitted)
//   -1  kSendTimeout - the send buffer stayed full until the deadline
//   -2  kSendClosed - the session ended
//   -3  kSendNotHandshaked - no connected accepted socket yet
//   -4  kSendInvalidArg - null handle/buffer or negative len
//   -5  kSendError - srt-level error
int srtw_send_message(void* h, const uint8_t* buf, int len, int timeout_ms);

// Snapshot the receiver's stats (0 ok, -1 when no connection is live).
int srtw_get_stats(void* h, struct SrtwStats* out);

// Close the session and release the transport. Idempotent per handle.
void srtw_receiver_free(void* h);

#ifdef __cplusplus
}
#endif

#endif // SRTW_RECEIVER_H
