import { errors } from './errors.js';
import type { TaskStatus } from './schemas.js';

/**
 * Task lifecycle: queued → working ⇄ needs_input → delivered.
 * `delivered` reopens to `working` when a delivery is rejected before the deadline.
 * expired / cancelled / failed are terminal.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['working', 'needs_input', 'delivered', 'cancelled', 'expired', 'failed'],
  working: ['needs_input', 'delivered', 'cancelled', 'expired', 'failed'],
  needs_input: ['working', 'delivered', 'cancelled', 'expired', 'failed'],
  delivered: ['working', 'expired'],
  expired: [],
  cancelled: [],
  failed: [],
};

export const TERMINAL: readonly TaskStatus[] = ['expired', 'cancelled', 'failed'];
/** Statuses in which the server is still expected to deliver. */
export const OPEN: readonly TaskStatus[] = ['queued', 'working', 'needs_input'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

export function isOpen(status: TaskStatus): boolean {
  return OPEN.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw errors.invalidState(`Task cannot move from ${from} to ${to}`, { from, to });
  }
}
