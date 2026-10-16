// M2 replay gate: drives the public receiver C ABI (harness/receiver.h)
// end to end in node. A synthetic publisher socket (the caller half of the
// M1 loopback pattern) sends N x 1128 deterministic messages; its outgoing
// datagrams are routed into srtw_handle_datagram, and the receiver's send_fn
// output (handshake reply, ACKs) is injected back into the publisher's seam.
// Gate criteria: idempotent init, skip-induction handshake through the C
// ABI, byte-exact in-order delivery via srtw_poll, negotiated payload and
// latency readback, and a stats snapshot whose counters match the traffic
// (rtt > 0, pktRecvTotal == N, byteRecvTotal == N x wire size, no loss).
//
// Per-check PASS lines (plus FAIL on stderr, exit 1) so the gate stays
// meaningful in Release; the M1 loopback test is the style reference.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>

#include <arpa/inet.h>

#include "receiver.h"
#include "srt.h"

namespace
{

constexpr int     kPayloadSize = 1128; // 6 x 188-byte TS packets - the WebSRT constant
constexpr int     kNumMessages = 2000;
constexpr int     kLatencyMs   = 120; // gateway ingest default; TSBPD window
constexpr int     kSeedRttMs   = 300; // SRTO_INITIAL_RTT through the C ABI
constexpr int     kTimeoutMs   = 5000; // fail fast instead of hanging
constexpr int64_t kMaxBw       = 8000000; // bytes/s wire cap: 2000 msgs flow in well under a second
constexpr int     kSndBufPkts  = 128; // bounds the send-queue backlog
constexpr int     kSndBufBytes = kSndBufPkts * (1500 - 28); // SRTO_SNDBUF is in bytes
// byteRecvTotal counts payload + SRT(16) + UDP(8) + IPv4(20) headers.
constexpr int kWirePktBytes = kPayloadSize + 16 + 8 + 20;

std::atomic<bool> g_ok{true};

void Fail(const std::string& what)
{
    g_ok = false;
    std::fprintf(stderr, "replay_test: FAIL: %s\n", what.c_str());
}

#define CHECK(cond)                                                                                                    \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(cond))                                                                                                   \
        {                                                                                                              \
            Fail(std::string(#cond " [") + srt_getlasterror_str() + "]");                                              \
            return false;                                                                                              \
        }                                                                                                              \
    } while (false)

sockaddr_in FillV4(const char* ip, uint16_t port)
{
    sockaddr_in sa;
    std::memset(&sa, 0, sizeof sa);
    sa.sin_family      = AF_INET;
    sa.sin_port        = htons(port);
    sa.sin_addr.s_addr = inet_addr(ip);
    return sa;
}

// The label synthesized by the fork's bind-less listen for the receiver's
// listener (the C ABI never binds); the publisher connects to it.
struct BackWire
{
    SRTVirtualTransport* peer        = nullptr; // the publisher's transport
    sockaddr_storage     source_addr = {};      // the receiver's listener label
    socklen_t            source_len  = 0;
};

// srtw_send_fn: the receiver's seam output (handshake reply, ACKs, NAKs)
// routed back into the publisher's transport. Runs on srt's internal
// threads; srt_virtual_transport_inject is thread-safe.
void ReceiverSend(void* ctx, const uint8_t* data, int len)
{
    BackWire* w = static_cast<BackWire*>(ctx);
    srt_virtual_transport_inject(
        w->peer,
        reinterpret_cast<const char*>(data),
        len,
        reinterpret_cast<const sockaddr*>(&w->source_addr),
        static_cast<int>(w->source_len));
}

// The publisher's send callback: its outgoing datagrams (handshake
// Conclusion, data, shutdown) routed into the receiver's C-ABI seam.
int PublisherSend(void* opaq, const char* data, int len, const struct sockaddr* /*dst*/, int /*dstlen*/)
{
    return srtw_handle_datagram(opaq, reinterpret_cast<const uint8_t*>(data), len) == 0 ? len : -1;
}

// Deterministic content: a xorshift32 stream seeded from the message index,
// regenerated identically on both sides (the M1 FillMessage, minus the
// swallowed-victim tag - this test loses nothing).
void FillMessage(int index, uint32_t* words)
{
    uint32_t state = 0x9E3779B9U ^ (static_cast<uint32_t>(index) * 2654435761U);
    for (int i = 0; i < kPayloadSize / 4; ++i)
    {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        words[i] = state;
    }
}

bool SetOptInt(SRTSOCKET u, SRT_SOCKOPT opt, int value)
{
    return srt_setsockopt(u, 0, opt, &value, sizeof value) != SRT_ERROR;
}

bool SetOptI64(SRTSOCKET u, SRT_SOCKOPT opt, int64_t value)
{
    return srt_setsockopt(u, 0, opt, &value, sizeof value) != SRT_ERROR;
}

// The sockets must be closed before the transport is released: srt_close
// sends the shutdown through the send callbacks, which touch the wires.
struct Session
{
    void*                 receiver = nullptr;
    SRTSOCKET             caller   = SRT_INVALID_SOCK;
    SRTVirtualTransport*  caller_vt = nullptr;
    BackWire              back_wire;

    ~Session()
    {
        // Order: the publisher first (its shutdown reaches the receiver's
        // seam, whose handle must still be alive), then the receiver (its
        // closes ride the still-alive publisher transport), then release.
        if (caller != SRT_INVALID_SOCK)
        {
            srt_close(caller);
        }
        if (receiver != nullptr)
        {
            srtw_receiver_free(receiver);
        }
        if (caller_vt != nullptr)
        {
            srt_virtual_transport_release(caller_vt);
        }
    }
};

bool InitPhase()
{
    CHECK(srtw_init() == 0);
    CHECK(srtw_init() == 0); // idempotent
    std::printf("PASS: init (srt_startup once, idempotent)\n");
    return true;
}

bool ConnectPhase(Session& s, const sockaddr_in& listener_label)
{
    s.receiver = srtw_receiver_new(kLatencyMs, kSeedRttMs, ReceiverSend, &s.back_wire);
    CHECK(s.receiver != nullptr);

    s.caller = srt_create_socket();
    CHECK(s.caller != SRT_INVALID_SOCK);
    CHECK(SetOptInt(s.caller, SRTO_SKIP_INDUCTION, 1));
    CHECK(SetOptInt(s.caller, SRTO_PAYLOADSIZE, kPayloadSize));
    CHECK(SetOptInt(s.caller, SRTO_LATENCY, kLatencyMs));
    CHECK(SetOptInt(s.caller, SRTO_SNDTIMEO, kTimeoutMs));
    CHECK(SetOptI64(s.caller, SRTO_MAXBW, kMaxBw));
    CHECK(SetOptInt(s.caller, SRTO_SNDBUF, kSndBufBytes));
    s.caller_vt = srt_attach_virtual_transport(s.caller, PublisherSend, s.receiver);
    CHECK(s.caller_vt != nullptr);

    s.back_wire.peer = s.caller_vt;
    std::memset(&s.back_wire.source_addr, 0, sizeof s.back_wire.source_addr);
    std::memcpy(&s.back_wire.source_addr, &listener_label, sizeof listener_label);
    s.back_wire.source_len = sizeof listener_label;

    CHECK(srt_connect(s.caller,
                      reinterpret_cast<const sockaddr*>(&listener_label),
                      static_cast<int>(sizeof listener_label)) != SRT_ERROR);

    // The C-ABI receiver's accept thread answers the Conclusion; the caller
    // reaches CONNECTED once the reply arrives.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTimeoutMs);
    while (srt_getsockstate(s.caller) != SRTS_CONNECTED)
    {
        CHECK(std::chrono::steady_clock::now() < deadline);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    std::printf("PASS: handshake (skip-induction connect/accept through the C ABI)\n");
    return true;
}

bool SendPhase(Session& s)
{
    uint32_t words[kPayloadSize / 4];
    for (int i = 0; i < kNumMessages; ++i)
    {
        FillMessage(i, words);
        CHECK(srt_sendmsg(s.caller, reinterpret_cast<const char*>(words), kPayloadSize, SRT_MSGTTL_INF, false) ==
              kPayloadSize);
    }
    std::printf("PASS: send (%d x %d deterministic messages)\n", kNumMessages, kPayloadSize);
    return true;
}

// Poll the receiver until all N messages arrive; verify byte-exact content
// in order. 0 from srtw_poll means the TSBPD window has not released the
// next message yet - wait and retry.
bool ReceivePhase(Session& s)
{
    uint32_t words[kPayloadSize / 4];
    uint8_t  buf[kPayloadSize];

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(4 * kTimeoutMs);
    for (int i = 0; i < kNumMessages;)
    {
        const int n = srtw_poll(s.receiver, buf, sizeof buf);
        if (n > 0)
        {
            CHECK(n == kPayloadSize);
            FillMessage(i, words);
            CHECK(std::memcmp(buf, words, kPayloadSize) == 0); // message i content mismatch
            ++i;
            continue;
        }
        if (n < 0)
        {
            Fail("srtw_poll: " + std::string(srt_getlasterror_str()));
            return false;
        }
        CHECK(std::chrono::steady_clock::now() < deadline);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    std::printf("PASS: data (%d messages byte-identical in order via srtw_poll)\n", kNumMessages);
    return true;
}

bool StatsPhase(Session& s)
{
    SrtwStats st;
    CHECK(srtw_get_stats(s.receiver, &st) == 0);

    CHECK(st.rtt_ms > 0);
    CHECK(st.rx_data == kNumMessages);              // pktRecvTotal == N
    CHECK(st.rx_bytes == static_cast<int64_t>(kNumMessages) * kWirePktBytes); // byteRecvTotal == N x wire size
    CHECK(st.rx_loss == 0);                         // nothing was lost
    CHECK(st.rx_dropped == 0);                      // nothing arrived too late
    CHECK(st.tx_data == 0 && st.tx_bytes == 0);     // receive-only session

    std::printf("PASS: stats (rtt=%.1f ms rxData=%d rxBytes=%d rxLoss=0 rxDrop=0 txData=0)\n",
                st.rtt_ms,
                static_cast<int>(st.rx_data),
                static_cast<int>(st.rx_bytes));

    // Negotiated options read back on the publisher: payload min(both) and
    // TSBPD latency max(both) converge on both ends.
    int payload = 0;
    int optlen  = sizeof payload;
    CHECK(srt_getsockopt(s.caller, 0, SRTO_PAYLOADSIZE, &payload, &optlen) == 0);
    CHECK(payload == kPayloadSize);
    int rcvlat = 0;
    optlen     = sizeof rcvlat;
    CHECK(srt_getsockopt(s.caller, 0, SRTO_RCVLATENCY, &rcvlat, &optlen) == 0);
    int pealat = 0;
    optlen     = sizeof pealat;
    CHECK(srt_getsockopt(s.caller, 0, SRTO_PEERLATENCY, &pealat, &optlen) == 0);
    CHECK(rcvlat == kLatencyMs);
    CHECK(pealat == kLatencyMs);

    std::printf("PASS: negotiated (payload %d / latency %d == configured)\n", payload, rcvlat);
    return true;
}

} // namespace

int main()
{
    const auto t0 = std::chrono::steady_clock::now();

    const sockaddr_in listener_label = FillV4("10.213.255.254", 0);

    bool ok = false;
    {
        Session session;
        ok = InitPhase() && ConnectPhase(session, listener_label) && SendPhase(session) && ReceivePhase(session) &&
             StatsPhase(session);
    }

    srt_cleanup();
    if (!ok || !g_ok)
    {
        return 1;
    }

    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0);
    std::printf("elapsed: %lld ms\n", static_cast<long long>(elapsed_ms.count()));
    return 0;
}
