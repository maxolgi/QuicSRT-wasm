// The M3 engine shim: the JS-thread-safe layer between the pinned receiver
// C ABI (harness/receiver.h) and the emcc module the JS wrapper drives.
//
// Two things live here:
//
//   1. The outgoing ring. The receiver's seam output (handshake replies,
//      ACKs, NAKs) fires on srt's INTERNAL pthreads via srtw_send_fn, which
//      JS cannot register (a JS callback would have to be reentrant across
//      worker threads). srtw_engine_new therefore constructs the receiver
//      with the shim's ring send_fn: every outgoing datagram is copied into
//      a bounded mutex-protected ring owned by the engine handle, and JS
//      drains it with srtw_poll_outgoing after each handle_datagram/poll
//      tick - one datagram per call, its length returned, 0 when empty.
//
//      Bound: SRTW_RING_SLOTS slots of SRTW_DGRAM_CAP bytes (1024 x 1500,
//      mirroring the seam's VT_MAX_PENDING spirit; MTU caps a datagram at
//      1500 bytes). Overflow drops the OLDEST slot so the newest control
//      traffic (NAKs, ACKs) survives; a per-ring dropped counter counts the
//      victims. At player rates the ring holds several seconds of pure
//      control traffic, so drops indicate a stalled JS loop, not load.
//
//   2. The test publisher (js/test_contract.mjs only, the replay_test.cpp
//      caller pattern): an in-wasm SRT caller socket whose sends land in a
//      second ring (JS pumps them into srtw_handle_datagram, exercising the
//      exact worker.ts datagram path) and whose input JS feeds with
//      srtw_test_publisher_inject (the receiver's kind-0 outgoing actions
//      routed back, the WebTransport stand-in). A background pthread waits
//      for the handshake, then sends 2000 deterministic 1128-byte messages.
//
// The pinned ABI (receiver.cpp) is untouched; everything here composes it.

#include "receiver.h"

#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <arpa/inet.h>

#include "srt.h"

#define SRTW_RING_SLOTS 1024 // seam VT_MAX_PENDING spirit
#define SRTW_DGRAM_CAP 1500  // MTU: payload 1128 + SRT/UDP/IP headers fits

typedef struct
{
    int     len;
    uint8_t data[SRTW_DGRAM_CAP];
} srtw_slot;

typedef struct
{
    srtw_slot       slots[SRTW_RING_SLOTS];
    int             head; // next slot to drain
    int             tail; // next slot to fill
    int             count;
    uint64_t        dropped;
    pthread_mutex_t mu;
} srtw_ring;

static void ring_init(srtw_ring* r)
{
    memset(r, 0, sizeof *r);
    pthread_mutex_init(&r->mu, NULL);
}

static void ring_destroy(srtw_ring* r)
{
    pthread_mutex_destroy(&r->mu);
}

// Any thread (srt internals, JS). Copies the datagram in; a full ring drops
// the oldest slot first.
static void ring_push(srtw_ring* r, const uint8_t* data, int len)
{
    if (len <= 0 || len > SRTW_DGRAM_CAP)
    {
        return; // cannot happen (MTU-clamped); swallow like a failed UDP send
    }
    pthread_mutex_lock(&r->mu);
    if (r->count == SRTW_RING_SLOTS)
    {
        r->head = (r->head + 1) % SRTW_RING_SLOTS;
        r->count--;
        r->dropped++;
    }
    srtw_slot* s = &r->slots[r->tail];
    memcpy(s->data, data, (size_t)len);
    s->len    = len;
    r->tail   = (r->tail + 1) % SRTW_RING_SLOTS;
    r->count++;
    pthread_mutex_unlock(&r->mu);
}

// JS thread. Drains ONE datagram: its length, 0 when empty, -1 when cap is
// smaller than the datagram (the slot is kept for a big-enough buffer).
static int ring_pop(srtw_ring* r, uint8_t* buf, int cap)
{
    if (buf == NULL || cap <= 0)
    {
        return -1;
    }
    pthread_mutex_lock(&r->mu);
    if (r->count == 0)
    {
        pthread_mutex_unlock(&r->mu);
        return 0;
    }
    const srtw_slot* s = &r->slots[r->head];
    if (s->len > cap)
    {
        pthread_mutex_unlock(&r->mu);
        return -1;
    }
    memcpy(buf, s->data, (size_t)s->len);
    const int len = s->len;
    r->head       = (r->head + 1) % SRTW_RING_SLOTS;
    r->count--;
    pthread_mutex_unlock(&r->mu);
    return len;
}

// The exported surface below is extern "C" for the same reason receiver.h
// wraps its declarations: em++ compiles this .c file as C++, and the emcc
// EXPORTED_FUNCTIONS list needs the unmangled names either way.

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------- engine --
// (The publisher struct must be complete here: srtw_engine_free, defined
// below, tears it down. Its functions stay in the test-only section.)

typedef struct srtw_engine srtw_engine;

#define TST_PAYLOAD_SIZE 1128 // 6 x 188-byte TS packets - the WebSRT constant
#define TST_NUM_MESSAGES 2000
#define TST_LATENCY_MS 120 // the contract test constructs the engine at 120 ms
#define TST_TIMEOUT_MS 5000 // fail fast instead of hanging
#define TST_MAX_BW 8000000 // bytes/s wire cap (replay_test.cpp)
#define TST_SNDBUF_BYTES (128 * (1500 - 28))

typedef struct
{
    srtw_engine*         engine; // for the teardown order
    SRTSOCKET            sock;
    SRTVirtualTransport* vt;
    srtw_ring            out; // publisher seam output, drained by JS
    pthread_t            thread;
    int                  thread_started;
} srtw_publisher;

typedef struct srtw_engine
{
    uint32_t        magic;
    void*           receiver; // the pinned-ABI handle (receiver.cpp)
    srtw_ring       out;      // receiver seam output, drained by JS
    srtw_publisher* pub;      // test-only; NULL outside the contract test
} srtw_engine;

#define SRTW_ENGINE_MAGIC 0x53525457u // "SRTW"

// The srtw_send_fn handed to srtw_receiver_new. Runs on srt's internal
// threads; touches nothing but the ring.
static void engine_send_fn(void* ctx, const uint8_t* data, int len)
{
    ring_push(&((srtw_engine*)ctx)->out, data, len);
}

void* srtw_engine_new(int latency_ms, int rtt_ms)
{
    srtw_engine* e = (srtw_engine*)malloc(sizeof *e);
    if (e == NULL)
    {
        return NULL;
    }
    e->magic    = SRTW_ENGINE_MAGIC;
    e->receiver = NULL;
    e->pub      = NULL;
    ring_init(&e->out);
    e->receiver = srtw_receiver_new(latency_ms, rtt_ms, engine_send_fn, e);
    if (e->receiver == NULL)
    {
        ring_destroy(&e->out);
        free(e);
        return NULL;
    }
    return e;
}

// The handle the pinned-ABI calls (srtw_handle_datagram/poll/get_stats)
// expect; the engine handle itself only carries the ring and free.
void* srtw_engine_receiver(void* h)
{
    if (h == NULL || ((srtw_engine*)h)->magic != SRTW_ENGINE_MAGIC)
    {
        return NULL;
    }
    return ((srtw_engine*)h)->receiver;
}

int srtw_poll_outgoing(void* h, uint8_t* buf, int cap)
{
    if (h == NULL || ((srtw_engine*)h)->magic != SRTW_ENGINE_MAGIC)
    {
        return -1;
    }
    return ring_pop(&((srtw_engine*)h)->out, buf, cap);
}

void srtw_engine_free(void* h)
{
    if (h == NULL || ((srtw_engine*)h)->magic != SRTW_ENGINE_MAGIC)
    {
        return;
    }
    srtw_engine* e = (srtw_engine*)h;
    e->magic       = 0;

    // Test publisher teardown in the replay_test Session-dtor order: join
    // the send thread, close the publisher (its shutdown rides the receiver
    // seam, so the receiver must still be alive), free the receiver (its
    // closes ride the still-attached publisher transport), then release.
    if (e->pub != NULL)
    {
        srtw_publisher* p = e->pub;
        e->pub            = NULL;
        if (p->thread_started)
        {
            pthread_join(p->thread, NULL);
        }
        if (p->sock != SRT_INVALID_SOCK)
        {
            srt_close(p->sock);
        }
        srtw_receiver_free(e->receiver);
        e->receiver = NULL;
        if (p->vt != NULL)
        {
            srt_virtual_transport_release(p->vt);
        }
        ring_destroy(&p->out);
        free(p);
    }
    else
    {
        srtw_receiver_free(e->receiver);
        e->receiver = NULL;
    }
    ring_destroy(&e->out);
    free(e);
}

// ------------------------------------------------- test-only publisher ---
// The replay_test.cpp caller half, restructured so JS stays in the loop:
// publisher sends -> p->out ring -> JS -> srtw_handle_datagram(receiver);
// receiver sends -> engine ring -> JS kind-0 actions -> srtw_test_publisher_inject.

// The label the fork synthesizes for the receiver's bind-less listener
// (replay_test.cpp: the caller connects to it, and the receiver's seam
// output is injected back claiming it as source).
static struct sockaddr_in listener_label(void)
{
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof sa);
    sa.sin_family      = AF_INET;
    sa.sin_port        = htons(0);
    sa.sin_addr.s_addr = inet_addr("10.213.255.254");
    return sa;
}

// Deterministic content: the replay_test.cpp xorshift32 stream, so
// js/test_contract.mjs regenerates the identical bytes for comparison.
static void fill_message(int index, uint32_t* words)
{
    uint32_t state = 0x9E3779B9U ^ ((uint32_t)index * 2654435761U);
    for (int i = 0; i < TST_PAYLOAD_SIZE / 4; ++i)
    {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        words[i] = state;
    }
}

// The publisher's send callback (any thread): route its outgoing datagrams
// into the ring JS pumps through srtw_handle_datagram.
static int publisher_send(void* opaq, const char* data, int len, const struct sockaddr* dst, int dstlen)
{
    (void)dst;
    (void)dstlen;
    ring_push(&((srtw_publisher*)opaq)->out, (const uint8_t*)data, len);
    return len;
}

// Background pthread: connect (srt_connect BLOCKS until the handshake reply
// arrives, and the reply can only reach this socket through the JS pump -
// so the connect cannot run on the JS thread), then fire the 2000-message
// burst. SRTO_SNDBUF + SRTO_MAXBW pace it against the drain.
static void* publisher_thread(void* arg)
{
    srtw_publisher* p = (srtw_publisher*)arg;

    const struct sockaddr_in label = listener_label();
    if (srt_connect(p->sock, (const struct sockaddr*)&label, (int)sizeof label) == SRT_ERROR)
    {
        return NULL; // the JS loop notices the shortfall and fails the test
    }

    uint32_t words[TST_PAYLOAD_SIZE / 4];
    for (int i = 0; i < TST_NUM_MESSAGES; ++i)
    {
        fill_message(i, words);
        if (srt_sendmsg(p->sock, (const char*)words, TST_PAYLOAD_SIZE, SRT_MSGTTL_INF, 0) != TST_PAYLOAD_SIZE)
        {
            break; // the JS loop notices the shortfall and fails the test
        }
    }
    return NULL;
}

static int set_opt_int(SRTSOCKET u, SRT_SOCKOPT opt, int value)
{
    return srt_setsockopt(u, 0, opt, &value, sizeof value) != SRT_ERROR;
}

static int set_opt_i64(SRTSOCKET u, SRT_SOCKOPT opt, int64_t value)
{
    return srt_setsockopt(u, 0, opt, &value, sizeof value) != SRT_ERROR;
}

// Test-only (js/test_contract.mjs). 0 ok, -1 failure/already started.
int srtw_test_publisher_start(void* h)
{
    if (h == NULL || ((srtw_engine*)h)->magic != SRTW_ENGINE_MAGIC || ((srtw_engine*)h)->pub != NULL)
    {
        return -1;
    }
    srtw_engine*    e = (srtw_engine*)h;
    srtw_publisher* p = (srtw_publisher*)malloc(sizeof *p);
    if (p == NULL)
    {
        return -1;
    }
    p->engine         = e;
    p->sock           = SRT_INVALID_SOCK;
    p->vt             = NULL;
    p->thread_started = 0;
    ring_init(&p->out);

    p->sock = srt_create_socket();
    int ok  = p->sock != SRT_INVALID_SOCK;
    ok      = ok && set_opt_int(p->sock, SRTO_SKIP_INDUCTION, 1);
    ok      = ok && set_opt_int(p->sock, SRTO_PAYLOADSIZE, TST_PAYLOAD_SIZE);
    ok      = ok && set_opt_int(p->sock, SRTO_LATENCY, TST_LATENCY_MS);
    ok      = ok && set_opt_int(p->sock, SRTO_SNDTIMEO, TST_TIMEOUT_MS);
    ok      = ok && set_opt_i64(p->sock, SRTO_MAXBW, TST_MAX_BW);
    ok      = ok && set_opt_int(p->sock, SRTO_SNDBUF, TST_SNDBUF_BYTES);
    if (ok)
    {
        p->vt = srt_attach_virtual_transport(p->sock, publisher_send, p);
        ok    = p->vt != NULL;
    }
    if (!ok)
    {
        if (p->sock != SRT_INVALID_SOCK)
        {
            srt_close(p->sock);
        }
        ring_destroy(&p->out);
        free(p);
        return -1;
    }

    if (pthread_create(&p->thread, NULL, publisher_thread, p) != 0)
    {
        srt_close(p->sock);
        srt_virtual_transport_release(p->vt);
        ring_destroy(&p->out);
        free(p);
        return -1;
    }
    p->thread_started = 1;
    e->pub            = p;
    return 0;
}

// Test-only. Feed one receiver-originated datagram (a JS kind-0 action)
// back into the publisher's seam, claiming the listener label as source.
int srtw_test_publisher_inject(void* h, const uint8_t* data, int len)
{
    if (h == NULL || ((srtw_engine*)h)->pub == NULL || data == NULL || len <= 0)
    {
        return -1;
    }
    srtw_publisher*          p     = ((srtw_engine*)h)->pub;
    const struct sockaddr_in label = listener_label();
    return srt_virtual_transport_inject(p->vt,
                                        (const char*)data,
                                        len,
                                        (const struct sockaddr*)&label,
                                        (int)sizeof label) == 0
               ? 0
               : -1;
}

// Test-only. Drain ONE publisher outgoing datagram: its length, 0 when
// empty, -1 bad args.
int srtw_test_publisher_poll(void* h, uint8_t* buf, int cap)
{
    if (h == NULL || ((srtw_engine*)h)->pub == NULL)
    {
        return -1;
    }
    return ring_pop(&((srtw_engine*)h)->pub->out, buf, cap);
}

#ifdef __cplusplus
}
#endif
