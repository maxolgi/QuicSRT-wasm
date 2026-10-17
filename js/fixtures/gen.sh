#!/usr/bin/env bash
set -euo pipefail

# Regenerator for the M5 demux-parity golden fixtures. The ten ffmpeg
# command lines below are VERBATIM from plan-notes/parity-spec.md
# section 1, and the guards/manifest follow its section 3 storage
# contract. Output is deterministic per ffmpeg build; the committed
# manifest.sha256 is authoritative across builds - regeneration exists
# for recovery, not reproduction.
#
# Known deviation (spec table self-contradiction, reported upstream):
# a302m_24_6ch.ts - section 1 lists 1,116,720 B, but that is the 16-bit
# 6ch size (~15 B/audio-frame); the verbatim command carries
# -sample_fmt s32, which is 24-bit (21 B/frame) and measures 1,566,040 B
# on ffmpeg 7.1.5-0+deb13u1 (ffprobe: s302m, 6 channels, s32 - exactly
# what the S7 "exercises" column wants). The +/-25% guard and the
# per-file cap below use the measured values, else every run fails on a
# command that is provably the intended one. The other nine rows match
# the section 1 table (six of them byte-exact).

usage() {
    cat <<'EOF'
Usage: js/fixtures/gen.sh [--force]

Regenerates the ten golden TS fixtures (parity-spec.md section 1) and
rewrites js/fixtures/manifest.sha256 (section 3). Runs ffmpeg with
cwd = repo root.

    --force  overwrite fixtures whose sha256 no longer matches the
             manifest (e.g. after an ffmpeg upgrade)
EOF
}

# section 3 contract: commands run with cwd = repo root (they address
# js/fixtures/<file> relatively).
cd "$(cd "$(dirname "$0")" && pwd)/../.."

NAMES=(
    a302m_16.ts
    a302m_24.ts
    a302m_24_6ch.ts
    a_aac.ts
    av_shortgop.ts
    v_b_v1.ts
    v_cbr_pad.ts
    v_disc.ts
    v_hevc.ts
    v_longgop.ts
)

# section 1 "Measured" column - the +/-25% guard compares against these.
# v_disc/v_b_v1 are the table's "~110 KB (est)" rows (110000 nominal).
expected_size() {
    case "$1" in
        a302m_16.ts) echo 501584 ;;
        a302m_24.ts) echo 712896 ;;
        a302m_24_6ch.ts) echo 1566040 ;; # spec: 1116720 - see header note
        a_aac.ts) echo 40796 ;;
        av_shortgop.ts) echo 253800 ;;
        v_b_v1.ts) echo 110000 ;;
        v_cbr_pad.ts) echo 148896 ;;
        v_disc.ts) echo 110000 ;;
        v_hevc.ts) echo 169012 ;;
        v_longgop.ts) echo 469812 ;;
        *) return 1 ;;
    esac
}

# section 3 per-file cap: 1.2 MB, except the 24-bit 6ch stream (header
# note): 6 ch x 48 kHz x 7-byte chunks x 1.5 s ~= 1.55 MB of TS is the
# physical size of the verbatim command, so its cap is 1.7 MB.
file_cap() {
    case "$1" in
        a302m_24_6ch.ts) echo 1700000 ;;
        *) echo 1200000 ;;
    esac
}

FORCE=0
case "${1:-}" in
    --force) FORCE=1 ;;
    -h | --help | help)
        usage
        exit 0
        ;;
    "") ;;
    *)
        usage >&2
        exit 1
        ;;
esac

MANIFEST=js/fixtures/manifest.sha256

# Contract 2: refuse to overwrite a fixture whose sha256 disagrees with
# the manifest (hand edit, partial regen, different ffmpeg build) unless
# --force. A missing manifest or missing per-file entry pins nothing.
if [ -f "$MANIFEST" ]; then
    for name in "${NAMES[@]}"; do
        f="js/fixtures/$name"
        [ -f "$f" ] || continue
        want="$(awk -v n="$name" '$3 == n {print $1}' "$MANIFEST")"
        [ -n "$want" ] || continue
        if [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$want" ]; then
            if [ "$FORCE" -ne 1 ]; then
                echo "gen.sh: js/fixtures/$name differs from $MANIFEST - refusing to overwrite (--force to regenerate)" >&2
                exit 1
            fi
            echo "gen.sh: --force overwriting $name (manifest mismatch)" >&2
        fi
    done
fi

# Contract 5: build provenance (first line of ffmpeg -version).
ffmpeg -version 2>&1 | sed -n 1p

mkdir -p js/fixtures

# S1
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 6 -flags +bitexact -fflags +bitexact -c:v libx264 -preset veryfast -profile:v main \
  -bf 3 -g 25 -keyint_min 25 -sc_threshold 0 -b:v 180k -c:a aac -b:a 64k -ac 2 \
  -f mpegts js/fixtures/av_shortgop.ts
# S2
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 12 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 250 -keyint_min 250 -sc_threshold 0 -b:v 250k \
  -f mpegts js/fixtures/v_longgop.ts
# S3
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 6 -flags +bitexact -fflags +bitexact \
  -c:v libx265 -preset ultrafast -x265-params keyint=50:min-keyint=50:scenecut=0:log-level=error \
  -b:v 150k -f mpegts js/fixtures/v_hevc.ts
# S4
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 4 -flags +bitexact -fflags +bitexact \
  -c:a aac -b:a 64k -ac 2 -f mpegts js/fixtures/a_aac.ts
# S5 (16-bit; -sample_fmt is REQUIRED — default negotiation also lands s16, be explicit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 2 -flags +bitexact -fflags +bitexact \
  -ac 2 -strict -2 -c:a s302m -sample_fmt s16 -f mpegts js/fixtures/a302m_16.ts
# S6 (24-bit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 2 -flags +bitexact -fflags +bitexact \
  -ac 2 -strict -2 -c:a s302m -sample_fmt s32 -f mpegts js/fixtures/a302m_24.ts
# S7 (6-channel 24-bit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 1.5 -flags +bitexact -fflags +bitexact \
  -af aformat=channel_layouts=5.1 -ac 6 -strict -2 -c:a s302m -sample_fmt s32 \
  -f mpegts js/fixtures/a302m_24_6ch.ts
# S8 (CBR: null stuffing + AF-stuffed PCR-only packets)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 50 -b:v 120k -muxrate 400k -f mpegts js/fixtures/v_cbr_pad.ts
# S9 (natural discontinuity indicator)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 25 -b:v 150k -mpegts_flags initial_discontinuity \
  -f mpegts js/fixtures/v_disc.ts
# S10 (program B: version 1, remapped PIDs — concat partner for C8)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 25 -b:v 150k -tables_version 1 \
  -mpegts_start_pid 512 -mpegts_pmt_start_pid 4104 -f mpegts js/fixtures/v_b_v1.ts

# Contract 4: per-file +/-25% size guard against the section 1 table
# (catches ffmpeg option drift). Integer-safe: size*4 vs exp*3 / exp*5.
total=0
for name in "${NAMES[@]}"; do
    f="js/fixtures/$name"
    size="$(stat -c %s "$f")"
    exp="$(expected_size "$name")"
    if ((size * 4 < exp * 3 || size * 4 > exp * 5)); then
        echo "gen.sh: $name is $size B, more than +/-25% off the spec table value $exp B (ffmpeg option drift?)" >&2
        exit 1
    fi
    cap="$(file_cap "$name")"
    if ((size > cap)); then
        echo "gen.sh: $name is $size B, over the per-file cap $cap B" >&2
        exit 1
    fi
    total=$((total + size))
done

# Contract 3: rewrite the manifest (one "<sha256>  <size>  <name>" line
# per file, sorted by name), then enforce the 6 MB directory budget.
: > "$MANIFEST"
for name in $(printf '%s\n' "${NAMES[@]}" | LC_ALL=C sort); do
    printf '%s  %s  %s\n' "$(sha256sum "js/fixtures/$name" | cut -d' ' -f1)" \
        "$(stat -c %s "js/fixtures/$name")" "$name" >> "$MANIFEST"
done
dir_total="$(find js/fixtures -maxdepth 1 -type f -printf '%s\n' | awk '{s += $1} END {print s + 0}')"
if ((dir_total > 6000000)); then
    echo "gen.sh: js/fixtures totals $dir_total B, over the 6 MB budget" >&2
    exit 1
fi

echo "gen.sh: wrote $MANIFEST (10 fixtures, $total B of TS, directory $dir_total B)"
