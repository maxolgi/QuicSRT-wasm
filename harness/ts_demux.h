// The M5 demux C ABI: the mpeg2ts-wasm oracle surface (WebSRT
// crates/mpeg2ts-wasm/src/lib.rs - the fork's TS stack underneath, cargo
// checkout mpeg2ts 9a1efaf) ported to C++ behind extern "C", exported from
// the same emcc module as the receiver (build/srt_engine.mjs). The JS
// wrapper (js/demux_engine.js) mirrors the wasm-bindgen naming exactly -
// property getters for kind/pid/pts/dts/stream_type/data/text/program_num/
// randomAccess/nalOffsets/nalTypes/samples and every snapshot field,
// pmtEntries()/pmtFormatIds() as METHODS, meter_snapshot snake_case - so
// page/vendor/demux.ts is a one-line import swap (plan-notes/abi-census.md
// is the port contract).
//
//   tsd_new / tsd_free                  demuxer lifecycle
//   tsd_feed                            append TS bytes, parse 188-B
//                                       packets, stage the events of this
//                                       call (tsd_event_take hands each to
//                                       JS; tsd_event_free releases it -
//                                       wasm-bindgen object semantics)
//   tsd_ev_*                            TsEvent field accessors; data/
//                                       nal/samples buffers are owned by
//                                       the event, valid until freed
//   tsd_debug_snapshot / tsd_snap_field struct-of-arrays snapshot
//                                       (census 1.3) - one call per field
//                                       id fills a TsdFieldView
//   tsd_meter_snapshot / tsd_meter_field  meter snapshot (census 1.4)
//   tsd_set_meter_selection             meter source selection
//
// Staged state (M5 steps 2-3 land these; the parity harness excludes
// exactly these fields until then): NAL scanning is not ported, so pes
// events carry empty nal tables and the snapshot's nalPids/nalStats/
// ringNal/ringNalOffsets are empty; SMPTE 302M decode (aes3) is not ported,
// so no pcm events are emitted - only the meter pid/channel registry rides
// along; the meter DSP itself (meter.rs) returns the documented empty
// shapes.

#ifndef SRTW_TS_DEMUX_H
#define SRTW_TS_DEMUX_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TsDemuxer TsDemuxer;
typedef struct TsEvent TsEvent;
typedef struct TsdSnapshot TsdSnapshot;
typedef struct TsdMeterSnap TsdMeterSnap;

// TsdFieldView element kinds. STRS = array of NUL-terminated char* (the
// string data stays owned by the snapshot object).
enum
{
    TSD_I32 = 0,
    TSD_U8,
    TSD_U16,
    TSD_U32,
    TSD_F32,
    TSD_F64,
    TSD_STRS,
};

// One snapshot field as a flat element array (or a single I32 scalar for
// programNum/pmtPid/selectedPid/selectedChannel). data == NULL with
// count == 0 for empty arrays.
typedef struct TsdFieldView
{
    const void* data;
    int count;
    int kind;
} TsdFieldView;

// DebugSnapshot field ids - census 1.3 accessor order.
enum
{
    TSD_SNAP_PROGRAM_NUM = 0,
    TSD_SNAP_PMT_PID,
    TSD_SNAP_PMT_PIDS,
    TSD_SNAP_PMT_STREAM_TYPES,
    TSD_SNAP_PMT_FORMAT_IDS,
    TSD_SNAP_PIDS,
    TSD_SNAP_PES_COUNTS,
    TSD_SNAP_BYTE_TOTALS,
    TSD_SNAP_BITRATES_MBPS,
    TSD_SNAP_RA_COUNTS,
    TSD_SNAP_LAST_PTS,
    TSD_SNAP_LAST_DTS,
    TSD_SNAP_PTS_JUMPS,
    TSD_SNAP_CC_ERRORS,
    TSD_SNAP_TEI_COUNTS,
    TSD_SNAP_PUSI_COUNTS,
    TSD_SNAP_SCRAMBLING_COUNTS,
    TSD_SNAP_AF_CONTROL_COUNTS,
    TSD_SNAP_PCR_PIDS,
    TSD_SNAP_PCR_INTERVALS_MS,
    TSD_SNAP_PCR_JITTER_MS,
    TSD_SNAP_NAL_PIDS,
    TSD_SNAP_NAL_STATS,
    TSD_SNAP_ERROR_T,
    TSD_SNAP_ERROR_MSG,
    TSD_SNAP_RING_T,
    TSD_SNAP_RING_PID,
    TSD_SNAP_RING_KIND,
    TSD_SNAP_RING_PTS,
    TSD_SNAP_RING_DTS,
    TSD_SNAP_RING_SIZE,
    TSD_SNAP_RING_RA,
    TSD_SNAP_RING_TEI,
    TSD_SNAP_RING_PUSI,
    TSD_SNAP_RING_NAL,
    TSD_SNAP_RING_NAL_OFFSETS,
    TSD_SNAP_RING_HEX,
};

// MeterSnapshotView field ids - census 1.4 accessor order.
enum
{
    TSD_METER_PIDS = 0,
    TSD_METER_CHANNEL_COUNTS,
    TSD_METER_PEAKS,
    TSD_METER_RMS,
    TSD_METER_CLIPS,
    TSD_METER_LUFS,
    TSD_METER_PHASE,
    TSD_METER_SCOPE_L,
    TSD_METER_SCOPE_R,
    TSD_METER_SPECTRUM,
    TSD_METER_SELECTED_PID,
    TSD_METER_SELECTED_CHANNEL,
};

// Demuxer lifecycle. The handle is single-threaded (JS thread), like the
// wasm-bindgen original.
TsDemuxer* tsd_new(void);
void tsd_free(TsDemuxer* d);

// Append raw TS bytes (any length; leftovers <188 B stay buffered across
// calls). Returns the event count for this call; the events stay staged
// until taken (or the next feed/discards them).
int tsd_feed(TsDemuxer* d, const uint8_t* bytes, int len);

// Take ownership of staged event i (NULL when out of range or already
// taken). Release with tsd_event_free - wasm-bindgen event semantics.
TsEvent* tsd_event_take(TsDemuxer* d, int i);
void tsd_event_free(TsEvent* e);

// TsEvent accessors (census 1.2). pts/dts are f64 carrying 33-bit ints or
// -1.0, exactly like the wasm-bindgen getters.
uint8_t tsd_ev_kind(const TsEvent* e);
uint16_t tsd_ev_pid(const TsEvent* e);
double tsd_ev_pts(const TsEvent* e);
double tsd_ev_dts(const TsEvent* e);
uint8_t tsd_ev_stream_type(const TsEvent* e);
uint16_t tsd_ev_program_num(const TsEvent* e);
int tsd_ev_random_access(const TsEvent* e);
int tsd_ev_data_len(const TsEvent* e);
const uint8_t* tsd_ev_data(const TsEvent* e);
const char* tsd_ev_text(const TsEvent* e); // NUL-terminated
// PMT entries: flat [pid0, st0, pid1, st1, ...], re-derived from data
// (little-endian u16 pairs) on every call, like the pmtEntries() method.
int tsd_ev_pmt_entry_count(const TsEvent* e);
uint16_t tsd_ev_pmt_entry(const TsEvent* e, int j);
// Per-entry registration-descriptor format ids ("" when absent).
int tsd_ev_format_id_count(const TsEvent* e);
const char* tsd_ev_format_id(const TsEvent* e, int j); // NUL-terminated
// NAL tables: empty until the nal port (staged).
int tsd_ev_nal_offset_count(const TsEvent* e);
const uint32_t* tsd_ev_nal_offsets(const TsEvent* e);
int tsd_ev_nal_type_count(const TsEvent* e);
const uint8_t* tsd_ev_nal_types(const TsEvent* e);
// kind-5 samples: empty until the aes3 port (staged).
int tsd_ev_sample_count(const TsEvent* e);
const float* tsd_ev_samples(const TsEvent* e);

// Struct-of-arrays analysis snapshot; free with tsd_snapshot_free. The
// per-PID tables are sorted ascending by PID for cross-call stability.
TsdSnapshot* tsd_debug_snapshot(const TsDemuxer* d);
void tsd_snapshot_free(TsdSnapshot* s);
// Fill one field view; 0 ok, -1 unknown field id.
int tsd_snap_field(const TsdSnapshot* s, int field, TsdFieldView* out);

// Meter snapshot (empty DSP shapes until the meter port; the pid/channel
// registry and the selection are live). Free with tsd_meter_free.
TsdMeterSnap* tsd_meter_snapshot(TsDemuxer* d);
void tsd_meter_free(TsdMeterSnap* m);
int tsd_meter_field(const TsdMeterSnap* m, int field, TsdFieldView* out);

// Select the meter source PID + channel; pid=0 or a gone PID re-locks to
// the next 302M PID on update (meter.rs:404-406).
void tsd_set_meter_selection(TsDemuxer* d, uint16_t pid, uint8_t channel);

#ifdef __cplusplus
}
#endif

#endif // SRTW_TS_DEMUX_H
