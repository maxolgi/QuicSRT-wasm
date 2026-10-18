// The srtw_* C ABI (receiver.h) as a thin adapter over libquicsrt's
// WT-free ReceiverCore (deps/libquicsrt/src/srt_session/receiver_core.
// {h,cpp}) - the same receiver machinery the native subscriber session
// uses, replacing this repo's own port of it. What the adapter adds, and
// nothing else:
//
//   - the sink bridge: ReceiverCore's DatagramSink (int-returning, UDP-like
//     loss semantics) over the ABI's fire-and-forget srtw_send_fn;
//   - the poll mapping: srtw_poll is a single non-blocking receive, so
//     Read(buf, cap, 0) maps kReadTimeout -> 0 (nothing ready yet) and
//     every terminal outcome (kReadEnd/kReadClosed/kReadError) -> -1,
//     the ABI's "stream ended or error" value.
//   - the send pass-through: srtw_send_message returns SendMessage's int
//     verbatim - its SendResult codes already are the ABI's contract
//     (positive = bytes accepted), so unlike Read nothing folds.
//
// Shutdown() is never called: the wire end is only ever observed by Read
// (srt delivers every TSBPD-buffered packet before erroring), so no drain
// window engages and the end reports exactly like the old in-repo port.
// Teardown is the destructor's Finalize (MarkLocalStop keeps it prompt),
// which closes accepted socket, listener, joins the accept thread, then
// releases the transport - the fixed order the seam requires.

#include "receiver.h"

#include <algorithm>
#include <new>
#include <string>

#include "srt_session/receiver_core.h"

namespace
{

class SrtwReceiver
{
public:
    SrtwReceiver(int latency_ms, srtw_send_fn send_fn, void* send_ctx)
        : send_fn_(send_fn), send_ctx_(send_ctx), core_(Params(latency_ms), SinkThunk, this)
    {
    }

    // Seeds SRTO_INITIAL_RTT via Start; false on a genuine setup failure.
    bool Start(int rtt_ms)
    {
        const int measured = rtt_ms > 0 ? static_cast<int>(std::clamp(rtt_ms, 1, 30000)) : 0;
        std::string error;
        return core_.Start(measured, &error);
    }

    int Inject(const uint8_t* data, int len)
    {
        if (core_.IsClosed())
        {
            return -1;
        }
        core_.InjectDatagram(data, static_cast<size_t>(len));
        return 0;
    }

    int Poll(uint8_t* buf, int cap)
    {
        const int n = core_.Read(reinterpret_cast<char*>(buf), cap, 0);
        if (n > 0)
        {
            return n;
        }
        using Read = quicsrt::ReceiverCore;
        return n == Read::kReadTimeout ? 0 : -1;
    }

    // SendMessage's SendResult codes are the ABI's own values, so the
    // int passes through untouched (the null-handle guard answers
    // kSendInvalidArg: -1 is kSendTimeout in this contract, unlike the
    // sibling functions' -1 "bad handle").
    int Send(const uint8_t* buf, int len, int timeout_ms)
    {
        return core_.SendMessage(reinterpret_cast<const char*>(buf), len, timeout_ms);
    }

    int Stats(struct SrtwStats* out)
    {
        SRT_TRACEBSTATS perf;
        if (!core_.Stats(&perf))
        {
            return -1;
        }
        srtw_map_stats(&perf, out);
        return 0;
    }

private:
    static quicsrt::ReceiverCoreParams Params(int latency_ms)
    {
        quicsrt::ReceiverCoreParams params;
        params.payload_size     = quicsrt::kSrtPayloadSize; // 1128: 6 x 188 TS packets
        params.tsbpd_latency_ms = latency_ms;
        params.initial_rtt_ms   = 0; // seeded via Start's measured RTT
        return params;
    }

    // DatagramSink over srtw_send_fn: fire-and-forget, so success is
    // claimed exactly like a UDP send. (ReceiverCore already swallows
    // sends once closed.)
    static int SinkThunk(void* opaq, const char* data, int len)
    {
        SrtwReceiver* r = static_cast<SrtwReceiver*>(opaq);
        r->send_fn_(r->send_ctx_, reinterpret_cast<const uint8_t*>(data), len);
        return len;
    }

    srtw_send_fn          send_fn_;
    void*                 send_ctx_;
    quicsrt::ReceiverCore  core_;
};

} // namespace

int srtw_init(void)
{
    static std::once_flag once;
    static int            rc = 0;
    std::call_once(once, [] { rc = srt_startup() < 0 ? -1 : 0; });
    return rc;
}

void* srtw_receiver_new(int latency_ms, int rtt_ms, srtw_send_fn send_fn, void* send_ctx)
{
    if (send_fn == nullptr)
    {
        return nullptr;
    }
    auto* receiver = new (std::nothrow) SrtwReceiver(latency_ms, send_fn, send_ctx);
    if (receiver == nullptr)
    {
        return nullptr;
    }
    if (!receiver->Start(rtt_ms))
    {
        delete receiver;
        return nullptr;
    }
    return receiver;
}

int srtw_handle_datagram(void* h, const uint8_t* data, int len)
{
    if (h == nullptr || data == nullptr || len < 0)
    {
        return -1;
    }
    return static_cast<SrtwReceiver*>(h)->Inject(data, len);
}

int srtw_poll(void* h, uint8_t* buf, int cap)
{
    if (h == nullptr)
    {
        return -1;
    }
    return static_cast<SrtwReceiver*>(h)->Poll(buf, cap);
}

int srtw_send_message(void* h, const uint8_t* buf, int len, int timeout_ms)
{
    if (h == nullptr)
    {
        return quicsrt::ReceiverCore::kSendInvalidArg;
    }
    return static_cast<SrtwReceiver*>(h)->Send(buf, len, timeout_ms);
}

int srtw_get_stats(void* h, struct SrtwStats* out)
{
    if (h == nullptr || out == nullptr)
    {
        return -1;
    }
    return static_cast<SrtwReceiver*>(h)->Stats(out);
}

void srtw_receiver_free(void* h)
{
    delete static_cast<SrtwReceiver*>(h); // ~ReceiverCore finalizes
}
