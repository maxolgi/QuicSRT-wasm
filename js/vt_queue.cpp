// C ABI over the fork's optional srttransport helper (srt::SRTTransportQueue
// in deps/srt/srttransport), so the C engine shim (js/engine_shim.c) can
// drive the virtual transport seam - srt_bind_virtual with the queue's
// config plus the push-queue injection - without C++ of its own. The send
// callback is the helper's contiguous-datagram form, identical to the
// signature the old in-core srt_attach_virtual_transport used, so the
// shim's publisher_send carries over unchanged.
//
// Lifetime (srttransport.h): the queue must outlive every socket bound
// with its config; free it only after the final srt_close() of those
// sockets has returned.

#include <cstddef>
#include <new>
#include <sys/socket.h>

#include "srt.h"
#include "srttransport.h"

extern "C" {

typedef srt::SRTTransportQueue vt_queue_t;

// Opaque handle; NULL on allocation failure.
void* vt_queue_new(srt::SRTTransportSendFunc* send_fn, void* opaq)
{
    return new (std::nothrow) vt_queue_t(send_fn, opaq);
}

// The config to hand srt_bind_virtual (initial_rtt_ms 0 = disabled).
SRT_VirtualTransportConfig vt_queue_config(void* q, int initial_rtt_ms)
{
    return static_cast<vt_queue_t*>(q)->getConfig(initial_rtt_ms);
}

// Push one received datagram in, claiming src as its source (any thread).
int vt_queue_push(void* q, const void* data, size_t len, const struct sockaddr* src, socklen_t srclen)
{
    return static_cast<vt_queue_t*>(q)->push(data, len, src, srclen);
}

// Disable the transport: push() and the send callback fail afterwards.
void vt_queue_detach(void* q)
{
    static_cast<vt_queue_t*>(q)->detach();
}

void vt_queue_free(void* q)
{
    delete static_cast<vt_queue_t*>(q);
}

} // extern "C"
