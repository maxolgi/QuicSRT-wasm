// The M2 receiver behind the C ABI declared in receiver.h: the libwebsrt
// SubscriberSession ported to the wasm harness. What changed against
// subscriber.cpp, and nothing else:
//
//   - no WTClient: seam output goes to the caller's srtw_send_fn, seam
//     input comes from srtw_handle_datagram;
//   - no WaitEstablished/Read deadlines: srtw_poll is a single non-blocking
//     receive (SRTO_RCVTIMEO = 0), so the JS wrapper owns all timing;
//   - no drain window on a graceful peer end: deciding it needs the WT
//     layer's close reason, which this seam does not have. srt itself still
//     delivers every buffered packet before reporting the end (the receive
//     path only errors once the TSBPD buffer is dry), so nothing is lost;
//     the end is simply reported as srtw_poll == -1.

#include "receiver.h"

#include <algorithm>
#include <arpa/inet.h>
#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>

#include "srt.h"

namespace
{

constexpr int kPayloadSize = 1128; // WebSRT constant (srt-wasm PAYLOAD_SIZE): 6 x 188-byte TS packets

// Buffer depth in packets, mirroring the browser receiver (srt-wasm
// new_inner) and the native subscriber: enough for the TSBPD window at 40
// packets per millisecond, clamped to the ingest range.
int BufferPackets(int latency_ms)
{
    const long long needed = static_cast<long long>(latency_ms) * 40;
    return static_cast<int>(std::clamp(needed, 8192LL, 320000LL));
}

// SRTO_SNDBUF/SRTO_RCVBUF are in BYTES; srt converts with MSS - UDP header
// (1500 - 28 = 1472) - see the M0 loopback harness.
constexpr int kBytesPerPacket = 1500 - 28;

bool SetOptInt(SRTSOCKET u, SRT_SOCKOPT opt, int value)
{
    return srt_setsockopt(u, 0, opt, &value, sizeof value) != SRT_ERROR;
}

class ReceiverSession
{
public:
    ReceiverSession(int latency_ms, int rtt_ms, srtw_send_fn send_fn, void* send_ctx)
        : latency_ms_(latency_ms), rtt_ms_(rtt_ms), send_fn_(send_fn), send_ctx_(send_ctx)
    {
        // Fake gateway address (10.220.0.1:5556 - M0's caller label). It is
        // only a label: dispatch happens by destination socket id inside the
        // dedicated multiplexer, never by address.
        std::memset(&peer_label_, 0, sizeof peer_label_);
        peer_label_.sin_family      = AF_INET;
        peer_label_.sin_port        = htons(5556);
        peer_label_.sin_addr.s_addr = inet_addr("10.220.0.1");
    }

    ~ReceiverSession()
    {
        Finalize();
    }

    // Builds the listener: socket, options, transport attach, listen, accept
    // thread. On failure everything built so far is undone.
    bool Start()
    {
        SRTSOCKET listener = srt_create_socket();
        if (listener == SRT_INVALID_SOCK)
        {
            return false;
        }

        // SRTO_TRANSTYPE first: it resets the latency/payload presets.
        const int buf_pkts = BufferPackets(latency_ms_);
        bool      ok       = SetOptInt(listener, SRTO_TRANSTYPE, SRTT_LIVE);
        ok                 = ok && SetOptInt(listener, SRTO_PAYLOADSIZE, kPayloadSize);
        ok                 = ok && SetOptInt(listener, SRTO_RCVLATENCY, latency_ms_);
        ok                 = ok && SetOptInt(listener, SRTO_PEERLATENCY, latency_ms_);
        ok                 = ok && SetOptInt(listener, SRTO_SNDBUF, buf_pkts * kBytesPerPacket);
        ok                 = ok && SetOptInt(listener, SRTO_RCVBUF, buf_pkts * kBytesPerPacket);
        ok                 = ok && SetOptInt(listener, SRTO_SKIP_INDUCTION, 1);
        if (rtt_ms_ > 0)
        {
            // SRTO_INITIAL_RTT bounds: 1..30000 ms.
            const int rtt = static_cast<int>(std::clamp<long long>(rtt_ms_, 1, 30000));
            ok            = ok && SetOptInt(listener, SRTO_INITIAL_RTT, rtt);
        }
        if (!ok)
        {
            srt_close(listener);
            return false;
        }

        SRTVirtualTransport* vt = srt_attach_virtual_transport(listener, VtSendThunk, this);
        if (vt == nullptr)
        {
            srt_close(listener);
            return false;
        }

        // No bind: the fork synthesizes the listener label and every
        // attached socket owns a dedicated multiplexer.
        if (srt_listen(listener, 5) == SRT_ERROR)
        {
            srt_virtual_transport_release(vt);
            srt_close(listener);
            return false;
        }

        try
        {
            accept_thread_ = std::thread([this, listener] { AcceptThread(listener); });
        }
        catch (...)
        {
            srt_virtual_transport_release(vt);
            srt_close(listener);
            return false;
        }

        const std::lock_guard<std::mutex> lock(mutex_);
        listener_ = listener;
        vt_       = vt;
        return true;
    }

    // JS thread. Inject under the mutex: Finalize() nulls vt_ under the same
    // mutex, which guarantees no injection can pass the transport release.
    int Inject(const uint8_t* data, int len)
    {
        const std::lock_guard<std::mutex> lock(mutex_);
        if (vt_ == nullptr || state_ == State::kClosed)
        {
            return -1;
        }
        return srt_virtual_transport_inject(
                   vt_,
                   reinterpret_cast<const char*>(data),
                   len,
                   reinterpret_cast<const sockaddr*>(&peer_label_),
                   static_cast<int>(sizeof peer_label_)) == 0
                   ? 0
                   : -1;
    }

    // JS thread. One non-blocking receive; RCVTIMEO = 0 was set on the
    // accepted socket when the handshake completed.
    int Poll(uint8_t* buf, int cap)
    {
        if (buf == nullptr || cap <= 0)
        {
            return -1;
        }

        SRTSOCKET sock = SRT_INVALID_SOCK;
        {
            const std::lock_guard<std::mutex> lock(mutex_);
            if (state_ == State::kClosed)
            {
                return -1;
            }
            sock = accepted_;
        }
        if (sock == SRT_INVALID_SOCK)
        {
            return 0; // handshake not complete yet
        }

        const int n = srt_recvmsg(sock, reinterpret_cast<char*>(buf), cap);
        if (n > 0)
        {
            return n;
        }

        const int err = srt_getlasterror(nullptr);
        if (err == SRT_ETIMEOUT)
        {
            return 0; // nothing released by the TSBPD window yet
        }
        if (err == SRT_ESCLOSED || err == SRT_ECONNLOST || err == SRT_ENOCONN)
        {
            // The stream ended (any buffered data has already been
            // delivered - the receive path errors only once the TSBPD
            // buffer is dry). Tear the session down.
            Finalize();
        }
        return -1;
    }

    // JS thread. Snapshot of the accepted socket (no clear).
    int Stats(struct SrtwStats* out)
    {
        SRTSOCKET sock = SRT_INVALID_SOCK;
        {
            const std::lock_guard<std::mutex> lock(mutex_);
            if (state_ != State::kConnected)
            {
                return -1;
            }
            sock = accepted_;
        }

        SRT_TRACEBSTATS perf;
        if (srt_bstats(sock, &perf, 0) != 0)
        {
            return -1;
        }
        srtw_map_stats(&perf, out);
        return 0;
    }

private:
    enum class State
    {
        kListening, // listener up, accept thread parked
        kConnected, // handshake complete (accepted socket live)
        kClosed,    // terminal
    };

    // Accept thread: parks in srt_accept until the handshake completes (or
    // the listener closes underneath it) and exits.
    void AcceptThread(SRTSOCKET listener)
    {
        sockaddr_storage peer;
        int              peer_len = sizeof peer;
        const SRTSOCKET  accepted = srt_accept(listener, reinterpret_cast<sockaddr*>(&peer), &peer_len);

        const std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != State::kListening || accepted == SRT_INVALID_SOCK)
        {
            // Finalize raced us (it already closed the listener), or the
            // listener was closed underneath us.
            if (accepted != SRT_INVALID_SOCK)
            {
                srt_close(accepted);
            }
            return;
        }

        // Non-blocking receives from here on (SO_RCVTIMEO = 0 semantics).
        SetOptInt(accepted, SRTO_RCVTIMEO, 0);
        accepted_ = accepted;
        state_    = State::kConnected;
    }

    // srt internal threads. Touches nothing but the caller's send_fn; once
    // the session is closed the send is swallowed and success is claimed so
    // srt's control machinery stays quiet during teardown.
    static int VtSendThunk(void* opaq, const char* data, int len, const struct sockaddr* /*dst*/, int /*dstlen*/)
    {
        return static_cast<ReceiverSession*>(opaq)->VtSend(data, len);
    }

    int VtSend(const char* data, int len)
    {
        if (closed_.load(std::memory_order_relaxed))
        {
            return len;
        }
        send_fn_(send_ctx_, reinterpret_cast<const uint8_t*>(data), len);
        return len; // send_fn is void: fire-and-forget, exactly like a UDP send
    }

    // Idempotent terminal cleanup. Order: state -> kClosed and vt -> null
    // under the mutex (injects stop), then OUTSIDE the mutex close the
    // accepted socket, close the listener (wakes a blocked accept), join the
    // accept thread, release the transport - srt_close sends the shutdown
    // through the send callback, so the transport must outlive both closes.
    void Finalize()
    {
        SRTSOCKET            listener = SRT_INVALID_SOCK;
        SRTSOCKET            accepted = SRT_INVALID_SOCK;
        SRTVirtualTransport* vt       = nullptr;
        bool                 join     = false;
        {
            const std::lock_guard<std::mutex> lock(mutex_);
            if (state_ == State::kClosed)
            {
                return;
            }
            state_    = State::kClosed;
            listener  = std::exchange(listener_, SRT_INVALID_SOCK);
            accepted  = std::exchange(accepted_, SRT_INVALID_SOCK);
            vt        = std::exchange(vt_, nullptr);
            join      = accept_thread_.joinable();
        }
        closed_.store(true, std::memory_order_relaxed);

        if (accepted != SRT_INVALID_SOCK)
        {
            srt_close(accepted);
        }
        if (listener != SRT_INVALID_SOCK)
        {
            srt_close(listener);
        }
        if (join)
        {
            accept_thread_.join();
        }
        if (vt != nullptr)
        {
            srt_virtual_transport_release(vt);
        }
    }

    const int       latency_ms_;
    const int       rtt_ms_;
    srtw_send_fn    send_fn_;
    void*           send_ctx_;
    sockaddr_in     peer_label_ = {};

    mutable std::mutex      mutex_;
    State                   state_    = State::kListening;
    SRTSOCKET               listener_ = SRT_INVALID_SOCK;
    SRTSOCKET               accepted_ = SRT_INVALID_SOCK;
    SRTVirtualTransport*    vt_       = nullptr;
    std::thread             accept_thread_;

    // Lock-free mirror of state_ == kClosed for the srt send callback.
    std::atomic<bool> closed_{false};
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
    auto* session = new ReceiverSession(latency_ms, rtt_ms, send_fn, send_ctx);
    if (!session->Start())
    {
        delete session;
        return nullptr;
    }
    return session;
}

int srtw_handle_datagram(void* h, const uint8_t* data, int len)
{
    if (h == nullptr || data == nullptr || len < 0)
    {
        return -1;
    }
    return static_cast<ReceiverSession*>(h)->Inject(data, len);
}

int srtw_poll(void* h, uint8_t* buf, int cap)
{
    if (h == nullptr)
    {
        return -1;
    }
    return static_cast<ReceiverSession*>(h)->Poll(buf, cap);
}

int srtw_get_stats(void* h, struct SrtwStats* out)
{
    if (h == nullptr || out == nullptr)
    {
        return -1;
    }
    return static_cast<ReceiverSession*>(h)->Stats(out);
}

void srtw_receiver_free(void* h)
{
    delete static_cast<ReceiverSession*>(h); // ~ReceiverSession finalizes
}
