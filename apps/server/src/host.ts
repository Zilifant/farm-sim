// Owns the running simulation: a farm sim driven continuously by a
// FixedStepClock (one tick = one simulated day). Deliberately independent of
// HTTP — the Express app and the WebSocket layer hold a reference to a
// SimHost, never the other way around, so closing the server leaves the
// simulation ticking. Uses only the public @sim/runtime and @sim/farm APIs.

import { FixedStepClock, decodeSnapshot, encodeSnapshot } from "@sim/runtime";
import {
  FARMSTEAD_RECT, FARM_COMMAND_KINDS, NO_PARCEL, ROAD_RECT,
  DRIVEWAY_RECT, WORLD_HEIGHT, WORLD_WIDTH,
  buildCellCodes, buildFieldIdMap, buildParcelIdMap, createFarmSim,
  rectContains, soilQualityAt,
  type CalendarDate, type DailyWeather, type FarmCommand, type FarmConfig,
  type FarmEvent, type FarmSim, type FieldView, type ForecastDay,
  type ParcelView,
} from "@sim/farm";
import { seedToU32 } from "@sim/runtime";

export interface SimHostOptions extends Partial<FarmConfig> {
  /** Sim-time per tick; wall pace = fixedDtMs / speed. Default 1 day/second. */
  readonly fixedDtMs?: number;
}

export interface SimStatus {
  readonly tick: string;
  readonly running: boolean;
  readonly speed: number;
  readonly date: string;
  readonly season: string;
  readonly cash: number;
  readonly debt: number;
  readonly netWorth: number;
  readonly stateHash: string;
}

/** One farm event, sequenced for the renderer's event feed. */
export interface FarmEventRecord {
  readonly seq: number;
  readonly kind: string;
  readonly tick: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

const EVENT_RING_LIMIT = 512;

export class SimHost {
  readonly clock: FixedStepClock;
  #sim: FarmSim;
  #config: Partial<FarmConfig>;
  #restarts = 0;
  #eventRing: FarmEventRecord[] = [];
  #nextSeq = 1;
  readonly #parcelIds: Uint8Array = buildParcelIdMap();

  private constructor(sim: FarmSim, config: Partial<FarmConfig>, fixedDtMs: number) {
    this.#sim = sim;
    this.#config = config;
    this.clock = new FixedStepClock({
      fixedDtMs,
      onTick: () => {
        this.#sim.step();
        this.#drainEvents();
      },
    });
  }

  static async create(opts: SimHostOptions = {}): Promise<SimHost> {
    const { fixedDtMs = 1000, ...cfg } = opts;
    return new SimHost(await createFarmSim(cfg), cfg, fixedDtMs);
  }

  #drainEvents(): void {
    this.#sim.events.drain((e: FarmEvent) => {
      this.#eventRing.push({
        seq: this.#nextSeq,
        kind: e.kind,
        tick: Number(e.tick),
        message: e.message,
        ...(e.data !== undefined ? { data: e.data } : {}),
      });
      this.#nextSeq += 1;
      if (this.#eventRing.length > EVENT_RING_LIMIT) {
        this.#eventRing.splice(0, this.#eventRing.length - EVENT_RING_LIMIT);
      }
    });
  }

  get sim(): FarmSim {
    return this.#sim;
  }

  /** Changes on every restart — a renderer must drop state it holds about the
   * old world when this moves. */
  get simulationId(): string {
    return `farm-${String(this.#sim.config.seed)}-${this.#restarts}`;
  }

  get seed(): number | string {
    return this.#sim.config.seed;
  }

  /** Farm events at or after `sinceSeq`, oldest first. */
  eventsSince(sinceSeq: number): FarmEventRecord[] {
    return this.#eventRing.filter((e) => e.seq >= sinceSeq);
  }

  status(): SimStatus {
    const date = this.#sim.date();
    const finance = this.#sim.finance();
    return {
      tick: this.#sim.tick.toString(),
      running: this.clock.running,
      speed: this.clock.speed,
      date: date.label,
      season: date.season,
      cash: finance.cash,
      debt: finance.debt,
      netWorth: finance.netWorth,
      stateHash: `0x${this.#sim.stateHash().toString(16).padStart(8, "0")}`,
    };
  }

  start(): void {
    this.clock.start();
  }

  pause(): void {
    this.clock.pause();
  }

  stepOnce(): Promise<void> {
    return this.clock.stepOnce();
  }

  /** Advance N days immediately; requires a paused clock. */
  async stepTicks(ticks: number): Promise<void> {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10_000) {
      throw new Error("ticks must be a whole number in [1, 10000]");
    }
    for (let i = 0; i < ticks; i += 1) {
      await this.clock.stepOnce();
    }
  }

  setSpeed(speed: number): void {
    this.clock.speed = speed;
  }

  /** Apply a player command (validated by the sim; throws on invalid). */
  command(cmd: { readonly kind?: unknown } & Record<string, unknown>): void {
    if (typeof cmd?.kind !== "string" || !FARM_COMMAND_KINDS.includes(cmd.kind)) {
      throw new Error(`command kind must be one of: ${FARM_COMMAND_KINDS.join(", ")}`);
    }
    this.#sim.apply(cmd as unknown as FarmCommand);
  }

  /**
   * Rebuild the farm from a seed (host-picked when omitted), keeping the
   * config. The clock keeps its run state and speed; the event feed restarts
   * with the new simulationId.
   */
  async restart(seed?: number): Promise<void> {
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new Error("seed must be a whole number in [0, 4294967295]");
    }
    const nextSeed = seed ?? Math.floor(Math.random() * 0x100000000);
    const wasRunning = this.clock.running;
    this.clock.pause();
    this.#sim = await createFarmSim({ ...this.#config, seed: nextSeed });
    this.#restarts += 1;
    this.#eventRing = [];
    this.#nextSeq = 1;
    if (wasRunning) {
      this.clock.start();
    }
  }

  /** What one map cell holds — the renderer's inspection query. */
  cellInspect(x: number, y: number): {
    x: number; y: number; kind: string;
    field: FieldView | null; parcel: ParcelView | null; soilQuality: number;
  } {
    if (!Number.isInteger(x) || x < 0 || x >= WORLD_WIDTH || !Number.isInteger(y) || y < 0 || y >= WORLD_HEIGHT) {
      throw new Error(`cell must be within the ${WORLD_WIDTH}x${WORLD_HEIGHT} map`);
    }
    const soilQuality = soilQualityAt(seedToU32(String(this.#sim.config.seed)), x, y);
    const field = this.#sim.fields().find((f) => rectContains(f, x, y)) ?? null;
    const parcelId = this.#parcelIds[y * WORLD_WIDTH + x]!;
    const parcel = parcelId === NO_PARCEL ? null : this.#sim.parcels()[parcelId]!;
    const kind =
      field !== null ? "field"
      : rectContains(FARMSTEAD_RECT, x, y) ? "farmstead"
      : rectContains(DRIVEWAY_RECT, x, y) ? "driveway"
      : rectContains(ROAD_RECT, x, y) ? "road"
      : "grass";
    return { x, y, kind, field, parcel, soilQuality };
  }

  /** The map as appearance codes, base64 — the renderer's per-frame payload. */
  cellsBase64(): string {
    const parcelOwned = new Uint8Array(this.#sim.parcels().length);
    for (const p of this.#sim.parcels()) {
      parcelOwned[p.id] = p.owned ? 1 : 0;
    }
    const cells = buildCellCodes(
      parcelOwned,
      this.#sim.fields().map((f) => ({ rect: f, crop: f.cropCode, stage: f.stageCode })),
    );
    return Buffer.from(cells).toString("base64");
  }

  /** Per-frame field-id map (255 = no field) — fields move as the player
   * creates and removes them. */
  fieldIdsBase64(): string {
    const map = buildFieldIdMap(this.#sim.fields().map((f) => ({ id: f.id, rect: f })));
    return Buffer.from(map).toString("base64");
  }

  /** Static parcel-id map (255 = the road), base64. */
  parcelIdsBase64(): string {
    return Buffer.from(this.#parcelIds).toString("base64");
  }

  date(): CalendarDate {
    return this.#sim.date();
  }

  weather(): DailyWeather {
    return this.#sim.weather();
  }

  forecast(days = 5): ForecastDay[] {
    return this.#sim.forecast(days);
  }

  snapshotBytes(): Uint8Array {
    return encodeSnapshot(this.#sim.captureSnapshot());
  }

  restoreBytes(bytes: Uint8Array): void {
    this.#sim.restoreSnapshot(decodeSnapshot(bytes));
  }

  /** Stop driving the sim (used on process shutdown, not server close). */
  dispose(): void {
    this.clock.pause();
  }
}

