// External commands: everything the player does to the farm. Commands are
// applied at a tick (day) boundary and recorded in a ReplayLog, so
// (seed, config, command log) reproduces a run exactly — the same contract
// as the reference sim's spawn command.

import type { SimCommand } from "@sim/runtime";

export const FARM_SCHEDULE_OP = "farm.op.schedule";
export const FARM_CANCEL_OP = "farm.op.cancel";
export const FARM_SELL = "farm.sell";
export const FARM_BORROW = "farm.borrow";
export const FARM_REPAY = "farm.repay";
export const FARM_CREATE_FIELD = "farm.field.create";
export const FARM_REMOVE_FIELD = "farm.field.remove";
export const FARM_BUY_PARCEL = "farm.parcel.buy";
export const FARM_BUY_EQUIPMENT = "farm.equip.buy";
export const FARM_SET_WORKERS = "farm.labor.set";

export interface ScheduleOpCommand extends SimCommand {
  readonly kind: typeof FARM_SCHEDULE_OP;
  /** Operation kind code (OP_PLANT..OP_HARVEST). */
  readonly op: number;
  readonly field: number;
  /** Crop code; required for plant, ignored elsewhere. */
  readonly crop: number;
}

export interface CancelOpCommand extends SimCommand {
  readonly kind: typeof FARM_CANCEL_OP;
  /** The op's creation sequence number (stable across slot reuse). */
  readonly opSeq: number;
}

export interface SellCommand extends SimCommand {
  readonly kind: typeof FARM_SELL;
  readonly crop: number;
  /** Units to sell from storage; capped at what is stored. */
  readonly units: number;
}

export interface BorrowCommand extends SimCommand {
  readonly kind: typeof FARM_BORROW;
  readonly amount: number;
}

export interface RepayCommand extends SimCommand {
  readonly kind: typeof FARM_REPAY;
  readonly amount: number;
}

export interface CreateFieldCommand extends SimCommand {
  readonly kind: typeof FARM_CREATE_FIELD;
  /** The field's rectangle, in world cells; must sit on owned ground. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RemoveFieldCommand extends SimCommand {
  readonly kind: typeof FARM_REMOVE_FIELD;
  /** Field slot id; the field must be empty (no crop, no queued work). */
  readonly field: number;
}

export interface BuyParcelCommand extends SimCommand {
  readonly kind: typeof FARM_BUY_PARCEL;
  readonly parcel: number;
}

export interface BuyEquipmentCommand extends SimCommand {
  readonly kind: typeof FARM_BUY_EQUIPMENT;
  /** Equipment category (EQUIP_PLANTER..EQUIP_IRRIGATOR). */
  readonly category: number;
}

export interface SetWorkersCommand extends SimCommand {
  readonly kind: typeof FARM_SET_WORKERS;
  readonly workers: number;
}

export type FarmCommand =
  | ScheduleOpCommand
  | CancelOpCommand
  | SellCommand
  | BorrowCommand
  | RepayCommand
  | CreateFieldCommand
  | RemoveFieldCommand
  | BuyParcelCommand
  | BuyEquipmentCommand
  | SetWorkersCommand;

export const FARM_COMMAND_KINDS: readonly string[] = Object.freeze([
  FARM_SCHEDULE_OP, FARM_CANCEL_OP, FARM_SELL, FARM_BORROW, FARM_REPAY,
  FARM_CREATE_FIELD, FARM_REMOVE_FIELD, FARM_BUY_PARCEL,
  FARM_BUY_EQUIPMENT, FARM_SET_WORKERS,
]);

export function isFarmCommand(cmd: SimCommand): cmd is FarmCommand {
  return FARM_COMMAND_KINDS.includes(cmd.kind);
}
