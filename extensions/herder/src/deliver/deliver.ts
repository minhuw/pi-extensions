import type { DeliveryMode } from "../types.ts";

export interface DeliveryRequest { mode: DeliveryMode; curate?: boolean }

export async function deliver(deps: unknown, request: DeliveryRequest): Promise<unknown> { throw new Error("not implemented"); }
