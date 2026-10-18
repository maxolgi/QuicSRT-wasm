// baseline.js - shared golden-baseline helpers for the two parity gates
// (js/demux_parity.mjs, js/muxer_parity.mjs).
//
// A baseline file is { provenance, cases } JSON with a stable shape:
//   provenance  "recorded from <source> at commit <sha>, byte-parity vs
//               the Rust oracle verified at that commit" - the trust
//               anchor: the digests were captured from a build proven
//               byte-identical to the oracle, so they CARRY that parity
//               forward without loading anything outside this repo
//   cases       case id -> per-case digests + counts (each harness
//               defines the entry shape), insertion order = run order
//
// --record rewrites the file; recording against an existing baseline
// first reports the drift (added/changed/removed cases, changed field
// names) so a baseline change can never slip through review silently.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The commit a --record runs at. Informational only: the gate mode never
// needs git, and an unrecordable sha degrades to 'unknown'.
export function currentCommit() {
    try {
        return execSync('git rev-parse HEAD', { cwd: join(HERE, '..'), encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
}

export function baselineProvenance(sourceName, commit) {
    return `recorded from ${sourceName} at commit ${commit}, byte-parity vs the Rust oracle verified at that commit`;
}

// null when the file does not exist (first record); throws on malformed
// JSON (a corrupted baseline must fail loudly, never silently re-record).
export function loadBaseline(file) {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeBaseline(file, prov, cases) {
    writeFileSync(file, `${JSON.stringify({ provenance: prov, cases }, null, 2)}\n`);
}

// Drift between two case maps: added/removed ids plus, per surviving
// case, the field names that differ (arrays count as one field compared
// by elements - per-drain digests are not itemized).
export function baselineDiff(oldCases, newCases) {
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const added = [], removed = [], changed = [];
    for (const id of Object.keys(newCases)) {
        if (!has(oldCases, id)) { added.push(id); continue; }
        const fields = [];
        for (const [f, v] of Object.entries(newCases[id])) {
            if (!has(oldCases[id], f) || JSON.stringify(oldCases[id][f]) !== JSON.stringify(v)) fields.push(f);
        }
        for (const f of Object.keys(oldCases[id])) {
            if (!has(newCases[id], f)) fields.push(f);
        }
        if (fields.length > 0) changed.push([id, fields]);
    }
    for (const id of Object.keys(oldCases)) {
        if (!has(newCases, id)) removed.push(id);
    }
    return { added, removed, changed };
}

export function reportBaselineDrift(file, oldBaseline, newCases) {
    if (oldBaseline === null) {
        console.log(`baseline: ${file} did not exist - initial record (${Object.keys(newCases).length} cases)`);
        return;
    }
    const d = baselineDiff(oldBaseline.cases ?? {}, newCases);
    console.log(
        `baseline drift vs ${file}: ${Object.keys(oldBaseline.cases ?? {}).length} -> ${Object.keys(newCases).length} cases ` +
        `(${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed)`,
    );
    for (const id of d.added) console.log(`  + ${id}`);
    for (const [id, fields] of d.changed) console.log(`  ~ ${id} (${fields.join(', ')})`);
    for (const id of d.removed) console.log(`  - ${id}`);
}
