// TEMPORARY M5-step-4 skeleton: the tsd_* C ABI (ts_demux.h) with empty
// state, so the engine-module wiring - build.sh sources/exports, the
// js/demux_engine.js wasm-bindgen mirror, the parity harness C++ loader -
// lands and is verified (./build.sh engine, rust-vs-rust parity green,
// node js/test_contract.mjs) before the port itself replaces this file.
// The full port (fork parse layer + lib.rs state machine) is the next
// commit; until then a --cpp parity run diverges loudly on the first
// event, which is the honest state.

#include "ts_demux.h"

#include <string>
#include <vector>

// The ABI's opaque types: ts_demux.h forward-declares them, defining them
// here with the same names unifies the C declarations with the C++ impl.
struct TsDemuxer
{
};

struct TsEvent
{
};

struct TsdSnapshot
{
    std::vector<std::string> strings; // backing store for STRS fields
};

struct TsdMeterSnap
{
};

extern "C" {

TsDemuxer* tsd_new(void)
{
    return new TsDemuxer;
}

void tsd_free(TsDemuxer* d)
{
    delete d;
}

int tsd_feed(TsDemuxer* d, const uint8_t* bytes, int len)
{
    (void)d;
    (void)bytes;
    (void)len;
    return 0; // skeleton: no parsing yet
}

TsEvent* tsd_event_take(TsDemuxer* d, int i)
{
    (void)d;
    (void)i;
    return nullptr;
}

void tsd_event_free(TsEvent* e)
{
    (void)e;
}

uint8_t tsd_ev_kind(const TsEvent* e) { (void)e; return 0; }
uint16_t tsd_ev_pid(const TsEvent* e) { (void)e; return 0; }
double tsd_ev_pts(const TsEvent* e) { (void)e; return -1.0; }
double tsd_ev_dts(const TsEvent* e) { (void)e; return -1.0; }
uint8_t tsd_ev_stream_type(const TsEvent* e) { (void)e; return 0; }
uint16_t tsd_ev_program_num(const TsEvent* e) { (void)e; return 0; }
int tsd_ev_random_access(const TsEvent* e) { (void)e; return 0; }
int tsd_ev_data_len(const TsEvent* e) { (void)e; return 0; }
const uint8_t* tsd_ev_data(const TsEvent* e) { (void)e; return nullptr; }
const char* tsd_ev_text(const TsEvent* e) { (void)e; return ""; }
int tsd_ev_pmt_entry_count(const TsEvent* e) { (void)e; return 0; }
uint16_t tsd_ev_pmt_entry(const TsEvent* e, int j)
{
    (void)e;
    (void)j;
    return 0;
}
int tsd_ev_format_id_count(const TsEvent* e) { (void)e; return 0; }
const char* tsd_ev_format_id(const TsEvent* e, int j)
{
    (void)e;
    (void)j;
    return "";
}
int tsd_ev_nal_offset_count(const TsEvent* e) { (void)e; return 0; }
const uint32_t* tsd_ev_nal_offsets(const TsEvent* e)
{
    (void)e;
    return nullptr;
}
int tsd_ev_nal_type_count(const TsEvent* e) { (void)e; return 0; }
const uint8_t* tsd_ev_nal_types(const TsEvent* e)
{
    (void)e;
    return nullptr;
}
int tsd_ev_sample_count(const TsEvent* e) { (void)e; return 0; }
const float* tsd_ev_samples(const TsEvent* e)
{
    (void)e;
    return nullptr;
}

TsdSnapshot* tsd_debug_snapshot(const TsDemuxer* d)
{
    (void)d;
    return new TsdSnapshot;
}

void tsd_snapshot_free(TsdSnapshot* s)
{
    delete s;
}

int tsd_snap_field(const TsdSnapshot* s, int field, TsdFieldView* out)
{
    (void)s;
    (void)field;
    out->data = nullptr;
    out->count = 0;
    out->kind = TSD_U8;
    return 0;
}

TsdMeterSnap* tsd_meter_snapshot(TsDemuxer* d)
{
    (void)d;
    return new TsdMeterSnap;
}

void tsd_meter_free(TsdMeterSnap* m)
{
    delete m;
}

int tsd_meter_field(const TsdMeterSnap* m, int field, TsdFieldView* out)
{
    (void)m;
    (void)field;
    out->data = nullptr;
    out->count = 0;
    out->kind = TSD_U8;
    return 0;
}

void tsd_set_meter_selection(TsDemuxer* d, uint16_t pid, uint8_t channel)
{
    (void)d;
    (void)pid;
    (void)channel;
}

} // extern "C"
