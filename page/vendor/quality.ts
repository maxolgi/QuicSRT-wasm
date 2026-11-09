// QualityLevelList for the player SDK's rendition ladder — modeled on the
// video.js quality-levels contract (videojs-contrib-quality-levels): an
// EventTarget list of levels with per-level `selected`, a get/set
// `selectedIndex` (-1 = automatic selection) and 'change' /
// 'addqualitylevel' / 'removequalitylevel' events. The list is derived
// state: the owning player rebuilds it from its rung configuration and
// pushes selection updates; hosts read levels and switch by assigning
// `selectedIndex`. Unlike video.js there is no addQualityLevel() /
// removeQualityLevel() — the ladder comes from stream-name suffixes
// (player.setRungs()), not from representation metadata.

export interface QualityLevel {
  /** Rung id: '' = the base (source) stream, otherwise the suffix ('540p'). */
  readonly id: string;
  /** Display label: 'source' for '', otherwise the suffix itself. */
  readonly label: string;
  /** Vertical resolution parsed from a '<n>p' suffix; undefined otherwise. */
  readonly height?: number;
  /** Not derivable from a name-only ladder — always undefined in v1. */
  readonly bitrate?: number;
  /** True while this rung is the one the player is on. */
  readonly selected: boolean;
}

export interface QualityLevelList extends EventTarget {
  readonly length: number;
  /** -1 = automatic selection (ABR owns the ladder); otherwise the index
   *  of the manually chosen level. Assigning an index switches to that
   *  rung (disabling auto); assigning -1 re-engages auto. Invalid indexes
   *  are ignored. */
  selectedIndex: number;
  /** Levels are also reachable via list[i], iteration and Array.from. */
  [index: number]: QualityLevel | undefined;
  getQualityLevelById(id: string): QualityLevel | null;
  [Symbol.iterator](): IterableIterator<QualityLevel>;
}

/** Selection delegation: the owning player holds the selection state and
 *  applies manual picks; the list only renders it. */
export interface QualityLevelListHost {
  getSelectedIndex(): number;
  setSelectedIndex(index: number): void;
}

/** The list plus its owner-side maintenance surface (never part of the
 *  public shape hosts see). */
export interface QualityLevelListInternal extends QualityLevelList {
  /** Replace the level set (top-down rung ids, '' = source first); fires
   *  'removequalitylevel' for the outgoing levels then 'addqualitylevel'
   *  for the incoming ones. A selection that survives the rebuild is kept
   *  (no 'change'); one that falls off the new ladder is dropped. */
  rebuild(ladder: string[]): void;
  /** Move the selection to a rung id (null = nothing selected); fires
   *  'change' when it moves. */
  select(id: string | null): void;
}

class QualityLevelImpl implements QualityLevel {
  readonly id: string;
  readonly label: string;
  readonly height?: number;
  readonly bitrate?: number;
  selected = false;

  constructor(rung: string) {
    this.id = rung;
    this.label = rung === '' ? 'source' : rung;
    const m = /^(\d+)p$/.exec(rung);
    if (m) this.height = Number(m[1]);
  }
}

class QualityLevelListImpl extends EventTarget implements QualityLevelListInternal {
  [index: number]: QualityLevel | undefined;
  private levels: QualityLevelImpl[] = [];
  private selectedId: string | null = null;

  constructor(private readonly host: QualityLevelListHost) {
    super();
  }

  get length(): number {
    return this.levels.length;
  }

  get selectedIndex(): number {
    return this.host.getSelectedIndex();
  }

  set selectedIndex(index: number) {
    this.host.setSelectedIndex(index);
  }

  getQualityLevelById(id: string): QualityLevel | null {
    return this.levels.find((l) => l.id === id) ?? null;
  }

  [Symbol.iterator](): IterableIterator<QualityLevel> {
    return this.levels[Symbol.iterator]();
  }

  rebuild(ladder: string[]): void {
    const old = this.levels;
    this.levels = ladder.map((rung) => new QualityLevelImpl(rung));
    for (let i = 0; i < this.levels.length; i++) this[i] = this.levels[i];
    for (let i = this.levels.length; i < old.length; i++) delete this[i];
    if (this.selectedId !== null && !this.levels.some((l) => l.id === this.selectedId)) {
      this.selectedId = null;
    }
    for (const level of this.levels) level.selected = level.id === this.selectedId;
    for (const level of old) this.dispatchEvent(new CustomEvent('removequalitylevel', { detail: level }));
    for (const level of this.levels) this.dispatchEvent(new CustomEvent('addqualitylevel', { detail: level }));
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    for (const level of this.levels) level.selected = level.id === id;
    this.dispatchEvent(new CustomEvent('change', { detail: id === null ? null : this.getQualityLevelById(id) }));
  }
}

export function createQualityLevelList(host: QualityLevelListHost): QualityLevelListInternal {
  return new QualityLevelListImpl(host);
}
